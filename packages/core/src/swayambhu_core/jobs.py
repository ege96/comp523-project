"""The worker's job queue: a Postgres table (`jobs`) instead of a separate broker (Q-18).

None of these functions commit; the caller owns the transaction. Commit right after `claim`
so other workers see the job as taken.
"""

import uuid
from dataclasses import dataclass
from datetime import timedelta

from sqlalchemy import func, select, text, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from swayambhu_core.models import JobRow

# Retry delay after the first, second, ... failed attempt.
RETRY_BACKOFF = (timedelta(seconds=30), timedelta(minutes=2), timedelta(minutes=10))


@dataclass(frozen=True)
class Job:
    id: int
    kind: str
    interview_id: uuid.UUID
    attempts: int  # including the current one
    max_attempts: int


def enqueue(session: Session, kind: str, interview_id: uuid.UUID) -> None:
    """Queue a step for an interview. A no-op if that step is already queued or running."""
    session.execute(
        insert(JobRow)
        .values(kind=kind, interview_id=interview_id)
        .on_conflict_do_nothing(
            index_elements=["interview_id", "kind"],
            index_where=text("state IN ('queued', 'running')"),
        )
    )


def _to_job(row: JobRow) -> Job:
    return Job(row.id, row.kind, row.interview_id, row.attempts, row.max_attempts)


def claim(session: Session, lease: timedelta) -> Job | None:
    """Take the next due job, or a running one whose worker stopped heartbeating."""
    stale = (JobRow.state == "running") & (JobRow.heartbeat_at < func.now() - lease)
    next_id = (
        select(JobRow.id)
        .where(
            ((JobRow.state == "queued") & (JobRow.run_after <= func.now()))
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


def heartbeat(session: Session, job: Job) -> None:
    session.execute(update(JobRow).where(JobRow.id == job.id).values(heartbeat_at=func.now()))


def complete(session: Session, job: Job) -> None:
    session.execute(
        update(JobRow).where(JobRow.id == job.id).values(state="done", finished_at=func.now())
    )


def fail(session: Session, job: Job, error: str, *, retryable: bool) -> bool:
    """Record a failure. Returns True if the job was queued again for a later retry."""
    if retryable and job.attempts < job.max_attempts:
        delay = RETRY_BACKOFF[min(job.attempts, len(RETRY_BACKOFF)) - 1]
        values: dict[str, object] = {
            "state": "queued",
            "run_after": func.now() + delay,
            "heartbeat_at": None,
            "last_error": error,
        }
    else:
        values = {"state": "failed", "finished_at": func.now(), "last_error": error}
    session.execute(update(JobRow).where(JobRow.id == job.id).values(**values))
    return values["state"] == "queued"
