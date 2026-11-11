"""An uploaded interview is filed under its confirmed language from the start, so the
language filter finds it as soon as it is published, whatever its processing does."""

import base64
import uuid
from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete, update
from sqlalchemy.orm import Session
from swayambhu_core.models import AdminRow, IntervieweeRow, InterviewRow

from swayambhu_api import uploads
from swayambhu_api.admins import Admin
from swayambhu_api.auth import Viewer, get_viewer, require_admin
from swayambhu_api.config import Settings, get_settings
from swayambhu_api.main import app

pytestmark = pytest.mark.integration

RECORDING = bytes(range(256)) * 40
TUS = {"Tus-Resumable": "1.0.0"}


@pytest.fixture
def settings(tmp_path: Path) -> Iterator[Settings]:
    settings = Settings(media_root=tmp_path)
    original = uploads.storage.files_dir
    uploads.storage.files_dir = str(uploads.uploads_dir(settings))
    yield settings
    uploads.storage.files_dir = original


@pytest.fixture
def client(settings: Settings, db_session: Session) -> Iterator[TestClient]:
    for table in (InterviewRow, IntervieweeRow, AdminRow):
        db_session.execute(delete(table))
    row = AdminRow(email="lead@example.org")
    db_session.add(row)
    db_session.commit()
    admin = Admin(row.id, row.email)
    app.dependency_overrides[get_settings] = lambda: settings
    app.dependency_overrides[require_admin] = lambda: admin
    app.dependency_overrides[get_viewer] = lambda: Viewer(admin=None)  # visitors read
    yield TestClient(app)
    app.dependency_overrides.clear()
    db_session.rollback()
    for table in (InterviewRow, IntervieweeRow, AdminRow):
        db_session.execute(delete(table))
    db_session.commit()


def upload(client: TestClient, language: str) -> uuid.UUID:
    values = {"filename": "dawn.mp3", "title": "Dawn", "filetype": "audio/mpeg"}
    meta = ",".join(
        f"{k} {base64.b64encode(v.encode()).decode()}"
        for k, v in {**values, "language": language}.items()
    )
    res = client.post(
        "/api/uploads",
        headers={**TUS, "Upload-Length": str(len(RECORDING)), "Upload-Metadata": meta},
    )
    assert res.status_code == 201, res.text
    res = client.patch(
        res.headers["location"],
        content=RECORDING,
        headers={**TUS, "Upload-Offset": "0", "Content-Type": "application/offset+octet-stream"},
    )
    assert res.status_code == 204, res.text
    return uuid.UUID(res.headers[uploads.INTERVIEW_ID_HEADER])


def nepali_listing(client: TestClient) -> tuple[list[str], list[str]]:
    """The ids listed under Nepali, and the languages offered as filters."""
    items = client.get("/api/interviews?language=ne").json()["items"]
    languages = client.get("/api/search/filters").json()["languages"]
    return [i["id"] for i in items], [language["code"] for language in languages]


def test_an_upload_is_found_by_its_confirmed_language_once_published(
    client: TestClient, db_session: Session
) -> None:
    interview_id = upload(client, "ne")
    assert nepali_listing(client) == ([], [])  # Private: visitors see nothing

    path = f"/api/interviews/{interview_id}"
    assert client.patch(path, json={"visibility": "public"}).status_code == 204
    assert nepali_listing(client) == ([str(interview_id)], ["ne"])

    # The worker gives up on transcribing: still filed under the language the admin chose.
    db_session.execute(
        update(InterviewRow)
        .where(InterviewRow.id == interview_id)
        .values(status="failed", status_detail="Transcription failed.")
    )
    db_session.commit()
    assert nepali_listing(client) == ([str(interview_id)], ["ne"])

    # A corrected language moves it.
    assert client.patch(path, json={"language": "new"}).status_code == 204
    assert nepali_listing(client) == ([], ["new"])
