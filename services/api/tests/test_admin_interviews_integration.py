import hashlib
import uuid
from collections.abc import Iterator
from datetime import date
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete, select
from sqlalchemy.orm import Session
from swayambhu_core.models import (
    AdminRow,
    IntervieweeRow,
    InterviewRow,
    JobRow,
    MediaFileRow,
)

from swayambhu_api.admins import Admin
from swayambhu_api.auth import Viewer, get_viewer, require_admin
from swayambhu_api.config import Settings, get_settings
from swayambhu_api.main import app

RECORDING = bytes(range(256)) * 6000  # ~1.5 MiB: more than one buffered disk write


@pytest.fixture
def settings(tmp_path: Path) -> Settings:
    return Settings(media_root=tmp_path, max_upload_bytes=2 * len(RECORDING))


@pytest.fixture
def client(settings: Settings) -> Iterator[TestClient]:
    app.dependency_overrides[get_settings] = lambda: settings
    yield TestClient(app)
    app.dependency_overrides.clear()


@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("POST", "/api/interviews?title=x"),
        ("PATCH", f"/api/interviews/{uuid.uuid4()}"),
        ("GET", f"/api/interviews/{uuid.uuid4()}/jobs"),
    ],
)
def test_anonymous_visitors_are_refused(
    client: TestClient, settings: Settings, method: str, path: str
) -> None:
    res = client.request(
        method, path, content=b"audio", headers={"Content-Type": "audio/mpeg"},
        json={"visibility": "public"} if method == "PATCH" else None,
    )  # fmt: skip
    assert (res.status_code, res.json()) == (401, {"detail": "Sign-in required"})
    assert not any(settings.media_root.iterdir())


@pytest.fixture
def admin(db_session: Session, client: TestClient) -> Iterator[Admin]:
    """Requests from `client` come from a signed-in admin; the tables start empty."""
    for table in (InterviewRow, IntervieweeRow, AdminRow):
        db_session.execute(delete(table))
    row = AdminRow(email="lead@example.org")
    db_session.add(row)
    db_session.commit()
    signed_in = Admin(row.id, row.email)
    app.dependency_overrides[require_admin] = lambda: signed_in
    yield signed_in
    db_session.rollback()
    for table in (InterviewRow, IntervieweeRow, AdminRow):
        db_session.execute(delete(table))
    db_session.commit()


@pytest.mark.integration
def test_upload_queues_processing_and_publishing_shows_it_to_visitors(
    client: TestClient, admin: Admin, settings: Settings, db_session: Session
) -> None:
    res = client.post(
        "/api/interviews",
        params={"title": " स्वयम्भूको बिहान ", "filename": "Dawn.MP3", "language": "ne",
                "interviewee_name": "Maya Shakya", "recorded_on": "2019-05"},
        content=RECORDING,
        headers={"Content-Type": "audio/mpeg"},
    )  # fmt: skip
    assert res.status_code == 201, res.text
    interview_id = uuid.UUID(res.json()["id"])
    assert res.headers["location"] == f"/api/interviews/{interview_id}"

    interview = db_session.get(InterviewRow, interview_id)
    assert interview is not None
    assert (interview.title, interview.language_confirmed, interview.visibility) == (
        "स्वयम्भूको बिहान", "ne", "private",
    )  # fmt: skip
    assert (interview.recorded_on, interview.recorded_on_precision) == (date(2019, 5, 1), "month")
    assert (interview.status, interview.created_by) == ("processing", admin.id)
    media = db_session.scalars(select(MediaFileRow)).one()
    key = f"interviews/{interview_id}/original.mp3"
    assert (media.storage_key, media.content_type, media.size_bytes) == (
        key, "audio/mpeg", len(RECORDING),
    )  # fmt: skip
    assert media.sha256 == hashlib.sha256(RECORDING).hexdigest()
    assert (settings.media_root / key).read_bytes() == RECORDING

    jobs = client.get(f"/api/interviews/{interview_id}/jobs").json()["items"]
    assert [(j["kind"], j["state"], j["attempts"]) for j in jobs] == [
        ("transcribe", "queued", 0), ("playback", "queued", 0),
    ]  # fmt: skip
    assert client.get(f"/api/interviews/{uuid.uuid4()}/jobs").status_code == 404

    # Admins can list what's processing; visitors see nothing until it's published (D-008).
    app.dependency_overrides[get_viewer] = lambda: Viewer(admin=admin)
    assert client.get("/api/interviews?status=processing").json()["total"] == 1
    assert client.get("/api/interviews?status=reviewed").json()["total"] == 0
    app.dependency_overrides[get_viewer] = lambda: Viewer(admin=None)
    path = f"/api/interviews/{interview_id}"
    assert client.get(path).status_code == 404
    assert client.patch(path, json={"visibility": "public"}).status_code == 204
    assert client.get(path).json()["interviewee"] == "Maya Shakya"
    assert client.patch(path, json={"visibility": "private"}).status_code == 204
    assert client.get(path).status_code == 404
    assert client.patch(path, json={"visibility": "restricted"}).status_code == 422
    assert (
        client.patch(f"/api/interviews/{uuid.uuid4()}", json={"visibility": "public"}).status_code
        == 404
    )


def _chunks() -> Iterator[bytes]:
    """A body with no Content-Length, so only counting while streaming can catch its size."""
    yield from (RECORDING, RECORDING, b"one byte too many")


@pytest.mark.integration
@pytest.mark.parametrize(
    ("params", "content_type", "body", "expected"),
    [
        ({"title": "x"}, "text/plain", RECORDING, 415),
        ({"title": "x"}, "audio/wav", RECORDING * 3, 413),
        ({"title": "x"}, "audio/wav", _chunks, 413),
        ({"title": "x"}, "audio/wav", b"", 400),
        ({"title": " "}, "audio/wav", RECORDING, 422),
        ({"title": "x", "language": "fr"}, "audio/wav", RECORDING, 422),
        ({"title": "x", "interviewee_id": 1, "interviewee_name": "A"}, "audio/wav", RECORDING, 422),
        ({"title": "x", "interviewee_id": 10**9}, "audio/wav", RECORDING, 422),
        ({"title": "x", "recorded_on": "2024-02-30"}, "audio/wav", RECORDING, 422),
    ],
)
def test_refused_uploads_leave_nothing_behind(
    client: TestClient,
    admin: Admin,
    settings: Settings,
    db_session: Session,
    params: dict[str, object],
    content_type: str,
    body: object,
    expected: int,
) -> None:
    content = body() if callable(body) else body
    res = client.post(
        "/api/interviews", params=params, content=content, headers={"Content-Type": content_type}
    )
    assert res.status_code == expected, res.text
    assert db_session.scalars(select(InterviewRow)).all() == []
    assert db_session.scalars(select(JobRow)).all() == []
    assert list(settings.media_root.rglob("*.*")) == []
