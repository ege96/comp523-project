"""Admin-only interview routes: publish or hide an interview, and follow its processing
(Proposal: paths and shapes). Recordings arrive through `uploads` (tus).

Every route here takes `CurrentAdmin`, so anonymous visitors get a 401 and signed-in
non-admins a 403 before anything else runs.
"""

import uuid
from datetime import datetime
from typing import Literal

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, ConfigDict
from sqlalchemy import select
from sqlalchemy.orm import Session
from swayambhu_core.models import InterviewRow, JobRow

from swayambhu_api.auth import CurrentAdmin
from swayambhu_api.db import DbSession

router = APIRouter()


class InterviewUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    # D-008: publishing is allowed at any time, even while processing; review isn't required.
    visibility: Literal["public", "private"]


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
    """Publish (Public) or hide (Private) an interview. Takes effect on the next request."""
    _interview(session, interview_id).visibility = update.visibility
    session.commit()


@router.get("/api/interviews/{interview_id}/jobs", response_model=JobList)
def list_jobs(interview_id: uuid.UUID, _admin: CurrentAdmin, session: DbSession) -> JobList:
    """Every processing step queued for an interview, oldest first, with retries and errors."""
    _interview(session, interview_id)
    rows = session.scalars(
        select(JobRow).where(JobRow.interview_id == interview_id).order_by(JobRow.id)
    )
    return JobList(items=[Job.model_validate(j) for j in rows])
