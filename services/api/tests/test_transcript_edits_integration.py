import uuid
from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete, select
from sqlalchemy.orm import Session
from swayambhu_core import jobs
from swayambhu_core.models import AdminRow, InterviewRow, JobRow, SegmentRow

from swayambhu_api.admins import Admin
from swayambhu_api.auth import require_admin
from swayambhu_api.main import app
from tests.fakes import as_viewer

pytestmark = pytest.mark.integration


@pytest.fixture
def admin(db_session: Session) -> Iterator[Admin]:
    db_session.execute(delete(InterviewRow))
    db_session.execute(delete(AdminRow))
    row = AdminRow(email="editor@example.org")
    db_session.add(row)
    db_session.commit()
    yield Admin(row.id, row.email)
    db_session.rollback()
    db_session.execute(delete(InterviewRow))
    db_session.execute(delete(AdminRow))
    db_session.commit()


@pytest.fixture
def interviews(db_session: Session, admin: Admin) -> dict[str, uuid.UUID]:
    """A Public and a Private Nepali interview, each with a Nepali and an English line."""
    ids = {}
    for visibility in ("public", "private"):
        interview = InterviewRow(title=visibility, visibility=visibility, language_confirmed="ne")
        db_session.add(interview)
        db_session.flush()
        db_session.add_all(
            [
                SegmentRow(
                    interview_id=interview.id, seq=0, start_ms=0, end_ms=5_000, language="ne",
                    original_machine="पहिलो", english_machine="Frist",
                ),
                SegmentRow(
                    interview_id=interview.id, seq=1, start_ms=5_000, end_ms=9_000,
                    language="en", original_machine="the stupa at dawn",
                ),
            ]
        )  # fmt: skip
        ids[visibility] = interview.id
    db_session.commit()
    return ids


def signed_in(client: TestClient, admin: Admin) -> TestClient:
    app.dependency_overrides[require_admin] = lambda: admin
    return as_viewer(client, admin)


def segment(session: Session, interview_id: uuid.UUID, seq: int) -> SegmentRow:
    session.expire_all()
    return session.scalars(
        select(SegmentRow).where(SegmentRow.interview_id == interview_id, SegmentRow.seq == seq)
    ).one()


def index_jobs(session: Session) -> list[tuple[uuid.UUID, str]]:
    return [tuple(r) for r in session.execute(select(JobRow.interview_id, JobRow.state))]


@pytest.mark.parametrize("visibility", ["public", "private"])
def test_anonymous_visitors_cannot_read_or_edit_the_editable_transcript(
    client: TestClient, db_session: Session, interviews: dict[str, uuid.UUID], visibility: str
) -> None:
    interview_id = interviews[visibility]
    anon = as_viewer(client)
    assert anon.get(f"/api/interviews/{interview_id}/transcript").status_code == 401
    res = anon.patch(
        f"/api/interviews/{interview_id}/segments/0", json={"original_text": "defaced"}
    )
    assert res.status_code == 401
    assert segment(db_session, interview_id, 0).original_edited is None
    assert index_jobs(db_session) == []


def test_an_edit_is_kept_apart_from_the_machine_text_and_queues_reindexing(
    client: TestClient, db_session: Session, admin: Admin, interviews: dict[str, uuid.UUID]
) -> None:
    interview_id = interviews["private"]
    path = f"/api/interviews/{interview_id}/segments/0"
    res = signed_in(client, admin).patch(path, json={"english_text": "  First  "})
    assert res.status_code == 200, res.text
    body = res.json()
    assert (body["english_machine"], body["english_edited"]) == ("Frist", "First")
    assert (body["original_edited"], body["edited_by"]) == (None, "editor@example.org")
    assert body["edited_at"] is not None
    assert index_jobs(db_session) == [(interview_id, "queued")]

    # Admins see the edit in the reader's view of the transcript too.
    lines = client.get(f"/api/interviews/{interview_id}/segments").json()["items"]
    assert (lines[0]["english_text"], lines[0]["english_edited"]) == ("First", True)
    transcript = client.get(f"/api/interviews/{interview_id}/transcript").json()["items"]
    assert [t["english_edited"] for t in transcript] == ["First", None]

    # A second save while the first reindex is still queued doesn't queue another.
    res = client.patch(path, json={"original_text": "पहिलो कुरा"})
    assert res.json()["original_edited"] == "पहिलो कुरा"
    assert len(index_jobs(db_session)) == 1

    # null drops the edit; with none left, the line counts as unedited again.
    res = client.patch(path, json={"english_text": None, "original_text": None})
    assert (res.json()["english_edited"], res.json()["edited_at"]) == (None, None)
    row = segment(db_session, interview_id, 0)
    assert (row.original_text, row.english_text, row.edited_by) == ("पहिलो", "Frist", None)


def test_saving_the_machine_text_is_not_an_edit(
    client: TestClient, db_session: Session, admin: Admin, interviews: dict[str, uuid.UUID]
) -> None:
    path = f"/api/interviews/{interviews['public']}/segments/0"
    res = signed_in(client, admin).patch(path, json={"original_text": "पहिलो "})
    assert (res.status_code, res.json()["original_edited"], res.json()["edited_at"]) == (
        200, None, None,
    )  # fmt: skip
    assert index_jobs(db_session) == []


@pytest.mark.parametrize(
    ("seq", "body", "expected"),
    [
        (0, {}, 422),  # nothing to change
        (0, {"original_text": "   "}, 422),  # blank: send null to undo instead
        (0, {"start_ms": 10}, 422),  # timestamps aren't editable
        (1, {"english_text": "dawn"}, 422),  # English speech has no translation
        (7, {"original_text": "x"}, 404),
    ],
)
def test_bad_edits_are_refused(
    client: TestClient,
    db_session: Session,
    admin: Admin,
    interviews: dict[str, uuid.UUID],
    seq: int,
    body: dict[str, str],
    expected: int,
) -> None:
    path = f"/api/interviews/{interviews['public']}/segments/{seq}"
    assert signed_in(client, admin).patch(path, json=body).status_code == expected
    assert index_jobs(db_session) == []


def test_unknown_interviews_are_404(client: TestClient, admin: Admin) -> None:
    unknown = uuid.uuid4()
    client = signed_in(client, admin)
    assert client.get(f"/api/interviews/{unknown}/transcript").status_code == 404
    res = client.patch(f"/api/interviews/{unknown}/segments/0", json={"original_text": "x"})
    assert res.status_code == 404


def test_lines_cannot_be_edited_while_the_transcript_is_being_replaced(
    client: TestClient, db_session: Session, admin: Admin, interviews: dict[str, uuid.UUID]
) -> None:
    interview_id = interviews["public"]
    jobs.enqueue(db_session, "transcribe", interview_id)
    db_session.commit()
    path = f"/api/interviews/{interview_id}/segments/0"
    assert signed_in(client, admin).patch(path, json={"original_text": "x"}).status_code == 409
    assert segment(db_session, interview_id, 0).original_edited is None
