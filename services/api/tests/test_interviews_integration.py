import uuid
from collections.abc import Iterator
from datetime import UTC, datetime
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete
from sqlalchemy.orm import Session
from swayambhu_core.models import (
    IntervieweeRow,
    InterviewLanguageRow,
    InterviewRow,
    MediaFileRow,
    SegmentRow,
)

from swayambhu_api import media_urls
from swayambhu_api.admins import Admin
from swayambhu_api.auth import Viewer, get_viewer
from swayambhu_api.config import Settings, get_settings
from swayambhu_api.main import app

pytestmark = pytest.mark.integration

PLAYBACK = b"0123456789" * 100


@pytest.fixture
def settings(integration_settings: Settings, tmp_path: Path) -> Settings:
    return integration_settings.model_copy(
        update={"media_root": tmp_path, "media_url_secret": None}
    )


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


@pytest.fixture
def client(settings: Settings) -> Iterator[TestClient]:
    app.dependency_overrides[get_settings] = lambda: settings
    yield TestClient(app)
    app.dependency_overrides.clear()


def as_viewer(client: TestClient, admin: Admin | None) -> TestClient:
    """Requests from `client` now come from `admin`, or an anonymous visitor."""
    app.dependency_overrides[get_viewer] = lambda: Viewer(admin=admin)
    return client


@pytest.fixture
def anonymous(client: TestClient) -> TestClient:
    return as_viewer(client, None)


@pytest.fixture
def admin(client: TestClient) -> TestClient:
    return as_viewer(client, Admin(1, "lead@example.org"))


def test_visitors_list_only_public_interviews(
    anonymous: TestClient, interviews: dict[str, InterviewRow]
) -> None:
    body = anonymous.get("/api/interviews").json()
    assert body["total"] == 1
    [item] = body["items"]
    assert item["id"] == str(interviews["public"].id)
    assert item["interviewee"] == "Maya Shakya"
    assert item["primary_language"] == {"code": "ne", "name": "Nepali"}


def test_admins_list_everything_newest_first(
    admin: TestClient, interviews: dict[str, InterviewRow]
) -> None:
    body = admin.get("/api/interviews", params={"limit": 1}).json()
    assert body["total"] == 2
    assert [i["id"] for i in body["items"]] == [str(interviews["private"].id)]
    body = admin.get("/api/interviews", params={"limit": 1, "offset": 1}).json()
    assert [i["id"] for i in body["items"]] == [str(interviews["public"].id)]


@pytest.mark.parametrize("suffix", ["", "/segments"])
def test_private_and_unknown_interviews_are_404_for_visitors(
    anonymous: TestClient, interviews: dict[str, InterviewRow], suffix: str
) -> None:
    for interview_id in (interviews["private"].id, uuid.uuid4()):
        res = anonymous.get(f"/api/interviews/{interview_id}{suffix}")
        assert res.status_code == 404
        assert res.json() == {"detail": "Interview not found"}


def test_detail_hides_status_detail_from_visitors(
    client: TestClient, interviews: dict[str, InterviewRow]
) -> None:
    path = f"/api/interviews/{interviews['public'].id}"
    visitor = as_viewer(client, None).get(path).json()
    assert visitor["status_detail"] is None
    assert visitor["languages"] == [{"code": "ne", "name": "Nepali"}]
    assert visitor["media"]["content_type"] == "audio/mp4"
    admin = as_viewer(client, Admin(1, "lead@example.org"))
    assert admin.get(path).json()["status_detail"] == "Translating"


def test_segments_are_in_order_with_edits_marked(
    anonymous: TestClient, interviews: dict[str, InterviewRow]
) -> None:
    items = anonymous.get(f"/api/interviews/{interviews['public'].id}/segments").json()["items"]
    assert [(s["seq"], s["original_text"], s["english_text"]) for s in items] == [
        (0, "पहिलो", "First"),
        (1, "दोस्रो", "Second, edited"),
    ]
    assert [(s["original_edited"], s["english_edited"]) for s in items] == [
        (False, False),
        (False, True),
    ]


def media_url(client: TestClient, interview: InterviewRow) -> str:
    url: str = client.get(f"/api/interviews/{interview.id}").json()["media"]["url"]
    return url


def test_signed_media_link_streams_with_range_support(
    anonymous: TestClient, interviews: dict[str, InterviewRow]
) -> None:
    url = media_url(anonymous, interviews["public"])
    res = anonymous.get(url)
    assert res.status_code == 200
    assert res.content == PLAYBACK
    assert res.headers["content-type"] == "audio/mp4"
    assert res.headers["accept-ranges"] == "bytes"

    res = anonymous.get(url, headers={"Range": "bytes=10-19"})
    assert res.status_code == 206
    assert res.content == PLAYBACK[10:20]


def test_tampered_or_expired_media_links_are_refused(
    anonymous: TestClient, interviews: dict[str, InterviewRow], settings: Settings
) -> None:
    url = media_url(anonymous, interviews["public"])
    query = parse_qs(urlsplit(url).query)
    media_id = int(urlsplit(url).path.rsplit("/", 1)[1])
    expires, sig = int(query["expires"][0]), query["sig"][0]

    def get(media: int, exp: int, signature: str) -> int:
        res = anonymous.get(f"/api/media/{media}", params={"expires": exp, "sig": signature})
        return res.status_code

    assert get(media_id, expires, sig) == 200
    assert get(media_id + 1, expires, sig) == 403  # another file
    assert get(media_id, expires + 3600, sig) == 403  # a later expiry
    assert get(media_id, expires, "0" * 64) == 403
    assert anonymous.get(f"/api/media/{media_id}").status_code == 422

    assert (
        get(media_id + 10**6, expires, media_urls._signature(settings, media_id + 10**6, expires))
        == 404
    )

    _, past = media_urls.signed_url(settings, media_id, now=0)
    assert get(media_id, past, media_urls._signature(settings, media_id, past)) == 403


def test_media_link_to_a_missing_file_is_404(
    anonymous: TestClient, interviews: dict[str, InterviewRow], settings: Settings
) -> None:
    url = media_url(anonymous, interviews["public"])
    for path in settings.media_root.rglob("*.m4a"):
        path.unlink()
    assert anonymous.get(url).status_code == 404
