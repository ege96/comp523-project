"""Admin-only interview routes: publish or hide an interview, correct its details, follow or
re-run its processing, and delete it. Recordings arrive through `uploads` (tus).

Every route here takes `CurrentAdmin`, so anonymous visitors get a 401 and signed-in
non-admins a 403 before anything else runs.
"""

import logging
import uuid
from datetime import datetime
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, ConfigDict, Field, model_validator
from sqlalchemy import delete, exists, func, or_, select, update
from sqlalchemy.orm import Session
from swayambhu_core import jobs, transcripts
from swayambhu_core.languages import sync_interview_languages
from swayambhu_core.models import (
    IntervieweeRow,
    InterviewRow,
    JobRow,
    LanguageRow,
    MediaFileRow,
    SegmentRow,
)
from swayambhu_core.recordings import interview_prefix
from swayambhu_core.storage import LocalMediaStore

from swayambhu_api.auth import CurrentAdmin
from swayambhu_api.config import Settings, get_settings
from swayambhu_api.db import DbSession
from swayambhu_api.recording_dates import DATE_PATTERN, recorded_date

log = logging.getLogger("swayambhu_api")

router = APIRouter()


class InterviewUpdate(BaseModel):
    """Only the fields sent change. For the optional details, null means unknown."""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    # Publishing is allowed at any time, even while processing; there is no review step.
    visibility: Literal["public", "private"] | None = None
    title: str | None = Field(default=None, min_length=1, max_length=500)
    # An existing interviewee, or the name of a new one (names aren't unique, so a name
    # always adds a person). interviewee_id null: the interviewee is unknown.
    interviewee_id: int | None = None
    interviewee_name: str | None = Field(default=None, min_length=1, max_length=500)
    # YYYY, YYYY-MM or YYYY-MM-DD; null: the date is unknown.
    recorded_on: str | None = Field(default=None, pattern=DATE_PATTERN)
    # The admin's confirmed original language; null goes back to the detected one.
    language: str | None = None

    @model_validator(mode="after")
    def _consistent(self) -> "InterviewUpdate":
        sent = self.model_fields_set
        if not sent:
            raise ValueError("Send at least one field to change")
        for required in ("visibility", "title", "interviewee_name"):
            if required in sent and getattr(self, required) is None:
                raise ValueError(f"{required} can't be null")
        if {"interviewee_id", "interviewee_name"} <= sent:
            raise ValueError("Send interviewee_id or interviewee_name, not both")
        if self.recorded_on is not None:
            recorded_date(self.recorded_on)  # rejects impossible dates such as 2024-02-30
        return self


