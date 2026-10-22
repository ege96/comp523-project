"""Admins correcting transcripts (Proposal: paths and shapes).

An edit goes into `segments.original_edited` / `english_edited`; the machine output stays
untouched beside it, so an edit can always be undone by sending `null`. Saving queues the
worker's `index` step, which re-embeds only the search chunk whose text changed.

Every route takes `CurrentAdmin`: anonymous visitors get a 401 and signed-in non-admins a
403 before anything else runs, whatever the interview's visibility.
"""

import logging
import uuid
from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, ConfigDict, StringConstraints, model_validator
from sqlalchemy import func, select
from sqlalchemy.orm import Session
from swayambhu_core import jobs
from swayambhu_core.models import AdminRow, InterviewRow, JobRow, SegmentRow

from swayambhu_api.auth import CurrentAdmin
from swayambhu_api.db import DbSession

router = APIRouter()
log = logging.getLogger("swayambhu_api")

# Blank text isn't an edit: send null to go back to the machine text.
EditedText = Annotated[
    str, StringConstraints(strip_whitespace=True, min_length=1, max_length=10_000)
]


class SegmentEdit(BaseModel):
    """Fields left out stay as they are. A string replaces the text; null drops the edit and
    shows the machine text again."""

    model_config = ConfigDict(extra="forbid")

    original_text: EditedText | None = None
    english_text: EditedText | None = None

    @model_validator(mode="after")
    def _something_to_change(self) -> "SegmentEdit":
        if not self.model_fields_set:
            raise ValueError("Send original_text, english_text or both")
        return self


class AdminSegment(BaseModel):
    """A transcript line with machine output and edits side by side, for the edit screen."""

    seq: int
    start_ms: int
    end_ms: int
    language: str | None
    original_machine: str
    original_edited: str | None
    # None for English speech, or when no translation exists.
    english_machine: str | None
    english_edited: str | None
    edited_at: datetime | None
    # Email of the admin who last edited the line; None if unedited or the admin was removed.
    edited_by: str | None


class AdminSegmentList(BaseModel):
    items: list[AdminSegment]


def _to_admin_segment(row: SegmentRow, editor: str | None) -> AdminSegment:
    return AdminSegment(
        seq=row.seq,
        start_ms=row.start_ms,
        end_ms=row.end_ms,
        language=row.language,
        original_machine=row.original_machine,
        original_edited=row.original_edited,
        english_machine=row.english_machine,
        english_edited=row.english_edited,
        edited_at=row.edited_at,
        edited_by=editor,
    )


def _interview(session: Session, interview_id: uuid.UUID) -> InterviewRow:
    interview = session.get(InterviewRow, interview_id)
    if interview is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Interview not found")
    return interview


@router.get("/api/interviews/{interview_id}/transcript", response_model=AdminSegmentList)
def get_transcript(
    interview_id: uuid.UUID, _admin: CurrentAdmin, session: DbSession
) -> AdminSegmentList:
    """Every line with its machine text and any edit, in order. Admins only."""
    _interview(session, interview_id)
    rows = session.execute(
        select(SegmentRow, AdminRow.email)
        .outerjoin(AdminRow, SegmentRow.edited_by == AdminRow.id)
        .where(SegmentRow.interview_id == interview_id)
        .order_by(SegmentRow.seq)
    )
    return AdminSegmentList(items=[_to_admin_segment(row, email) for row, email in rows])


def _merged(machine: str | None, edit: str | None) -> str | None:
    """What to store as the edit: None when it's the same as the machine text."""
    return None if edit == machine else edit


@router.patch("/api/interviews/{interview_id}/segments/{seq}", response_model=AdminSegment)
def edit_segment(
    interview_id: uuid.UUID,
    seq: int,
    edit: SegmentEdit,
    admin: CurrentAdmin,
    session: DbSession,
) -> AdminSegment:
    """Correct one line's original text, its English, or both. Timestamps can't be edited."""
    interview = _interview(session, interview_id)
    transcribing = session.scalar(
        select(JobRow.id).where(
            JobRow.interview_id == interview_id,
            JobRow.kind == "transcribe",
            JobRow.state.in_(("queued", "running")),
        )
    )
    if transcribing is not None:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "This interview is being transcribed, which replaces every line. "
            "Edit it once transcription has finished.",
        )
    # Locked, so two admins saving the same line at once are applied one after the other.
    segment = session.scalar(
        select(SegmentRow)
        .where(SegmentRow.interview_id == interview_id, SegmentRow.seq == seq)
        .with_for_update()
    )
    if segment is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Segment not found")

    fields = edit.model_fields_set
    if "english_text" in fields and edit.english_text is not None:
        language = segment.language or interview.primary_language
        if language == "en":
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_CONTENT,
                "This line is English speech, so it has no separate English translation. "
                "Edit original_text instead.",
            )

    before = (segment.original_edited, segment.english_edited)
    if "original_text" in fields:
        segment.original_edited = _merged(segment.original_machine, edit.original_text)
    if "english_text" in fields:
        segment.english_edited = _merged(segment.english_machine, edit.english_text)

    if (segment.original_edited, segment.english_edited) != before:
        if segment.original_edited is None and segment.english_edited is None:
            # Back to the machine text: nothing stops re-transcription any more.
            segment.edited_by = segment.edited_at = None
        else:
            segment.edited_by = admin.id
            segment.edited_at = func.now()
        # Search must find the corrected words: re-embed (only) the changed chunk.
        jobs.enqueue(session, "index", interview_id)
        session.commit()
        log.info("admin %s edited segment %s of interview %s", admin.id, seq, interview_id)
        session.refresh(segment)

    editor = session.get(AdminRow, segment.edited_by) if segment.edited_by else None
    return _to_admin_segment(segment, editor.email if editor else None)
