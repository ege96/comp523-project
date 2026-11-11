"""When a new machine transcript may replace an interview's lines.

Transcribing replaces every line, so the API refuses edits while a transcription is waiting
or running, and the worker replaces lines only when no admin correction would be lost
without consent. Both take the interview row lock first (`lock_interview`), so an edit and
the decision to replace the lines are made one after the other.
"""

import uuid
from datetime import datetime

from sqlalchemy import exists, func, select
from sqlalchemy.orm import Session

from swayambhu_core.models import InterviewRow, JobRow, SegmentRow

# The job kinds that replace every line of a transcript.
TRANSCRIBE_KINDS = ("transcribe", "retranscribe")


def lock_interview(session: Session, interview_id: uuid.UUID) -> None:
    """Lock the interview row until the transaction ends. Doesn't block foreign keys."""
    session.execute(
        select(InterviewRow.id)
        .where(InterviewRow.id == interview_id)
        .with_for_update(key_share=True)
    )


def transcription_waiting(session: Session, interview_id: uuid.UUID) -> bool:
    """Whether a job that replaces every line is queued or running for the interview."""
    return bool(
        session.scalar(
            select(
                exists().where(
                    JobRow.interview_id == interview_id,
                    JobRow.kind.in_(TRANSCRIBE_KINDS),
                    JobRow.state.in_(("queued", "running")),
                )
            )
        )
    )


def replacement_approved_at(session: Session, interview_id: uuid.UUID) -> datetime | None:
    """When an admin approved replacing corrected lines: the running `retranscribe` job's
    creation. None when no such job is running."""
    return session.scalar(
        select(JobRow.created_at)
        .where(
            JobRow.interview_id == interview_id,
            JobRow.kind == "retranscribe",
            JobRow.state == "running",
        )
        .order_by(JobRow.id.desc())
        .limit(1)
    )


def corrections_blocking_replacement(
    session: Session, interview_id: uuid.UUID, approved_at: datetime | None
) -> int:
    """How many corrected lines a new transcript may not replace: every corrected line, or
    with an approval, the lines corrected after it."""
    query = select(func.count()).where(
        SegmentRow.interview_id == interview_id, SegmentRow.edited_at.is_not(None)
    )
    if approved_at is not None:
        query = query.where(SegmentRow.edited_at > approved_at)
    return session.scalar(query) or 0