class Job(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    kind: str
    state: Literal["queued", "running", "done", "failed"]
    attempts: int
    max_attempts: int
    # The last failure, kept even when a retry later succeeded.
    last_error: str | None
    created_at: datetime
    finished_at: datetime | None


class JobList(BaseModel):
    items: list[Job]


def _interview(session: Session, interview_id: uuid.UUID) -> InterviewRow:
    interview = session.get(InterviewRow, interview_id)
    if interview is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Interview not found")
    return interview


@router.patch("/api/interviews/{interview_id}", status_code=status.HTTP_204_NO_CONTENT)
def update_interview(
    interview_id: uuid.UUID, update: InterviewUpdate, _admin: CurrentAdmin, session: DbSession
) -> None:
    """Publish or hide an interview, or correct its details. Takes effect on the next request.

    Changing the language doesn't redo the transcript or the English on its own: both cost
    provider calls, and transcribing again would replace corrections. The admin page offers
    those as separate actions.
    """
    interview = _interview(session, interview_id)
    sent = update.model_fields_set
    if update.visibility is not None:
        interview.visibility = update.visibility
    if update.title is not None:
        interview.title = update.title
    if "interviewee_id" in sent:
        if update.interviewee_id is not None and not session.scalar(
            select(exists().where(IntervieweeRow.id == update.interviewee_id))
        ):
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Unknown interviewee")
        interview.interviewee_id = update.interviewee_id
    if update.interviewee_name is not None:
        person = IntervieweeRow(display_name=update.interviewee_name)
        session.add(person)
        session.flush()
        interview.interviewee_id = person.id
    if "recorded_on" in sent:
        interview.recorded_on, interview.recorded_on_precision = (
            recorded_date(update.recorded_on) if update.recorded_on else (None, None)
        )
    if "language" in sent and update.language != interview.language_confirmed:
        if update.language is not None and session.get(LanguageRow, update.language) is None:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Unknown language")
        interview.language_confirmed = update.language
        sync_interview_languages(session, interview.id)
    session.commit()


class InterviewCount(BaseModel):
    status: Literal["processing", "done", "failed"]
    visibility: Literal["public", "private"]
    count: int


class InterviewCounts(BaseModel):
    # Only the combinations that have interviews; the admin page groups them into its tabs.
    items: list[InterviewCount]


@router.get("/api/admin/interview-counts", response_model=InterviewCounts)
def interview_counts(_admin: CurrentAdmin, session: DbSession) -> InterviewCounts:
    """How many interviews there are of each status and visibility, Private included, in
    one request instead of one per tab."""
    rows = session.execute(
        select(InterviewRow.status, InterviewRow.visibility, func.count())
        .group_by(InterviewRow.status, InterviewRow.visibility)
        .order_by(InterviewRow.status, InterviewRow.visibility)
    ).all()
    return InterviewCounts(
        items=[
            InterviewCount.model_validate({"status": s, "visibility": v, "count": n})
            for s, v, n in rows
        ]
    )


@router.get("/api/interviews/{interview_id}/jobs", response_model=JobList)
def list_jobs(interview_id: uuid.UUID, _admin: CurrentAdmin, session: DbSession) -> JobList:
    """Every processing step queued for an interview, oldest first, with retries and errors."""
    _interview(session, interview_id)
    rows = session.scalars(
        select(JobRow).where(JobRow.interview_id == interview_id).order_by(JobRow.id)
    )
    return JobList(items=[Job.model_validate(j) for j in rows])


class Rerun(BaseModel):
    model_config = ConfigDict(extra="forbid")

    # transcribe: a new transcript from the audio, then English and search again.
    # translate: new machine English (corrections to it are kept), then search again.
    # index: search again. playback: a new copy for the player.
    step: Literal["transcribe", "translate", "index", "playback"]
    # Transcribe again even though admins corrected lines; the corrections are lost.
    replace_corrections: bool = False


# The job kinds that do each step, and what the admin sees while it waits.
_RERUN_KINDS = {
    "transcribe": ("transcribe", "retranscribe"),
    "translate": ("translate",),
    "index": ("index",),
    "playback": ("playback",),
}
_WAITING = {
    "transcribe": "Waiting to transcribe",
    "translate": "Waiting to translate",
    "index": "Waiting to index for search",
}


@router.post(
    "/api/interviews/{interview_id}/rerun",
    status_code=status.HTTP_202_ACCEPTED,
    responses={409: {"description": "Already queued or running, or would replace corrections"}},
)
def rerun(interview_id: uuid.UUID, body: Rerun, _admin: CurrentAdmin, session: DbSession) -> None:
    """Run a processing step again: to retry one that failed, or to redo the transcript or
    English after the language was corrected. The later steps follow, as after an upload.

    Transcribing again replaces every line, so when admins have corrected any it is refused
    (409, with `corrected_lines`) unless `replace_corrections` says to go ahead.
    """
    interview = _interview(session, interview_id)
    # Locked, so a line saved at the same moment is counted here, or refused once this commits.
    transcripts.lock_interview(session, interview_id)
    kinds = _RERUN_KINDS[body.step]
    if session.scalar(
        select(
            exists().where(
                JobRow.interview_id == interview_id,
                JobRow.kind.in_(kinds),
                JobRow.state.in_(("queued", "running")),
            )
        )
    ):
        raise HTTPException(status.HTTP_409_CONFLICT, "This step is already waiting or running")
    lines = SegmentRow.interview_id == interview_id
    kind: str = body.step
    if body.step == "transcribe":
        corrected = transcripts.corrections_blocking_replacement(session, interview_id, None)
        if corrected and not body.replace_corrections:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                {
                    "message": "Transcribing again would replace corrected lines",
                    "corrected_lines": corrected,
                },
            )
        if corrected:
            kind = "retranscribe"
    if body.step == "translate":
        if not session.scalar(select(exists().where(lines))):
            raise HTTPException(status.HTTP_409_CONFLICT, "There is no transcript to translate")
        # The admin's language wins over what the machine guessed for each line, so a
        # corrected Nepal Bhasa interview is translated from Nepal Bhasa. English stays English.
        if interview.language_confirmed and interview.language_confirmed != "en":
            session.execute(
                update(SegmentRow)
                .where(lines, or_(SegmentRow.language.is_(None), SegmentRow.language != "en"))
                .values(language=interview.language_confirmed)
            )
            sync_interview_languages(session, interview.id)
        interview.translation_status = "pending"
    if body.step != "playback":
        interview.status = "processing"
        interview.status_detail = _WAITING[body.step]
    jobs.enqueue(session, kind, interview_id, jobs.Priority.ADMIN)
    session.commit()


