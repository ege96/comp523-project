"""Resumable recording uploads using the tus protocol (https://tus.io), served by
tuspyserver.

An admin's browser (tus-js-client) or script (tuspy, or curl) creates an upload at
`POST /api/uploads` with the interview's metadata, then sends the file in chunks with
`PATCH /api/uploads/{id}`. A dropped connection resumes from the last byte the server holds
(`HEAD` reports it). Partial uploads live in `<MEDIA_ROOT>/uploads`, on the same volume as
the media, so a finished one is moved into place rather than copied. Only then is the
interview created and its processing queued, so an abandoned upload leaves no interview
behind; the worker deletes abandoned uploads after `UPLOAD_RETENTION_DAYS`.

Every tus route is admin-only. The final PATCH's response carries the new interview's
id in `Upload-Interview-Id`.
"""

import mimetypes
import re
import uuid
from collections.abc import Awaitable, Callable
from datetime import date
from pathlib import Path, PurePosixPath
from typing import Annotated, Literal

from fastapi import Depends, HTTPException, Request, Response, status
from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator
from sqlalchemy import exists, select
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool
from swayambhu_core.models import IntervieweeRow, InterviewRow, LanguageRow
from swayambhu_core.recordings import add_original, original_key
from swayambhu_core.storage import LocalMediaStore
from tuspyserver import create_tus_router
from tuspyserver.storage.local import LocalFileStorage

from swayambhu_api.admins import Admin
from swayambhu_api.auth import CurrentAdmin
from swayambhu_api.config import Settings, get_settings
from swayambhu_api.db import DbSession

SettingsDep = Annotated[Settings, Depends(get_settings)]
INTERVIEW_ID_HEADER = "Upload-Interview-Id"
# A recording date: YYYY, YYYY-MM or YYYY-MM-DD, as much of it as is known.
DATE_PATTERN = r"^\d{4}(-\d{2}(-\d{2})?)?$"


class UploadMetadata(BaseModel):
    """Recording metadata received as strings in the tus Upload-Metadata header."""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    title: str = Field(min_length=1, max_length=500)
    # The file's content type, as tus-js-client sends it.
    filetype: str = Field(pattern=r"^(audio|video)/[\w.+-]+$")
    # The original file name, for its extension. tuspyserver requires it (and filetype) to
    # answer HEAD, which is how a client resumes; tus-js-client sends both by default.
    filename: str = Field(min_length=1, max_length=255)
    # Language code (en, ne, new) when known; otherwise the worker detects it.
    language: str | None = None
    # An existing interviewee, or the name of a new one. Names aren't unique, so a name
    # always creates a new person.
    interviewee_id: int | None = None
    interviewee_name: str | None = Field(default=None, min_length=1, max_length=500)
    # YYYY, YYYY-MM or YYYY-MM-DD: as much of the date as is known.
    recorded_on: str | None = Field(default=None, pattern=DATE_PATTERN)

    @model_validator(mode="after")
    def _consistent(self) -> "UploadMetadata":
        if self.interviewee_id is not None and self.interviewee_name is not None:
            raise ValueError("Send interviewee_id or interviewee_name, not both")
        if self.recorded_on is not None:
            recorded_date(self.recorded_on)  # rejects impossible dates such as 2024-02-30
        return self

    @property
    def suffix(self) -> str:
        """A short, safe extension for the stored original, or ''."""
        suffix = PurePosixPath(self.filename).suffix.lower()
        if re.fullmatch(r"\.[a-z0-9]{1,8}", suffix):
            return suffix
        return mimetypes.guess_extension(self.filetype) or ""


def recorded_date(value: str) -> tuple[date, Literal["year", "month", "day"]]:
    """'2019' -> (2019-01-01, 'year'): the first day of the period, and how much is real."""
    parts = [int(p) for p in value.split("-")]
    precision: Literal["year", "month", "day"] = ("year", "month", "day")[len(parts) - 1]
    return date(*parts, *[1] * (3 - len(parts))), precision


def _parse(metadata: dict[str, str]) -> UploadMetadata:
    try:
        return UploadMetadata.model_validate({k: v for k, v in metadata.items() if v != ""})
    except ValidationError as e:
        errors = e.errors(include_url=False, include_context=False, include_input=False)
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, errors) from None


def _check_references(session: Session, metadata: UploadMetadata) -> None:
    if metadata.language is not None and session.get(LanguageRow, metadata.language) is None:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Unknown language")
    if metadata.interviewee_id is not None and not session.scalar(
        select(exists().where(IntervieweeRow.id == metadata.interviewee_id))
    ):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Unknown interviewee")


