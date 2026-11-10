import uuid
from collections.abc import Iterator
from datetime import UTC, datetime
from urllib.parse import parse_qs, urlsplit

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete, select
from sqlalchemy.orm import Session
from swayambhu_core.models import (
    IntervieweeRow,
    InterviewLanguageRow,
    InterviewRow,
    MediaFileRow,
    SegmentRow,
)

from swayambhu_api import media_urls
from swayambhu_api.config import Settings
from tests.fakes import ADMIN, as_viewer

pytestmark = pytest.mark.integration

PLAYBACK = b"0123456789" * 100


@pytest.fixture
def interviews(db_session: Session, settings: Settings) -> Iterator[dict[str, InterviewRow]]:
    """One Public and one Private interview, each with two segments and a playback copy."""
    db_session.execute(delete(InterviewRow))
    db_session.execute(delete(IntervieweeRow))
    person = IntervieweeRow(display_name="Maya Shakya")
    db_session.add(person)
    db_session.flush()
    rows = {}
    for day, visibility in enumerate(("public", "private"), start=1):
        interview = InterviewRow(
            created_at=datetime(2026, 10, day, tzinfo=UTC),
            title=f"A {visibility} story",
            visibility=visibility,
            interviewee_id=person.id,
            language_confirmed="ne",
            status_detail="Translating",
            consent_note="Consent recorded on paper",
            duration_ms=20_000,
        )
        db_session.add(interview)
        db_session.flush()
        db_session.add(InterviewLanguageRow(interview_id=interview.id, language_code="ne"))
        db_session.add_all(
            [
                SegmentRow(
                    interview_id=interview.id, seq=1, start_ms=10_000, end_ms=20_000,
                    language="ne", original_machine="दोस्रो", english_machine="Second",
                    english_edited="Second, edited",
                ),
                SegmentRow(
                    interview_id=interview.id, seq=0, start_ms=0, end_ms=10_000,
                    language="ne", original_machine="पहिलो", english_machine="First",
                ),
            ]
        )  # fmt: skip
        key = f"interviews/{interview.id}/playback.m4a"
        (settings.media_root / key).parent.mkdir(parents=True)
        (settings.media_root / key).write_bytes(PLAYBACK)
        db_session.add(
            MediaFileRow(
                interview_id=interview.id, kind="playback", storage_key=key,
                content_type="audio/mp4",
            )
        )  # fmt: skip
        rows[visibility] = interview
    db_session.commit()
    yield rows
    db_session.rollback()
    db_session.execute(delete(InterviewRow))
    db_session.execute(delete(IntervieweeRow))
    db_session.commit()


def test_listing_shows_visitors_public_interviews_and_admins_all_newest_first(
    client: TestClient, interviews: dict[str, InterviewRow]
) -> None:
    public, private = str(interviews["public"].id), str(interviews["private"].id)
    body = as_viewer(client).get("/api/interviews").json()
    assert ([i["id"] for i in body["items"]], body["total"]) == ([public], 1)
    assert body["items"][0]["interviewee"] == "Maya Shakya"
    assert body["items"][0]["primary_language"] == {"code": "ne", "name": "Nepali"}

    pages = [as_viewer(client, ADMIN).get(f"/api/interviews?limit=1&offset={n}") for n in (0, 1)]
    assert [(p.json()["items"][0]["id"], p.json()["total"]) for p in pages] == [
        (private, 2), (public, 2),
    ]  # fmt: skip


@pytest.mark.parametrize("suffix", ["", "/segments"])
def test_private_and_unknown_interviews_are_404_for_visitors(
    client: TestClient, interviews: dict[str, InterviewRow], suffix: str
) -> None:
    for interview_id in (interviews["private"].id, uuid.uuid4()):
        res = as_viewer(client).get(f"/api/interviews/{interview_id}{suffix}")
        assert (res.status_code, res.json()) == (404, {"detail": "Interview not found"})


def test_detail_and_transcript_of_a_public_interview(
    client: TestClient, interviews: dict[str, InterviewRow]
) -> None:
    path = f"/api/interviews/{interviews['public'].id}"
    detail = as_viewer(client).get(path).json()
    admin_only = ("status_detail", "consent_note", "language_detected", "language_confirmed")
    assert [detail[k] for k in admin_only] == [None, None, None, None]
    assert detail["interviewee_id"] == interviews["public"].interviewee_id
    assert detail["languages"] == [{"code": "ne", "name": "Nepali"}]
    assert detail["media"]["content_type"] == "audio/mp4"
    as_admin = as_viewer(client, ADMIN).get(path).json()
    assert [as_admin[k] for k in admin_only] == [
        "Translating", "Consent recorded on paper", None, "ne",
    ]  # fmt: skip

    segments = as_viewer(client).get(f"{path}/segments").json()["items"]
    assert [
        (s["seq"], s["original_text"], s["english_text"], s["original_edited"], s["english_edited"])
        for s in segments
    ] == [(0, "पहिलो", "First", False, False), (1, "दोस्रो", "Second, edited", False, True)]


