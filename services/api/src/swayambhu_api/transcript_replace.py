"""Find and replace across one interview's transcript.

Speech recognition tends to get the same name or place wrong every time it comes up, so an
admin can fix every occurrence at once instead of line by line. Each changed line is stored
as an edit beside the machine text, exactly as if it had been saved by hand, so "Use machine
text" still undoes it. However many lines change, the worker's `index` step is queued once.

Admins only (`CurrentAdmin`): anonymous visitors get a 401 and signed-in non-admins a 403
before anything else runs, whatever the interview's visibility.
"""

import logging
import re
import uuid
from datetime import timedelta
from typing import Annotated, Literal

from fastapi import APIRouter
from pydantic import BaseModel, ConfigDict, Field, StringConstraints
from sqlalchemy import func, select
from swayambhu_core import jobs
from swayambhu_core.models import SegmentRow
from swayambhu_core.text import english_is_stale

from swayambhu_api.auth import CurrentAdmin
from swayambhu_api.db import DbSession
from swayambhu_api.transcript_edits import (
    AdminSegment,
    SettingsDep,
    _interview,
    _merged,
    _refuse_while_transcribing,
    _to_admin_segment,
)

router = APIRouter()
log = logging.getLogger("swayambhu_api")

# Same cap as a single line's edit.
MAX_LINE_LENGTH = 10_000


class FindReplace(BaseModel):
    """Replace every occurrence of `find` in one text of every line. Plain text, not a pattern."""

    model_config = ConfigDict(extra="forbid")

    find: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]
    # May be empty, to delete a word.
    replace: Annotated[str, StringConstraints(max_length=200)]
    # Which text to change: the original-language transcript or its English translation.
    field: Literal["original", "english"]
    match_case: bool = False


class ReplaceResult(BaseModel):
    # The lines that changed, as they are now. Empty means nothing matched.
    items: list[AdminSegment]
    # Matching lines left alone because the replacement would have left them blank.
    skipped: int = Field(ge=0)


def _current(segment: SegmentRow, field: str, primary_language: str | None) -> str | None:
    """The text an admin sees for that field, or None if the line has none to change."""
    if field == "original":
        return (
            segment.original_edited
            if segment.original_edited is not None
            else (segment.original_machine)
        )
    if (segment.language or primary_language) == "en":
        return None  # English speech: there's no separate translation
    return (
        segment.english_edited if segment.english_edited is not None else (segment.english_machine)
    )


@router.post("/api/interviews/{interview_id}/transcript/replace", response_model=ReplaceResult)
def replace_in_transcript(
    interview_id: uuid.UUID,
    body: FindReplace,
    admin: CurrentAdmin,
    session: DbSession,
    settings: SettingsDep,
) -> ReplaceResult:
    """Replace a word or phrase in every line of one interview, kept apart from machine text."""
    interview = _interview(session, interview_id)
    _refuse_while_transcribing(session, interview_id)

    pattern = re.compile(re.escape(body.find), 0 if body.match_case else re.IGNORECASE)
    # Locked, so a line saved by hand at the same moment is applied before or after, not lost.
    segments = session.scalars(
        select(SegmentRow)
        .where(SegmentRow.interview_id == interview_id)
        .order_by(SegmentRow.seq)
        .with_for_update()
    ).all()

    changed: list[SegmentRow] = []
    skipped = 0
    for segment in segments:
        current = _current(segment, body.field, interview.primary_language)
        if current is None or not pattern.search(current):
            continue
        # A function, so backslashes in the replacement are taken literally.
        new = pattern.sub(lambda _: body.replace, current).strip()
        if not new or len(new) > MAX_LINE_LENGTH:
            skipped += 1
            continue
        if body.field == "original":
            segment.original_edited = _merged(segment.original_machine, new)
        else:
            segment.english_edited = _merged(segment.english_machine, new)
            if segment.english_edited is None:
                segment.english_edit_source_hash = None
            # Otherwise the check mark stays as it was: replacing a word isn't checking the
            # whole English against the original.
        if segment.original_edited is None and segment.english_edited is None:
            segment.edited_by = segment.edited_at = None
        else:
            segment.edited_by = admin.id
            segment.edited_at = func.now()
        changed.append(segment)

    if changed:
        # One re-index for the whole batch; it re-embeds only the chunks whose text changed.
        jobs.enqueue(session, "index", interview_id)
        if any(english_is_stale(s) for s in changed):
            # Like a hand edit: one delayed batch, pushed back by further edits.
            delay = timedelta(seconds=settings.retranslate_delay_seconds)
            jobs.schedule(session, "retranslate", interview_id, delay)
        session.commit()
        log.info(
            "admin %s replaced text in %d lines of interview %s",
            admin.id, len(changed), interview_id,
        )  # fmt: skip
        for segment in changed:
            session.refresh(segment)

    # Every changed line is now either this admin's edit or back to the machine text.
    return ReplaceResult(
        items=[_to_admin_segment(s, admin.email if s.edited_by else None) for s in changed],
        skipped=skipped,
    )
