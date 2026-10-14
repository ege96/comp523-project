"""Admin-only interview routes: upload a recording, publish or hide an interview, and follow
its processing (Proposal: paths and shapes).

Every route here takes `CurrentAdmin`, so anonymous visitors get a 401 and signed-in
non-admins a 403 before anything else runs, including reading an upload's body.
"""

import errno
import hashlib
import mimetypes
import re
import uuid
from datetime import date, datetime
from pathlib import PurePosixPath
from typing import Annotated, Literal

import anyio.to_thread
from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request, Response, status
from pydantic import BaseModel, ConfigDict, Field, model_validator
from sqlalchemy import exists, select
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool
from starlette.requests import ClientDisconnect
from swayambhu_core.models import IntervieweeRow, InterviewRow, JobRow, LanguageRow
from swayambhu_core.recordings import add_original, original_key
from swayambhu_core.storage import LocalMediaStore

from swayambhu_api.admins import Admin
from swayambhu_api.auth import CurrentAdmin
from swayambhu_api.config import Settings, get_settings
from swayambhu_api.db import DbSession

router = APIRouter()
SettingsDep = Annotated[Settings, Depends(get_settings)]

# Disk writes happen off the event loop in pieces this big, not once per network chunk.
WRITE_BUFFER_BYTES = 1 << 20
_DATE = re.compile(r"\d{4}(-\d{2}(-\d{2})?)?")


class UploadMetadata(BaseModel):
    """What the admin knows about a recording, sent as query parameters next to the raw file
    body (D-004: only the title is required)."""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    title: str = Field(min_length=1, max_length=500)
    # The original file name, for its extension. Optional: the content type is the fallback.
    filename: str | None = Field(default=None, max_length=255)
    # Language code (en, ne, new) when known; otherwise the worker detects it.
    language: str | None = None
    # An existing interviewee, or the name of a new one. Names aren't unique, so a name
    # always creates a new person.
    interviewee_id: int | None = None
    interviewee_name: str | None = Field(default=None, min_length=1, max_length=500)
    # YYYY, YYYY-MM or YYYY-MM-DD: as much of the date as is known.
    recorded_on: str | None = Field(default=None, pattern=_DATE.pattern)

    @model_validator(mode="after")
    def _one_interviewee(self) -> "UploadMetadata":
        if self.interviewee_id is not None and self.interviewee_name is not None:
            raise ValueError("Send interviewee_id or interviewee_name, not both")
        if self.recorded_on is not None:
            recorded_date(self.recorded_on)  # rejects impossible dates such as 2024-02-30
        return self


def recorded_date(value: str) -> tuple[date, Literal["year", "month", "day"]]:
    """'2019' -> (2019-01-01, 'year'): the first day of the period, and how much is real."""
    parts = [int(p) for p in value.split("-")]
    precision: Literal["year", "month", "day"] = ("year", "month", "day")[len(parts) - 1]
    return date(*parts, *[1] * (3 - len(parts))), precision


class UploadedInterview(BaseModel):
    id: uuid.UUID


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


def _suffix(filename: str | None, content_type: str) -> str:
    """A short, safe file extension for the stored original, or ''."""
    suffix = PurePosixPath(filename or "").suffix.lower()
    if not re.fullmatch(r"\.[a-z0-9]{1,8}", suffix):
        suffix = mimetypes.guess_extension(content_type) or ""
    return suffix


def _check_references(session: Session, metadata: UploadMetadata) -> None:
    """Fail before the body is read, not after a multi-GB upload."""
    if metadata.language is not None and session.get(LanguageRow, metadata.language) is None:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Unknown language")
    if metadata.interviewee_id is not None and not session.scalar(
        select(exists().where(IntervieweeRow.id == metadata.interviewee_id))
    ):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Unknown interviewee")


