"""Deleting an interview from the admin page: DELETE /api/interviews/{id}."""

import uuid
from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session
from swayambhu_core.models import (
    ChunkEmbeddingRow,
    IntervieweeRow,
    InterviewLanguageRow,
    InterviewRow,
    JobRow,
    MediaFileRow,
    SearchChunkRow,
    SegmentRow,
)
from swayambhu_core.recordings import interview_prefix

from swayambhu_api import media_urls
from swayambhu_api.admins import Admin
from swayambhu_api.auth import require_admin
from swayambhu_api.config import Settings
from swayambhu_api.main import app
from tests.fakes import as_viewer

pytestmark = pytest.mark.integration

# Every table that holds rows of one interview.
PER_INTERVIEW = (
    SegmentRow,
    SearchChunkRow,
    InterviewLanguageRow,
    JobRow,
    MediaFileRow,
)


def _add_interview(
    session: Session, settings: Settings, *, person: IntervieweeRow | None, visibility: str
) -> uuid.UUID:
    """A processed interview with a corrected line, search entries, jobs and stored files."""
    row = InterviewRow(
        title="Dawn", status="done", translation_status="done", visibility=visibility,
        interviewee_id=person.id if person else None,
    )  # fmt: skip
    session.add(row)
    session.flush()
    chunk = SearchChunkRow(
        interview_id=row.id, chunker="test", first_seq=0, last_seq=1, start_ms=0, end_ms=9_000
    )
    session.add_all(
        [
            SegmentRow(
                interview_id=row.id, seq=0, start_ms=0, end_ms=5_000, language="ne",
                original_machine="पहिलो", original_edited="पहिलो!",
            ),
            SegmentRow(
                interview_id=row.id, seq=1, start_ms=5_000, end_ms=9_000, language="ne",
                original_machine="दोस्रो",
            ),
            InterviewLanguageRow(interview_id=row.id, language_code="ne"),
            JobRow(interview_id=row.id, kind="transcribe", state="done", attempts=1),
            JobRow(interview_id=row.id, kind="index", state="running", attempts=1),
            chunk,
        ]
    )  # fmt: skip
    session.flush()
    session.add(
        ChunkEmbeddingRow(
            chunk_id=chunk.id, model="test", representation="original", embedding=[0.1, 0.2],
            source_hash="h",
        )
    )  # fmt: skip
    folder = settings.media_root / interview_prefix(row.id)
    folder.mkdir(parents=True)
    for kind, name in (("original", "original.mp3"), ("playback", "playback-1.m4a")):
        (folder / name).write_bytes(b"audio")
        session.add(
            MediaFileRow(
                interview_id=row.id, kind=kind, storage_key=f"{interview_prefix(row.id)}/{name}",
                content_type="audio/mpeg", size_bytes=5,
            )
        )  # fmt: skip
    return row.id


@pytest.fixture
def clean(db_session: Session) -> Iterator[None]:
    db_session.execute(delete(InterviewRow))
    db_session.execute(delete(IntervieweeRow))
    db_session.commit()
    yield
    db_session.rollback()
    db_session.execute(delete(InterviewRow))
    db_session.execute(delete(IntervieweeRow))
    db_session.commit()


@pytest.fixture
def admin_client(client: TestClient) -> Iterator[TestClient]:
    admin = Admin(1, "lead@example.org")
    app.dependency_overrides[require_admin] = lambda: admin
    yield as_viewer(client, admin)


def _rows(session: Session, interview_id: uuid.UUID) -> dict[str, int]:
    session.expire_all()
    counts = {
        table.__tablename__: session.scalar(
            select(func.count()).select_from(table).where(table.interview_id == interview_id)
        )
        or 0
        for table in PER_INTERVIEW
    }
    counts["chunk_embeddings"] = session.scalar(select(func.count(ChunkEmbeddingRow.chunk_id))) or 0
    counts["interviews"] = session.scalar(
        select(func.count()).where(InterviewRow.id == interview_id)
    ) or 0  # fmt: skip
    return counts


