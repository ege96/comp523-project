"""Adding a recording to the archive, shared by the API's upload route and the worker's
ingest command so both queue exactly the same processing."""

import uuid

from sqlalchemy.orm import Session

from swayambhu_core import jobs
from swayambhu_core.models import MediaFileRow

# Every stored file of an interview lives under `interviews/<id>/`, so deleting the interview
# removes that one prefix, and a sweep can tell leftovers by their folder name.
INTERVIEWS_PREFIX = "interviews"


def interview_prefix(interview_id: uuid.UUID) -> str:
    """The storage prefix holding all of one interview's files."""
    return f"{INTERVIEWS_PREFIX}/{interview_id}"


def original_key(interview_id: uuid.UUID, suffix: str) -> str:
    """Where an interview's original recording is stored. `suffix` is like `.mp3`, or empty."""
    return f"{interview_prefix(interview_id)}/original{suffix.lower()}"


def add_original(
    session: Session,
    interview_id: uuid.UUID,
    *,
    key: str,
    content_type: str,
    size_bytes: int,
    sha256: str | None,
) -> None:
    """Record an interview's stored original and queue its processing. Doesn't commit.

    `sha256` may be None when hashing would hold up the request (a resumable upload)."""
    session.add(
        MediaFileRow(
            interview_id=interview_id,
            kind="original",
            storage_key=key,
            content_type=content_type,
            size_bytes=size_bytes,
            sha256=sha256,
        )
    )
    # Behind admins' work and interviews already started, so a batch finishes one by one.
    jobs.enqueue(session, "transcribe", interview_id, jobs.Priority.NEW)
    jobs.enqueue(session, "playback", interview_id, jobs.Priority.NEW)