def _create(
    session: Session,
    admin: Admin,
    interview_id: uuid.UUID,
    metadata: UploadMetadata,
    stored: tuple[str, str, int, str],
) -> None:
    interviewee_id = metadata.interviewee_id
    if metadata.interviewee_name is not None:
        person = IntervieweeRow(display_name=metadata.interviewee_name)
        session.add(person)
        session.flush()
        interviewee_id = person.id
    recorded_on, precision = (
        recorded_date(metadata.recorded_on) if metadata.recorded_on else (None, None)
    )
    session.add(
        InterviewRow(
            id=interview_id,
            title=metadata.title,
            language_confirmed=metadata.language,
            interviewee_id=interviewee_id,
            recorded_on=recorded_on,
            recorded_on_precision=precision,
            created_by=admin.id,
        )
    )
    session.flush()
    key, content_type, size, sha256 = stored
    add_original(
        session, interview_id, key=key, content_type=content_type, size_bytes=size, sha256=sha256
    )
    session.commit()


@router.post(
    "/api/interviews",
    status_code=status.HTTP_201_CREATED,
    response_model=UploadedInterview,
    openapi_extra={
        "requestBody": {
            "required": True,
            "description": "The recording itself, as the raw request body (not a form).",
            "content": {
                t: {"schema": {"type": "string", "format": "binary"}}
                for t in ("audio/*", "video/*")
            },
        }
    },
    responses={
        413: {"description": "Larger than MAX_UPLOAD_BYTES"},
        415: {"description": "Not an audio or video content type"},
        507: {"description": "The media volume is full"},
    },
)
async def upload_interview(
    request: Request,
    response: Response,
    admin: CurrentAdmin,
    session: DbSession,
    settings: SettingsDep,
    metadata: Annotated[UploadMetadata, Query()],
    content_type: Annotated[str, Header()],
    content_length: Annotated[int | None, Header()] = None,
) -> UploadedInterview:
    """Add a recording as a new Private interview and queue its processing.

    The body is streamed straight to media storage, so hour-long, multi-GB files never sit
    in memory or on the pod's own disk. The interview exists only once the whole file has
    arrived: an interrupted upload leaves nothing behind and can simply be sent again.
    Status starts as Processing; follow it with `GET /api/interviews/{id}/jobs`.
    """
    media_type = content_type.split(";")[0].strip().lower()
    if not media_type.startswith(("audio/", "video/")):
        raise HTTPException(status.HTTP_415_UNSUPPORTED_MEDIA_TYPE, "Send an audio or video file")
    too_large = HTTPException(
        status.HTTP_413_CONTENT_TOO_LARGE,
        f"Recordings can be at most {settings.max_upload_bytes} bytes",
    )
    if content_length is not None and content_length > settings.max_upload_bytes:
        raise too_large
    await run_in_threadpool(_check_references, session, metadata)
    # Hand the connection back to the pool for the length of the upload, which can take many
    # minutes, rather than holding it idle in a transaction.
    await run_in_threadpool(session.rollback)

    interview_id = uuid.uuid4()
    key = original_key(interview_id, _suffix(metadata.filename, media_type))
    digest, size, buffer = hashlib.sha256(), 0, bytearray()
    try:
        with LocalMediaStore(settings.media_root).writer(key) as f:

            def flush() -> None:
                f.write(buffer)
                digest.update(buffer)
                buffer.clear()

            async for chunk in request.stream():
                size += len(chunk)
                if size > settings.max_upload_bytes:
                    raise too_large
                buffer += chunk
                if len(buffer) >= WRITE_BUFFER_BYTES:
                    await anyio.to_thread.run_sync(flush)
            if size == 0:
                raise HTTPException(status.HTTP_400_BAD_REQUEST, "The file is empty")
            await anyio.to_thread.run_sync(flush)
    except ClientDisconnect:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "The upload was interrupted") from None
    except OSError as e:
        if e.errno != errno.ENOSPC:
            raise
        raise HTTPException(
            status.HTTP_507_INSUFFICIENT_STORAGE, "The media volume is full"
        ) from None

    stored = (key, media_type, size, digest.hexdigest())
    try:
        await run_in_threadpool(_create, session, admin, interview_id, metadata, stored)
    except BaseException:
        LocalMediaStore(settings.media_root).delete(key)
        raise
    response.headers["Location"] = f"/api/interviews/{interview_id}"
    return UploadedInterview(id=interview_id)


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