def test_visitors_cannot_delete(
    client: TestClient, clean: None, db_session: Session, settings: Settings
) -> None:
    interview_id = _add_interview(db_session, settings, person=None, visibility="private")
    db_session.commit()

    res = as_viewer(client).delete(f"/api/interviews/{interview_id}")

    assert res.status_code == 401
    assert _rows(db_session, interview_id)["interviews"] == 1
    assert (settings.media_root / interview_prefix(interview_id)).is_dir()


def test_deleting_removes_every_row_and_file(
    admin_client: TestClient, clean: None, db_session: Session, settings: Settings
) -> None:
    person = IntervieweeRow(display_name="Interviewee A")
    db_session.add(person)
    db_session.flush()
    person_id = person.id
    interview_id = _add_interview(db_session, settings, person=person, visibility="private")
    db_session.commit()
    before = _rows(db_session, interview_id)
    assert all(before.values()), before  # the fixture fills every table

    res = admin_client.delete(f"/api/interviews/{interview_id}")

    assert res.status_code == 204
    assert not any(_rows(db_session, interview_id).values())
    assert not (settings.media_root / interview_prefix(interview_id)).exists()
    # Nobody else named them, so the name goes too.
    assert db_session.get(IntervieweeRow, person_id) is None
    # A second delete finds nothing.
    assert admin_client.delete(f"/api/interviews/{interview_id}").status_code == 404


def test_an_interviewee_in_another_interview_stays(
    admin_client: TestClient, clean: None, db_session: Session, settings: Settings
) -> None:
    person = IntervieweeRow(display_name="Interviewee A")
    db_session.add(person)
    db_session.flush()
    gone = _add_interview(db_session, settings, person=person, visibility="private")
    kept = _add_interview(db_session, settings, person=person, visibility="private")
    db_session.commit()

    assert admin_client.delete(f"/api/interviews/{gone}").status_code == 204

    assert db_session.get(IntervieweeRow, person.id) is not None
    assert all(_rows(db_session, kept).values())
    assert (settings.media_root / interview_prefix(kept)).is_dir()


def test_a_published_interview_is_refused(
    admin_client: TestClient, clean: None, db_session: Session, settings: Settings
) -> None:
    interview_id = _add_interview(db_session, settings, person=None, visibility="public")
    db_session.commit()

    res = admin_client.delete(f"/api/interviews/{interview_id}")

    assert res.status_code == 409
    assert "Unpublish" in res.json()["detail"]
    assert all(_rows(db_session, interview_id).values())
    assert (settings.media_root / interview_prefix(interview_id)).is_dir()


def test_an_unknown_interview_is_not_found(admin_client: TestClient, clean: None) -> None:
    assert admin_client.delete(f"/api/interviews/{uuid.uuid4()}").status_code == 404


def test_missing_files_dont_stop_the_delete(
    admin_client: TestClient, clean: None, db_session: Session, settings: Settings
) -> None:
    interview_id = _add_interview(db_session, settings, person=None, visibility="private")
    db_session.commit()
    for path in (settings.media_root / interview_prefix(interview_id)).iterdir():
        path.unlink()

    assert admin_client.delete(f"/api/interviews/{interview_id}").status_code == 204
    assert _rows(db_session, interview_id)["interviews"] == 0


def test_old_media_links_stop_working(
    admin_client: TestClient, clean: None, db_session: Session, settings: Settings
) -> None:
    interview_id = _add_interview(db_session, settings, person=None, visibility="private")
    db_session.commit()
    playback = db_session.scalar(
        select(MediaFileRow).where(
            MediaFileRow.interview_id == interview_id, MediaFileRow.kind == "playback"
        )
    )
    assert playback is not None
    url, _ = media_urls.signed_url(settings, playback.id, "admin")
    assert admin_client.get(url).status_code == 200

    admin_client.delete(f"/api/interviews/{interview_id}")

    assert admin_client.get(url).status_code == 404
