"""Metadata filters shared by search and the interview list (Proposal: parameter names).

Each filter only narrows a query that already applies `visible_to`, so no filter can widen
what a viewer may see.
"""

from datetime import date
from typing import Annotated, Literal

from fastapi import Depends, Query
from sqlalchemy import TIMESTAMP, ColumnElement, Date, and_, cast, exists, func, literal, or_
from swayambhu_core.models import InterviewLanguageRow, InterviewRow, MediaFileRow

MediaType = Literal["audio", "video"]


def interview_filters(
    language: Annotated[str | None, Query(description="Any language heard, e.g. ne")] = None,
    interviewee: Annotated[
        int | Literal["unknown"] | None, Query(description="An interviewee id, or unknown")
    ] = None,
    recorded_from: date | None = None,
    recorded_to: date | None = None,
    undated: Annotated[
        bool, Query(description="With a date range, also include undated interviews")
    ] = False,
    media: Annotated[
        MediaType | None, Query(description="audio or video, from the uploaded file's type")
    ] = None,
) -> list[ColumnElement[bool]]:
    where: list[ColumnElement[bool]] = []
    if language:
        # Any language heard, so a mixed-language recording matches each of its languages.
        where.append(
            exists().where(
                InterviewLanguageRow.interview_id == InterviewRow.id,
                InterviewLanguageRow.language_code == language,
            )
        )
    if interviewee == "unknown":
        where.append(InterviewRow.interviewee_id.is_(None))
    elif interviewee is not None:
        where.append(InterviewRow.interviewee_id == interviewee)
    if recorded_from or recorded_to:
        # recorded_on is the first day of a year, month or day; match if that period overlaps.
        dated: list[ColumnElement[bool]] = [InterviewRow.recorded_on.is_not(None)]
        if recorded_to:
            dated.append(InterviewRow.recorded_on <= recorded_to)
        if recorded_from:
            start = func.date_trunc(
                InterviewRow.recorded_on_precision, cast(literal(recorded_from), TIMESTAMP)
            )
            dated.append(InterviewRow.recorded_on >= cast(start, Date))
        where.append(
            or_(and_(*dated), InterviewRow.recorded_on.is_(None)) if undated else and_(*dated)
        )
    if media:
        # The type the browser reported for the upload, e.g. video/mp4 or audio/mpeg.
        where.append(
            exists().where(
                MediaFileRow.interview_id == InterviewRow.id,
                MediaFileRow.kind == "original",
                MediaFileRow.content_type.startswith(f"{media}/"),
            )
        )
    return where


InterviewFilters = Annotated[list[ColumnElement[bool]], Depends(interview_filters)]
