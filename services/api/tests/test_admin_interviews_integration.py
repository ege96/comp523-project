import base64
import uuid
from collections.abc import Iterator
from datetime import date
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from httpx2 import Response
from sqlalchemy import delete, select
from sqlalchemy.orm import Session
from swayambhu_core.models import (
    AdminRow,
    IntervieweeRow,
    InterviewRow,
    JobRow,
    MediaFileRow,
)

from swayambhu_api import uploads
from swayambhu_api.admins import Admin
from swayambhu_api.auth import Viewer, get_viewer, require_admin
from swayambhu_api.config import Settings, get_settings
from swayambhu_api.main import app

RECORDING = bytes(range(256)) * 400  # 100 KiB
TUS = {"Tus-Resumable": "1.0.0"}


@pytest.fixture
def settings(tmp_path: Path) -> Iterator[Settings]:
    settings = Settings(
        media_root=tmp_path, max_upload_bytes=2 * len(RECORDING), upload_chunk_max_bytes=60_000
    )
    original = uploads.storage.files_dir
    uploads.storage.files_dir = str(uploads.uploads_dir(settings))
    yield settings
    uploads.storage.files_dir = original


@pytest.fixture
def client(settings: Settings) -> Iterator[TestClient]:
    app.dependency_overrides[get_settings] = lambda: settings
    yield TestClient(app)
    app.dependency_overrides.clear()


def metadata(**values: str) -> str:
    values = {"filename": "dawn.mp3", **values}
    return ",".join(f"{k} {base64.b64encode(v.encode()).decode()}" for k, v in values.items())


def create(client: TestClient) -> Response:
    meta = metadata(title="Dawn", filetype="audio/mpeg")
    return client.post(
        "/api/uploads",
        headers={**TUS, "Upload-Length": str(len(RECORDING)), "Upload-Metadata": meta},
    )


def send(client: TestClient, location: str, offset: int, chunk: bytes) -> Response:
    return client.patch(
        location,
        content=chunk,
        headers={**TUS, "Upload-Offset": str(offset),
                 "Content-Type": "application/offset+octet-stream"},
    )  # fmt: skip


@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("POST", "/api/uploads"),
        ("HEAD", "/api/uploads/0123456789abcdef0123456789abcdef"),
        ("PATCH", "/api/uploads/0123456789abcdef0123456789abcdef"),
        ("DELETE", "/api/uploads/0123456789abcdef0123456789abcdef"),
        ("PATCH", f"/api/interviews/{uuid.uuid4()}"),
        ("GET", f"/api/interviews/{uuid.uuid4()}/jobs"),
    ],
)
def test_anonymous_visitors_are_refused(
    client: TestClient, settings: Settings, method: str, path: str
) -> None:
    headers = {
        **TUS, "Upload-Length": "5", "Upload-Offset": "0",
        "Upload-Metadata": metadata(title="x", filetype="audio/mpeg"),
        "Content-Type": "application/offset+octet-stream",
    }  # fmt: skip
    body = b'{"visibility": "public"}' if path.startswith("/api/interviews") else b"audio"
    res = client.request(method, path, content=body, headers=headers)
    assert res.status_code == 401
    assert not settings.media_root.exists() or not any(settings.media_root.rglob("*"))


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
def test_resumed_upload_queues_processing_and_publishing_shows_it_to_visitors(
    client: TestClient, admin: Admin, settings: Settings, db_session: Session
) -> None:
    meta = metadata(
        title=" स्वयम्भूको बिहान ", filetype="audio/mpeg", filename="Dawn.MP3", language="ne",
        interviewee_name="Maya Shakya", recorded_on="2019-05",
    )  # fmt: skip
    res = client.post(
        "/api/uploads",
        headers={**TUS, "Upload-Length": str(len(RECORDING)), "Upload-Metadata": meta},
    )
    assert res.status_code == 201, res.text
    location = res.headers["location"]

    # The first chunk arrives, the connection drops, and the client asks where to resume.
    assert send(client, location, 0, RECORDING[:50_000]).status_code == 204
    assert client.head(location, headers=TUS).headers["upload-offset"] == "50000"
    assert send(client, location, 0, RECORDING[:50_000]).status_code == 409  # stale offset
    assert db_session.scalars(select(InterviewRow)).all() == []  # nothing until it's whole
    res = send(client, location, 50_000, RECORDING[50_000:])
    assert res.status_code == 204, res.text
    interview_id = uuid.UUID(res.headers[uploads.INTERVIEW_ID_HEADER])

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
    assert (settings.media_root / key).read_bytes() == RECORDING
    leftovers = [p.name for p in uploads.uploads_dir(settings).iterdir() if p.is_file()]
    assert leftovers == []  # moved into place, sidecar removed

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
    unknown = f"/api/interviews/{uuid.uuid4()}"
    assert client.patch(unknown, json={"visibility": "public"}).status_code == 404


@pytest.mark.integration
@pytest.mark.parametrize(
    ("meta", "headers", "expected"),
    [
        ({"filetype": "text/plain"}, {}, 422),
        ({"filename": ""}, {}, 422),
        ({"title": " "}, {}, 422),
        ({"language": "fr"}, {}, 422),
        ({"interviewee_id": "1", "interviewee_name": "A"}, {}, 422),
        ({"interviewee_id": "1000000000"}, {}, 422),
        ({"recorded_on": "2024-02-30"}, {}, 422),
        ({}, {"Upload-Length": str(3 * len(RECORDING))}, 413),
        ({}, {"Upload-Length": "0"}, 400),
        ({}, {"Upload-Defer-Length": "1", "Upload-Length": ""}, 400),
        ({}, {"Upload-Concat": "partial"}, 400),
    ],
)
def test_bad_uploads_are_refused_before_any_bytes_arrive(
    client: TestClient,
    admin: Admin,
    settings: Settings,
    meta: dict[str, str],
    headers: dict[str, str],
    expected: int,
) -> None:
    headers = {
        **TUS, "Upload-Length": str(len(RECORDING)),
        "Upload-Metadata": metadata(**{"title": "Dawn", "filetype": "audio/mpeg", **meta}),
        **headers,
    }  # fmt: skip
    res = client.post("/api/uploads", headers={k: v for k, v in headers.items() if v})
    assert res.status_code == expected, res.text
    assert not uploads.uploads_dir(settings).exists()


@pytest.mark.integration
def test_oversized_chunks_and_bodies_on_create_are_refused(
    client: TestClient, admin: Admin, db_session: Session
) -> None:
    with_body = client.post(
        "/api/uploads",
        content=RECORDING[:10],
        headers={**TUS, "Upload-Length": "10",
                 "Upload-Metadata": metadata(title="Dawn", filetype="audio/mpeg")},
    )  # fmt: skip
    assert with_body.status_code == 400  # creation-with-upload would read it all into memory
    location = create(client).headers["location"]
    assert send(client, location, 0, RECORDING[:70_000]).status_code == 413  # over 60 000
    assert client.head(location, headers=TUS).headers["upload-offset"] == "0"
    assert client.delete(location, headers=TUS).status_code == 204
    assert db_session.scalars(select(JobRow)).all() == []
