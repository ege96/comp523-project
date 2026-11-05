"""Correcting an interview's details after upload (D-004): PATCH /api/interviews/{id}."""

import uuid
from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete, select
from sqlalchemy.orm import Session
from swayambhu_core.models import (
    AdminRow,
    IntervieweeRow,
    InterviewLanguageRow,
    InterviewRow,
    SegmentRow,
)

from swayambhu_api.admins import Admin
from swayambhu_api.auth import require_admin
from swayambhu_api.main import app
from tests.fakes import as_viewer

pytestmark = pytest.mark.integration


@pytest.fixture
def interview(db_session: Session) -> Iterator[InterviewRow]:
    """A Private interview whose Nepal Bhasa speech was detected as Nepali."""
    for table in (InterviewRow, IntervieweeRow, AdminRow):
        db_session.execute(delete(table))
    row = InterviewRow(
        title="Dawn", status="done", language_detected="ne", language_detected_confidence=0.9
    )
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
        ]
    )  # fmt: skip
    db_session.commit()
    yield row
    db_session.rollback()
    for table in (InterviewRow, IntervieweeRow, AdminRow):
        db_session.execute(delete(table))
    db_session.commit()


@pytest.fixture
def admin_client(client: TestClient) -> Iterator[TestClient]:
    admin = Admin(1, "lead@example.org")
    app.dependency_overrides[require_admin] = lambda: admin
    yield as_viewer(client, admin)


def _languages(db_session: Session, interview: InterviewRow) -> list[str]:
    db_session.expire_all()
    return sorted(
        db_session.scalars(
            select(InterviewLanguageRow.language_code).where(
                InterviewLanguageRow.interview_id == interview.id
            )
        )
    )


def test_visitors_cannot_change_details_or_see_private_ones(
    client: TestClient, interview: InterviewRow, db_session: Session
) -> None:
    path = f"/api/interviews/{interview.id}"
    anonymous = as_viewer(client)
    for body in ({"title": "Mine now"}, {"language": "new"}, {"visibility": "public"}):
        assert anonymous.patch(path, json=body).status_code == 401
    assert anonymous.get(path).status_code == 404
    db_session.expire_all()
    stored = db_session.get(InterviewRow, interview.id)
    assert stored is not None
    assert (stored.title, stored.language_confirmed, stored.visibility) == (
        "Dawn", None, "private",
    )  # fmt: skip


def test_admin_corrects_title_interviewee_date_and_language(
    admin_client: TestClient, interview: InterviewRow, db_session: Session
) -> None:
    path = f"/api/interviews/{interview.id}"
    res = admin_client.patch(
        path,
        json={
            "title": " Dawn rituals ",
            "interviewee_name": "Maya Shakya",
            "recorded_on": "2019-05",
            "language": "new",
        },
    )
    assert res.status_code == 204, res.text
    detail = admin_client.get(path).json()
    assert (detail["title"], detail["interviewee"]) == ("Dawn rituals", "Maya Shakya")
    assert (detail["recorded_on"], detail["recorded_on_precision"]) == ("2019-05-01", "month")
    assert detail["primary_language"] == {"code": "new", "name": "Nepal Bhasa"}
    assert (detail["language_detected"], detail["language_confirmed"]) == ("ne", "new")
    # The filter finds it under the corrected language as well as what the lines say.
    assert _languages(db_session, interview) == ["en", "ne", "new"]

    # Only what's sent changes; null clears an optional detail.
    person = detail["interviewee_id"]
    res = admin_client.patch(path, json={"recorded_on": None, "language": None})
    assert res.status_code == 204, res.text
    detail = admin_client.get(path).json()
    assert (detail["title"], detail["interviewee_id"]) == ("Dawn rituals", person)
    assert (detail["recorded_on"], detail["recorded_on_precision"]) == (None, None)
    assert detail["primary_language"]["code"] == "ne"  # back to the detected one
    assert _languages(db_session, interview) == ["en", "ne"]

    other = IntervieweeRow(display_name="Ram Bajracharya")
    db_session.add(other)
    db_session.commit()
    assert admin_client.patch(path, json={"interviewee_id": other.id}).status_code == 204
    assert admin_client.get(path).json()["interviewee"] == "Ram Bajracharya"
    assert admin_client.patch(path, json={"interviewee_id": None}).status_code == 204
    assert admin_client.get(path).json()["interviewee"] is None


@pytest.mark.parametrize(
    "body",
    [
        {},
        {"title": " "},
        {"title": None},
        {"visibility": None},
        {"visibility": "restricted"},
        {"interviewee_id": 1, "interviewee_name": "A"},
        {"interviewee_id": 1_000_000_000},
        {"recorded_on": "2024-02-30"},
        {"recorded_on": "May 2019"},
        {"language": "fr"},
        {"status": "done"},
    ],
)
def test_bad_corrections_are_refused(
    admin_client: TestClient, interview: InterviewRow, db_session: Session, body: dict[str, object]
) -> None:
    res = admin_client.patch(f"/api/interviews/{interview.id}", json=body)
    assert res.status_code == 422, res.text
    db_session.expire_all()
    stored = db_session.get(InterviewRow, interview.id)
    assert stored is not None and (stored.title, stored.language_confirmed) == ("Dawn", None)


def test_unknown_interview_is_404(admin_client: TestClient, interview: InterviewRow) -> None:
    res = admin_client.patch(f"/api/interviews/{uuid.uuid4()}", json={"title": "x"})
    assert res.status_code == 404