def test_media_links_stream_with_ranges_and_refuse_tampering(
    client: TestClient, interviews: dict[str, InterviewRow], settings: Settings
) -> None:
    anonymous = as_viewer(client)
    url = anonymous.get(f"/api/interviews/{interviews['public'].id}").json()["media"]["url"]
    res = anonymous.get(url)
    assert (res.status_code, res.content) == (200, PLAYBACK)
    assert (res.headers["content-type"], res.headers["accept-ranges"]) == ("audio/mp4", "bytes")
    res = anonymous.get(url, headers={"Range": "bytes=10-19"})
    assert (res.status_code, res.content) == (206, PLAYBACK[10:20])

    media_id = int(urlsplit(url).path.rsplit("/", 1)[1])
    query = {k: v[0] for k, v in parse_qs(urlsplit(url).query).items()}
    expires, sig = query["expires"], query["sig"]
    assert query["scope"] == "public"

    def status(
        media: int, exp: int | str, signature: str | None = None, scope: str = "public"
    ) -> int:
        signature = signature or media_urls._signature(settings, media, int(exp), scope)  # type: ignore[arg-type]
        path = f"/api/media/{media}?expires={exp}&scope={scope}&sig={signature}"
        return anonymous.get(path).status_code

    assert status(media_id + 1, expires, sig) == 403  # another file
    assert status(media_id, int(expires) + 3600, sig) == 403  # a later expiry
    assert status(media_id, expires, sig, scope="admin") == 403  # an admin's link
    assert status(media_id, expires, "0" * 64) == 403
    expired = media_urls.signed_url(settings, media_id, "public", now=0)[1]
    assert status(media_id, expired) == 403
    assert status(media_id + 10**6, expires) == 404  # no such media
    assert anonymous.get(f"/api/media/{media_id}").status_code == 422
    for path in settings.media_root.rglob("*.m4a"):
        path.unlink()
    assert anonymous.get(url).status_code == 404  # file gone from the volume


def test_hiding_an_interview_stops_visitor_media_links_at_once(
    client: TestClient, interviews: dict[str, InterviewRow], db_session: Session
) -> None:
    path = f"/api/interviews/{interviews['public'].id}"
    visitor_url = as_viewer(client).get(path).json()["media"]["url"]
    admin_url = as_viewer(client, ADMIN).get(path).json()["media"]["url"]
    assert "scope=admin" in admin_url

    interviews["public"].visibility = "private"
    db_session.commit()
    anonymous = as_viewer(client)
    assert anonymous.get(visitor_url).status_code == 404  # same answer as no such media
    assert anonymous.get(admin_url).status_code == 200  # admins can play Private interviews


def test_a_visitor_link_to_a_private_interviews_media_is_refused(
    client: TestClient, interviews: dict[str, InterviewRow], db_session: Session, settings: Settings
) -> None:
    """Even a correctly signed visitor link can't reach a Private interview's media."""
    media_id = db_session.scalar(
        select(MediaFileRow.id).where(MediaFileRow.interview_id == interviews["private"].id)
    )
    assert media_id is not None
    url, _ = media_urls.signed_url(settings, media_id, "public")
    assert as_viewer(client).get(url).status_code == 404


def test_visibility_filter_never_shows_visitors_private_interviews(
    client: TestClient, interviews: dict[str, InterviewRow]
) -> None:
    body = as_viewer(client).get("/api/interviews?visibility=private").json()
    assert (body["items"], body["total"]) == ([], 0)
    public = as_viewer(client).get("/api/interviews?visibility=public").json()
    assert str(interviews["private"].id) not in {i["id"] for i in public["items"]}
    assert as_viewer(client).get("/api/interviews?visibility=restricted").status_code == 422


def test_status_filter_never_shows_visitors_private_interviews(
    client: TestClient, interviews: dict[str, InterviewRow]
) -> None:
    for state in ("processing", "done", "failed"):
        body = as_viewer(client).get(f"/api/interviews?status={state}").json()
        assert str(interviews["private"].id) not in {i["id"] for i in body["items"]}
        assert body["total"] <= 1