@router.delete(
    "/api/interviews/{interview_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    responses={409: {"description": "The interview is published; unpublish it first"}},
)
def delete_interview(
    interview_id: uuid.UUID,
    admin: CurrentAdmin,
    session: DbSession,
    settings: Annotated[Settings, Depends(get_settings)],
) -> None:
    """Delete an interview for good: its recording and playback copy, transcript, corrections,
    English, search entries and processing jobs, and its interviewee if no other interview
    names them. There is no undo.

    A published interview is refused, so deleting takes two deliberate steps and never removes
    a page a visitor may have open. The rows go in one transaction (the foreign keys cascade);
    the files go after it commits, so a failed commit never leaves rows pointing at missing
    files. A file that can't be removed is logged and left for the worker's `sweep_media`
    command. A step the worker is running for the interview loses its job row, so it finds
    its claim gone and writes nothing more.
    """
    interview = session.scalar(
        select(InterviewRow).where(InterviewRow.id == interview_id).with_for_update()
    )
    if interview is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Interview not found")
    if interview.visibility == "public":
        raise HTTPException(
            status.HTTP_409_CONFLICT, "The interview is published. Unpublish it first."
        )
    lines, corrected = session.execute(
        select(
            func.count(),
            func.count().filter(
                or_(SegmentRow.original_edited.is_not(None), SegmentRow.english_edited.is_not(None))
            ),
        ).where(SegmentRow.interview_id == interview_id)
    ).one()
    stored_bytes = session.scalar(
        select(func.coalesce(func.sum(MediaFileRow.size_bytes), 0)).where(
            MediaFileRow.interview_id == interview_id
        )
    )
    interviewee_id = interview.interviewee_id
    session.execute(delete(InterviewRow).where(InterviewRow.id == interview_id))
    if interviewee_id is not None:
        # Names aren't unique, so a person no interview names is just a dangling name.
        session.execute(
            delete(IntervieweeRow).where(
                IntervieweeRow.id == interviewee_id,
                ~exists().where(InterviewRow.interviewee_id == interviewee_id),
            )
        )
    session.commit()

    files_removed = True
    try:
        LocalMediaStore(settings.media_root).delete_prefix(interview_prefix(interview_id))
    except OSError:
        files_removed = False
        log.exception("could not remove the files of deleted interview %s", interview_id)
    # Ids and counts only: titles and names may be personal, and logs travel further.
    log.info(
        "admin %s deleted interview %s",
        admin.id,
        interview_id,
        extra={
            "fields": {
                "event": "interview_deleted",
                "admin_id": admin.id,
                "interview_id": str(interview_id),
                "lines": lines,
                "corrected_lines": corrected,
                "stored_bytes": stored_bytes,
                "files_removed": files_removed,
            }
        },
    )
