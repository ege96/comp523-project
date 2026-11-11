"""Running a processing step again from the admin page: POST /api/interviews/{id}/rerun."""

import uuid
from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete, func, select, update
from sqlalchemy.orm import Session
from swayambhu_core.models import (
    AdminRow,
    InterviewLanguageRow,
    InterviewRow,
    JobRow,
    SegmentRow,
)

from swayambhu_api.admins import Admin
from swayambhu_api.auth import require_admin
from swayambhu_api.main import app
from tests.fakes import as_viewer

pytestmark = pytest.mark.integration


@pytest.fixture
def interview(db_session: Session) -> Iterator[InterviewRow]:
    """A Private interview whose translation failed, with a Nepali and an English line."""
    db_session.execute(delete(InterviewRow))
    db_session.execute(delete(AdminRow))
    row = InterviewRow(
        title="Dawn", status="done", translation_status="failed",
        status_detail="Translation failed: boom", language_detected="ne",
    )  # fmt: skip
    db_session.add(row)
    db_session.flush()
    db_session.add_all(
        [
            SegmentRow(
                interview_id=row.id, seq=0, start_ms=0, end_ms=5_000, language="ne",
                original_machine="पहिलो",
            ),
            SegmentRow(
                interview_id=row.id, seq=1, start_ms=5_000, end_ms=9_000, language="en",
                original_machine="the stupa",
            ),
            InterviewLanguageRow(interview_id=row.id, language_code="ne"),
            InterviewLanguageRow(interview_id=row.id, language_code="en"),
            JobRow(interview_id=row.id, kind="translate", state="failed", attempts=3),
        ]
    )  # fmt: skip
    db_session.commit()
    yield row
    db_session.rollback()
    db_session.execute(delete(InterviewRow))
    db_session.commit()


@pytest.fixture
def admin_client(client: TestClient) -> Iterator[TestClient]:
    admin = Admin(1, "lead@example.org")
    app.dependency_overrides[require_admin] = lambda: admin
    yield as_viewer(client, admin)


def _queued(db_session: Session, interview: InterviewRow) -> list[str]:
    db_session.expire_all()
    return sorted(
        db_session.scalars(
            select(JobRow.kind).where(JobRow.interview_id == interview.id, JobRow.state == "queued")
        )
    )


def test_visitors_cannot_rerun_steps(
    client: TestClient, interview: InterviewRow, db_session: Session
) -> None:
    for step in ("transcribe", "translate", "index", "playback"):
        res = as_viewer(client).post(
            f"/api/interviews/{interview.id}/rerun",
            json={"step": step, "replace_corrections": True},
        )
        assert res.status_code == 401
    assert _queued(db_session, interview) == []


def test_retrying_a_failed_translation_uses_the_corrected_language(
    admin_client: TestClient, interview: InterviewRow, db_session: Session
) -> None:
    path = f"/api/interviews/{interview.id}"
    assert admin_client.patch(path, json={"language": "new"}).status_code == 204
    res = admin_client.post(f"{path}/rerun", json={"step": "translate"})
    assert res.status_code == 202, res.text
    assert _queued(db_session, interview) == ["translate"]
    stored = db_session.get_one(InterviewRow, interview.id)
    assert (stored.status, stored.translation_status, stored.status_detail) == (
        "processing", "pending", "Waiting to translate",
    )  # fmt: skip
    # The Nepali-looking line is now Nepal Bhasa, the English line stays English.
    lines = db_session.scalars(
        select(SegmentRow.language).where(SegmentRow.interview_id == interview.id)
        .order_by(SegmentRow.seq)
    ).all()  # fmt: skip
    assert lines == ["new", "en"]
    languages = db_session.scalars(
        select(InterviewLanguageRow.language_code)
        .where(InterviewLanguageRow.interview_id == interview.id)
        .order_by(InterviewLanguageRow.language_code)
    ).all()
    assert languages == ["en", "new"]

    # Asking again while it waits does nothing.
    res = admin_client.post(f"{path}/rerun", json={"step": "translate"})
    assert res.status_code == 409


def test_transcribing_again_asks_before_replacing_corrections(
    admin_client: TestClient, interview: InterviewRow, db_session: Session
) -> None:
    path = f"/api/interviews/{interview.id}/rerun"
    db_session.execute(
        update(SegmentRow)
        .where(SegmentRow.interview_id == interview.id, SegmentRow.seq == 0)
        .values(original_edited="सच्याइएको", edited_at=func.now())
    )
    db_session.commit()

    res = admin_client.post(path, json={"step": "transcribe"})
    assert res.status_code == 409
    assert res.json()["detail"]["corrected_lines"] == 1
    assert _queued(db_session, interview) == []

    res = admin_client.post(path, json={"step": "transcribe", "replace_corrections": True})
    assert res.status_code == 202, res.text
    assert _queued(db_session, interview) == ["retranscribe"]
    stored = db_session.get_one(InterviewRow, interview.id)
    assert (stored.status, stored.status_detail) == ("processing", "Waiting to transcribe")
    assert admin_client.post(path, json={"step": "transcribe"}).status_code == 409  # waiting
    # A correction saved now would be replaced, so it is refused until transcription ends.
    line = f"/api/interviews/{interview.id}/segments/0"
    assert admin_client.patch(line, json={"original_text": "नयाँ"}).status_code == 409


def test_other_steps_and_refusals(
    admin_client: TestClient, interview: InterviewRow, db_session: Session
) -> None:
    path = f"/api/interviews/{interview.id}/rerun"
    assert admin_client.post(path, json={"step": "transcribe"}).status_code == 202
    assert admin_client.post(path, json={"step": "index"}).status_code == 202
    assert admin_client.post(path, json={"step": "playback"}).status_code == 202
    assert _queued(db_session, interview) == ["index", "playback", "transcribe"]
    stored = db_session.get_one(InterviewRow, interview.id)
    assert stored.status_detail == "Waiting to index for search"

    assert admin_client.post(path, json={"step": "retranscribe"}).status_code == 422
    assert admin_client.post(path, json={"step": "index", "x": 1}).status_code == 422
    unknown = f"/api/interviews/{uuid.uuid4()}/rerun"
    assert admin_client.post(unknown, json={"step": "index"}).status_code == 404

    db_session.execute(delete(SegmentRow).where(SegmentRow.interview_id == interview.id))
    db_session.commit()
    res = admin_client.post(path, json={"step": "translate"})
    assert res.status_code == 409  # nothing to translate yet
