"""The worker's job queue: a Postgres table (`jobs`) instead of a separate broker.

None of these functions commit; the caller owns the transaction. Commit right after `claim`
so other workers see the job as taken.

Each claim adds one to `attempts`, so `(id, attempts)` identifies one worker's claim. When a
worker stops heartbeating and another reclaims the job, the first worker's heartbeat,
failure, completion and output publication find the claim gone and raise `ClaimLostError`.
"""

import uuid
from dataclasses import dataclass
from datetime import timedelta

from sqlalchemy import func, select, text, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, aliased
from sqlalchemy.sql.elements import ColumnElement

from swayambhu_core.models import JobRow

# Retry delay after the first, second, ... failed attempt.
RETRY_BACKOFF = (timedelta(seconds=30), timedelta(minutes=2), timedelta(minutes=10))


class ClaimLostError(Exception):
    """This worker's claim on the job ended: another worker reclaimed it, or it finished."""


@dataclass(frozen=True)
class Job:
    id: int
    kind: str
    interview_id: uuid.UUID
    attempts: int  # including the current one
    max_attempts: int


def enqueue(session: Session, kind: str, interview_id: uuid.UUID) -> None:
    """Queue a step for an interview. A no-op if that step is already queued.

    If the step is running, the new job waits for it to finish and then runs again, so a
    change made after the running job read its inputs (an admin's edit) isn't missed.
    """
    session.execute(
        insert(JobRow)
        .values(kind=kind, interview_id=interview_id)
        .on_conflict_do_nothing(
            index_elements=["interview_id", "kind"], index_where=text("state = 'queued'")
        )
    )


def schedule(session: Session, kind: str, interview_id: uuid.UUID, delay: timedelta) -> None:
    """Queue a step to run after `delay`, moving an already-queued one to that time.

    Used to batch bursts of edits: each save pushes the step back, so it runs once, `delay`
    after the last save. A zero delay runs it as soon as a worker is free.
    """
    run_after = func.now() + delay
    session.execute(
        insert(JobRow)
        .values(kind=kind, interview_id=interview_id, run_after=run_after)
        .on_conflict_do_update(
            index_elements=["interview_id", "kind"],
            index_where=text("state = 'queued'"),
            set_={"run_after": run_after},
        )
    )


def _to_job(row: JobRow) -> Job:
    return Job(row.id, row.kind, row.interview_id, row.attempts, row.max_attempts)


def claim(session: Session, lease: timedelta) -> Job | None:
    """Take the next due job, or a running one whose worker stopped heartbeating."""
    stale = (JobRow.state == "running") & (JobRow.heartbeat_at < func.now() - lease)
    running = aliased(JobRow)
    same_step_running = (
        select(running.id)
        .where(
            running.interview_id == JobRow.interview_id,
            running.kind == JobRow.kind,
            running.state == "running",
        )
        .exists()
    )
    next_id = (
        select(JobRow.id)
        .where(
            ((JobRow.state == "queued") & (JobRow.run_after <= func.now()) & ~same_step_running)
            | (stale & (JobRow.attempts < JobRow.max_attempts))
        )
        .order_by(JobRow.run_after, JobRow.id)
        .limit(1)
        .with_for_update(skip_locked=True)
        .scalar_subquery()
    )
    row = session.scalars(
        update(JobRow)
        .where(JobRow.id == next_id)
        .values(state="running", attempts=JobRow.attempts + 1, heartbeat_at=func.now())
        .returning(JobRow)
    ).one_or_none()
    return _to_job(row) if row else None


def reap_stale(session: Session, lease: timedelta) -> list[Job]:
    """Fail running jobs whose worker vanished on their last allowed attempt."""
    rows = session.scalars(
        update(JobRow)
        .where(
            (JobRow.state == "running")
            & (JobRow.heartbeat_at < func.now() - lease)
            & (JobRow.attempts >= JobRow.max_attempts)
        )
        .values(
            state="failed",
            finished_at=func.now(),
            last_error="The worker stopped responding while running this job.",
        )
        .returning(JobRow)
    ).all()
    return [_to_job(row) for row in rows]


def _claimed(job: Job) -> ColumnElement[bool]:
    """The job is still running under this claim."""
    return (JobRow.id == job.id) & (JobRow.state == "running") & (JobRow.attempts == job.attempts)


def _update_claimed(session: Session, job: Job, **values: object) -> None:
    updated = session.scalar(
        update(JobRow).where(_claimed(job)).values(**values).returning(JobRow.id)
    )
    if updated is None:
        raise ClaimLostError(f"job {job.id} attempt {job.attempts} is no longer this worker's")


def hold_claim(session: Session, job: Job) -> None:
    """Check that this worker still holds the job, and lock its row until the transaction
    ends so no other worker can reclaim it before the caller commits. Call it in the
    transaction that publishes the step's output. Raises ClaimLostError otherwise."""
    held = session.scalar(select(JobRow.id).where(_claimed(job)).with_for_update())
    if held is None:
        raise ClaimLostError(f"job {job.id} attempt {job.attempts} is no longer this worker's")


def heartbeat(session: Session, job: Job) -> None:
    """Renew the lease. Raises ClaimLostError if another worker took the job over."""
    _update_claimed(session, job, heartbeat_at=func.now())


def complete(session: Session, job: Job) -> None:
    """Raises ClaimLostError if another worker took the job over; roll back then."""
    _update_claimed(session, job, state="done", finished_at=func.now())


def _queued_again(session: Session, job: Job) -> bool:
    """Whether a newer job for the same step and interview is waiting to run."""
    newer = session.scalar(
        select(JobRow.id).where(
            JobRow.interview_id == job.interview_id,
            JobRow.kind == job.kind,
            JobRow.state == "queued",
            JobRow.id != job.id,
        )
    )
    return newer is not None


def _finish_failed(session: Session, job: Job, error: str) -> None:
    _update_claimed(session, job, state="failed", finished_at=func.now(), last_error=error)


def fail(session: Session, job: Job, error: str, *, retryable: bool) -> bool:
    """Record a failure. Returns True if the step will run again: as a later retry of this
    job, or through a newer job for the same step that is already waiting. Raises ClaimLostError
    if another worker took the job over: that worker records the outcome."""
    if not retryable:
        _finish_failed(session, job, error)
        return False
    if job.attempts < job.max_attempts:
        delay = RETRY_BACKOFF[min(job.attempts, len(RETRY_BACKOFF)) - 1]
        try:
            with session.begin_nested():
                _update_claimed(
                    session,
                    job,
                    state="queued",
                    run_after=func.now() + delay,
                    heartbeat_at=None,
                    last_error=error,
                )
            return True
        except IntegrityError:
            pass  # a newer job is already waiting, and only one may be queued
    _finish_failed(session, job, error)
    return _queued_again(session, job)
