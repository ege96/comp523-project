"""Admin-only interview routes: publish or hide an interview, correct its details, and follow
its processing (Proposal: paths and shapes). Recordings arrive through `uploads` (tus).

Every route here takes `CurrentAdmin`, so anonymous visitors get a 401 and signed-in
non-admins a 403 before anything else runs.
"""

import uuid
from datetime import datetime
from typing import Literal

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, ConfigDict, Field, model_validator
from sqlalchemy import delete, exists, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session
from swayambhu_core.models import (
    IntervieweeRow,
    InterviewLanguageRow,
    InterviewRow,
    JobRow,
    LanguageRow,
    SegmentRow,
)

from swayambhu_api.auth import CurrentAdmin
from swayambhu_api.db import DbSession
from swayambhu_api.uploads import DATE_PATTERN, recorded_date

router = APIRouter()


class InterviewUpdate(BaseModel):
    """Only the fields sent change. For the optional details (D-004), null means unknown."""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    # D-008: publishing is allowed at any time, even while processing; there is no review step.
    visibility: Literal["public", "private"] | None = None
    title: str | None = Field(default=None, min_length=1, max_length=500)
    # An existing interviewee, or the name of a new one (names aren't unique, so a name
    # always adds a person). interviewee_id null: the interviewee is unknown.
    interviewee_id: int | None = None
    interviewee_name: str | None = Field(default=None, min_length=1, max_length=500)
    # YYYY, YYYY-MM or YYYY-MM-DD; null: the date is unknown.
    recorded_on: str | None = Field(default=None, pattern=DATE_PATTERN)
    # The admin's confirmed original language (D-004); null goes back to the detected one.
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


def _sync_languages(session: Session, interview: InterviewRow) -> None:
    """The language filter matches every language heard plus the confirmed one, so a
    corrected language is findable at once. The worker keeps this up to date the same way."""
    codes: set[str] = {
        code
        for code in session.scalars(
            select(SegmentRow.language)
            .where(SegmentRow.interview_id == interview.id, SegmentRow.language.is_not(None))
            .distinct()
        )
        if code
    }
    if interview.language_confirmed:
        codes.add(interview.language_confirmed)
    session.execute(
        delete(InterviewLanguageRow).where(InterviewLanguageRow.interview_id == interview.id)
    )
    if codes:
        session.execute(
            insert(InterviewLanguageRow).values(
                [{"interview_id": interview.id, "language_code": c} for c in sorted(codes)]
            )
        )


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
        _sync_languages(session, interview)
    session.commit()


@router.get("/api/interviews/{interview_id}/jobs", response_model=JobList)
def list_jobs(interview_id: uuid.UUID, _admin: CurrentAdmin, session: DbSession) -> JobList:
    """Every processing step queued for an interview, oldest first, with retries and errors."""
    _interview(session, interview_id)
    rows = session.scalars(
        select(JobRow).where(JobRow.interview_id == interview_id).order_by(JobRow.id)
    )
    return JobList(items=[Job.model_validate(j) for j in rows])
