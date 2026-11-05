"""Reading interviews, their transcripts and their media (Proposal: paths and shapes).

Anonymous visitors and admins use the same routes. What each may see is decided only by
`visibility.visible_to`: a Private interview is a 404 for visitors, exactly like one that
doesn't exist, so its existence isn't revealed. Visitors see Public interviews whatever their
status (D-008), with the status and translation state to label them.
"""

import uuid
from datetime import UTC, date, datetime
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import FileResponse
from pydantic import BaseModel
from sqlalchemy import Select, func, select
from sqlalchemy.orm import aliased
from swayambhu_core.models import (
    IntervieweeRow,
    InterviewLanguageRow,
    InterviewRow,
    LanguageRow,
    MediaFileRow,
    SegmentRow,
)
from swayambhu_core.storage import LocalMediaStore

from swayambhu_api import media_urls
from swayambhu_api.auth import CurrentViewer
from swayambhu_api.config import Settings, get_settings
from swayambhu_api.db import DbSession
from swayambhu_api.visibility import visible_to

router = APIRouter()
SettingsDep = Annotated[Settings, Depends(get_settings)]

Status = Literal["processing", "done", "failed"]
TranslationStatus = Literal["not_needed", "pending", "done", "failed"]


class Language(BaseModel):
    code: str
    name: str


class InterviewSummary(BaseModel):
    id: uuid.UUID
    title: str
    interviewee: str | None
    primary_language: Language | None
    duration_ms: int | None
    recorded_on: date | None
    recorded_on_precision: Literal["year", "month", "day"] | None
    visibility: Literal["public", "private"]
    status: Status
    translation_status: TranslationStatus
    created_at: datetime


class InterviewList(BaseModel):
    items: list[InterviewSummary]
    total: int


class Media(BaseModel):
    url: str
    content_type: str
    expires_at: datetime


class InterviewDetail(InterviewSummary):
    interviewer: str | None
    location: str | None
    description: str | None
    consent_note: str | None
    languages: list[Language]
    # None until the worker has made the browser-playable copy.
    media: Media | None
    # Which step is running or why it failed. Admins only; always None for visitors.
    status_detail: str | None


class Segment(BaseModel):
    seq: int
    start_ms: int
    end_ms: int
    language: str | None
    original_text: str
    # None when the speech is English, or no translation exists (see translation_status).
    english_text: str | None
    # False means the text is still exactly what the machine produced.
    original_edited: bool
    english_edited: bool


class SegmentList(BaseModel):
    items: list[Segment]


def to_segment(row: SegmentRow) -> Segment:
    return Segment(
        seq=row.seq,
        start_ms=row.start_ms,
        end_ms=row.end_ms,
        language=row.language,
        original_text=row.original_text,
        english_text=row.english_text,
        original_edited=row.original_edited is not None,
        english_edited=row.english_edited is not None,
    )


_primary = aliased(LanguageRow)


# Outer joins: the interviewee and language names are None when the interview has neither.
def summary_query(viewer: CurrentViewer) -> Select[InterviewRow, str, str]:
    return (
        select(InterviewRow, IntervieweeRow.display_name, _primary.english_name)
        .outerjoin(IntervieweeRow, InterviewRow.interviewee_id == IntervieweeRow.id)
        .outerjoin(_primary, InterviewRow.primary_language == _primary.code)
        .where(visible_to(viewer.admin))
    )


def to_summary(
    row: InterviewRow, interviewee: str | None, language: str | None
) -> dict[str, object]:
    return {
        "id": row.id,
        "title": row.title,
        "interviewee": interviewee,
        "primary_language": (
            Language(code=row.primary_language, name=language or row.primary_language)
            if row.primary_language
            else None
        ),
        "duration_ms": row.duration_ms,
        "recorded_on": row.recorded_on,
        "recorded_on_precision": row.recorded_on_precision,
        "visibility": row.visibility,
        "status": row.status,
        "translation_status": row.translation_status,
        "created_at": row.created_at,
    }