def require_upload_admin(request: Request, admin: CurrentAdmin, settings: SettingsDep) -> Admin:
    """The admin check on every tus route, plus the limits that keep a pod's memory bounded.

    Validate the declared chunk size before tuspyserver streams it into storage.
    Its creation-with-upload and concatenation extensions read whole bodies at once, so
    they're refused: create empty, then PATCH.
    """
    if "upload-concat" in request.headers:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Concatenated uploads aren't supported")
    length = int(request.headers.get("content-length") or 0)
    if request.method == "POST" and length > 0:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, "Create the upload without a body, then PATCH it"
        )
    if request.method == "PATCH" and length > settings.upload_chunk_max_bytes:
        raise HTTPException(
            status.HTTP_413_CONTENT_TOO_LARGE,
            f"Send chunks of at most {settings.upload_chunk_max_bytes} bytes",
        )
    return admin


PreCreate = Callable[[dict[str, str], dict[str, object]], Awaitable[None]]


def check_new_upload(session: DbSession, settings: SettingsDep) -> PreCreate:
    """Refuse a bad upload when it is created, before any of the file is sent."""

    async def check(metadata: dict[str, str], info: dict[str, object]) -> None:
        parsed = _parse(metadata)
        size = info.get("size")
        if not isinstance(size, int):
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Upload-Length is required")
        if size == 0:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "The file is empty")
        if size > settings.max_upload_bytes:
            raise HTTPException(
                status.HTTP_413_CONTENT_TOO_LARGE,
                f"Recordings can be at most {settings.max_upload_bytes} bytes",
            )
        await run_in_threadpool(_check_references, session, parsed)
        await run_in_threadpool(session.rollback)  # don't hold a connection between requests

    return check


def _create_interview(
    session: Session, admin: Admin, settings: Settings, metadata: UploadMetadata, upload: Path
) -> uuid.UUID:
    """Move the finished upload into media storage and create its interview and jobs."""
    _check_references(session, metadata)  # an interviewee may have gone since creation
    interviewee_id = metadata.interviewee_id
    if metadata.interviewee_name is not None:
        person = IntervieweeRow(display_name=metadata.interviewee_name)
        session.add(person)
        session.flush()
        interviewee_id = person.id
    recorded_on, precision = (
        recorded_date(metadata.recorded_on) if metadata.recorded_on else (None, None)
    )
    interview = InterviewRow(
        id=uuid.uuid4(),
        title=metadata.title,
        language_confirmed=metadata.language,
        interviewee_id=interviewee_id,
        recorded_on=recorded_on,
        recorded_on_precision=precision,
        created_by=admin.id,
    )
    session.add(interview)
    session.flush()
    key = original_key(interview.id, metadata.suffix)
    size = upload.stat().st_size
    # Hashing a multi-GB file here would outlast the router's request timeout.
    add_original(
        session, interview.id, key=key, content_type=metadata.filetype, size_bytes=size,
        sha256=None,
    )  # fmt: skip
    store = LocalMediaStore(settings.media_root)
    store.put(key, upload, move=True)
    try:
        session.commit()
    except BaseException:
        store.delete(key)
        raise
    upload.with_name(upload.name + ".info").unlink(missing_ok=True)
    return interview.id


Complete = Callable[[str, dict[str, str]], Awaitable[None]]


def finish_upload(
    admin: CurrentAdmin, session: DbSession, settings: SettingsDep, response: Response
) -> Complete:
    async def finish(path: str, metadata: dict[str, str]) -> None:
        interview_id = await run_in_threadpool(
            _create_interview, session, admin, settings, _parse(metadata), Path(path)
        )
        response.headers[INTERVIEW_ID_HEADER] = str(interview_id)

    return finish


def uploads_dir(settings: Settings) -> Path:
    return settings.media_root / "uploads"


# Built once at import: tuspyserver fixes its directory and size limit when the router is
# made. Tests point `storage.files_dir` somewhere else.
storage = LocalFileStorage(str(uploads_dir(get_settings())))
# tuspyserver's hints say the hooks return None and `auth` takes no arguments; at runtime it
# runs them as FastAPI dependencies and awaits what they return.
router = create_tus_router(
    prefix="/api/uploads",
    max_size=get_settings().max_upload_bytes,
    auth=require_upload_admin,  # type: ignore[arg-type]
    pre_create_dep=check_new_upload,  # type: ignore[arg-type]
    upload_complete_dep=finish_upload,  # type: ignore[arg-type]
    days_to_keep=get_settings().upload_retention_days,
    storage=storage,
    tags=["uploads"],
)