@router.get("/api/interviews", response_model=InterviewList)
def list_interviews(
    session: DbSession,
    viewer: CurrentViewer,
    limit: Annotated[int, Query(ge=1, le=100)] = 20,
    offset: Annotated[int, Query(ge=0)] = 0,
    status_filter: Annotated[Status | None, Query(alias="status")] = None,
) -> InterviewList:
    """Interviews the viewer may see, most recently added first, optionally only those with
    one status (for the admin's processing queue)."""
    query = summary_query(viewer)
    if status_filter is not None:
        query = query.where(InterviewRow.status == status_filter)
    total = session.scalar(select(func.count()).select_from(query.subquery())) or 0
    rows = session.execute(
        query.order_by(InterviewRow.created_at.desc(), InterviewRow.id).limit(limit).offset(offset)
    ).all()
    return InterviewList(
        items=[InterviewSummary.model_validate(to_summary(i, p, lang)) for i, p, lang in rows],
        total=total,
    )


def _visible_interview(
    session: DbSession, viewer: CurrentViewer, interview_id: uuid.UUID
) -> tuple[InterviewRow, str | None, str | None]:
    row = session.execute(
        summary_query(viewer).where(InterviewRow.id == interview_id)
    ).one_or_none()
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Interview not found")
    interview, interviewee, language = row
    return interview, interviewee, language


@router.get("/api/interviews/{interview_id}", response_model=InterviewDetail)
def get_interview(
    interview_id: uuid.UUID, session: DbSession, viewer: CurrentViewer, settings: SettingsDep
) -> InterviewDetail:
    interview, interviewee, language = _visible_interview(session, viewer, interview_id)
    languages = session.execute(
        select(LanguageRow.code, LanguageRow.english_name)
        .join(InterviewLanguageRow, InterviewLanguageRow.language_code == LanguageRow.code)
        .where(InterviewLanguageRow.interview_id == interview_id)
        .order_by(LanguageRow.code)
    ).all()
    playback = session.scalar(
        select(MediaFileRow).where(
            MediaFileRow.interview_id == interview_id, MediaFileRow.kind == "playback"
        )
    )
    media = None
    if playback is not None:
        scope: media_urls.Scope = "admin" if viewer.is_admin else "public"
        url, expires = media_urls.signed_url(settings, playback.id, scope)
        media = Media(
            url=url,
            content_type=playback.content_type,
            expires_at=datetime.fromtimestamp(expires, UTC),
        )
    return InterviewDetail.model_validate(
        {
            **to_summary(interview, interviewee, language),
            "interviewer": interview.interviewer,
            "location": interview.location,
            "description": interview.description,
            "consent_note": interview.consent_note,
            "languages": [Language(code=c, name=n) for c, n in languages],
            "media": media,
            "status_detail": interview.status_detail if viewer.is_admin else None,
        }
    )


@router.get("/api/interviews/{interview_id}/segments", response_model=SegmentList)
def list_segments(
    interview_id: uuid.UUID, session: DbSession, viewer: CurrentViewer
) -> SegmentList:
    """The whole transcript in playback order. Original and English text are the edited
    versions where an admin has edited them, otherwise the machine output."""
    _visible_interview(session, viewer, interview_id)
    rows = session.scalars(
        select(SegmentRow).where(SegmentRow.interview_id == interview_id).order_by(SegmentRow.seq)
    )
    return SegmentList(items=[to_segment(s) for s in rows])


@router.get(
    "/api/media/{media_id}",
    response_class=FileResponse,
    responses={403: {"description": "Missing, invalid or expired link"}},
)
def get_media(
    media_id: int,
    session: DbSession,
    settings: SettingsDep,
    expires: Annotated[int, Query()],
    sig: Annotated[str, Query()],
    scope: Annotated[media_urls.Scope, Query()] = "public",
) -> FileResponse:
    """Stream a media file from a link made by the interview detail route. Supports HTTP
    Range requests, so players can seek without downloading the whole file (NF5).

    A visitor's link stops working as soon as its interview is made Private."""
    if not media_urls.is_valid(settings, media_id, expires, scope, sig):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "This media link is invalid or expired")
    query = select(MediaFileRow).where(MediaFileRow.id == media_id)
    if scope == "public":
        query = query.join(InterviewRow, InterviewRow.id == MediaFileRow.interview_id).where(
            visible_to(None)
        )
    media = session.scalar(query)
    if media is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Media not found")
    try:
        with LocalMediaStore(settings.media_root).local_copy(media.storage_key) as path:
            # The link is the permission and it expires, so caches must not share it.
            return FileResponse(
                path, media_type=media.content_type, headers={"Cache-Control": "private"}
            )
    except FileNotFoundError:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Media file is missing") from None
