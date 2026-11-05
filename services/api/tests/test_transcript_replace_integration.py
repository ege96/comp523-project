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
    """A Public and a Private Nepali interview where ASR misspelled the same place each time."""
    ids = {}
    for visibility in ("public", "private"):
        interview = InterviewRow(title=visibility, visibility=visibility, language_confirmed="ne")
        db_session.add(interview)
        db_session.flush()
        db_session.add_all(
            [
                SegmentRow(
                    interview_id=interview.id, seq=0, start_ms=0, end_ms=5_000, language="ne",
                    original_machine="स्वयम्बु", english_machine="Swayambu at dawn",
                ),
                SegmentRow(
                    interview_id=interview.id, seq=1, start_ms=5_000, end_ms=9_000, language="en",
                    original_machine="we walked up to swayambu",
                ),
                SegmentRow(
                    interview_id=interview.id, seq=2, start_ms=9_000, end_ms=12_000, language="ne",
                    original_machine="पहिलो", english_machine="First",
                ),
            ]
        )  # fmt: skip
        ids[visibility] = interview.id
    db_session.commit()
    return ids


def signed_in(client: TestClient, admin: Admin) -> TestClient:
    app.dependency_overrides[require_admin] = lambda: admin
    return as_viewer(client, admin)


def lines(session: Session, interview_id: uuid.UUID) -> list[SegmentRow]:
    session.expire_all()
    return list(
        session.scalars(
            select(SegmentRow)
            .where(SegmentRow.interview_id == interview_id)
            .order_by(SegmentRow.seq)
        )
    )


def queued_jobs(session: Session) -> list[tuple[uuid.UUID, str, str]]:
    return [
        tuple(r) for r in session.execute(select(JobRow.interview_id, JobRow.kind, JobRow.state))
    ]


def path(interview_id: uuid.UUID) -> str:
    return f"/api/interviews/{interview_id}/transcript/replace"


@pytest.mark.parametrize("visibility", ["public", "private"])
def test_anonymous_visitors_cannot_replace_text(
    client: TestClient, db_session: Session, interviews: dict[str, uuid.UUID], visibility: str
) -> None:
    interview_id = interviews[visibility]
    body = {"find": "Swayambu", "replace": "defaced", "field": "english"}
    assert as_viewer(client).post(path(interview_id), json=body).status_code == 401
    assert all(line.english_edited is None for line in lines(db_session, interview_id))
    assert queued_jobs(db_session) == []


def test_replacing_edits_every_matching_line_and_queues_one_reindex(
    client: TestClient, db_session: Session, admin: Admin, interviews: dict[str, uuid.UUID]
) -> None:
    interview_id = interviews["private"]
    body = {"find": "swayambu", "replace": "Swayambhu", "field": "english"}
    res = signed_in(client, admin).post(path(interview_id), json=body)
    assert res.status_code == 200, res.text
    # Only the translation of the Nepali line: English speech has no separate English.
    assert [(i["seq"], i["english_edited"]) for i in res.json()["items"]] == [
        (0, "Swayambhu at dawn")
    ]
    assert res.json()["items"][0]["edited_by"] == "editor@example.org"

    body = {"find": "swayambu", "replace": "Swayambhu", "field": "original"}
    res = client.post(path(interview_id), json=body)
    assert [i["seq"] for i in res.json()["items"]] == [1]

    rows = lines(db_session, interview_id)
    assert [r.english_machine for r in rows] == ["Swayambu at dawn", None, "First"]
    assert [r.original_edited for r in rows] == [None, "we walked up to Swayambhu", None]
    assert queued_jobs(db_session) == [(interview_id, "index", "queued")]
    # The Public interview wasn't touched.
    assert all(r.edited_at is None for r in lines(db_session, interviews["public"]))


def test_match_case_and_literal_replacement(
    client: TestClient, db_session: Session, admin: Admin, interviews: dict[str, uuid.UUID]
) -> None:
    interview_id = interviews["public"]
    client = signed_in(client, admin)
    body = {"find": "swayambu", "replace": "x", "field": "english", "match_case": True}
    assert client.post(path(interview_id), json=body).json()["items"] == []
    assert queued_jobs(db_session) == []

    # Regex characters and backslashes are plain text.
    body = {"find": "Swayambu", "replace": r"S\1 (.*)", "field": "english"}
    res = client.post(path(interview_id), json=body)
    assert res.json()["items"][0]["english_edited"] == r"S\1 (.*) at dawn"


def test_lines_that_would_be_blank_are_skipped_and_undo_restores_machine_text(
    client: TestClient, db_session: Session, admin: Admin, interviews: dict[str, uuid.UUID]
) -> None:
    interview_id = interviews["public"]
    client = signed_in(client, admin)
    res = client.post(
        path(interview_id), json={"find": "पहिलो", "replace": "", "field": "original"}
    )
    assert (res.json()["items"], res.json()["skipped"]) == ([], 1)

    client.post(path(interview_id), json={"find": "स्वयम्बु", "replace": "स्वयम्भू", "field": "original"})
    # The Nepali original's words changed, so its English is re-translated in one delayed batch.
    assert sorted(kind for _, kind, _ in queued_jobs(db_session)) == ["index", "retranslate"]
    # Replacing back to the machine's words drops the edit rather than storing a copy.
    res = client.post(
        path(interview_id), json={"find": "स्वयम्भू", "replace": "स्वयम्बु", "field": "original"}
    )
    item = res.json()["items"][0]
    assert (item["original_edited"], item["edited_by"], item["edited_at"]) == (None, None, None)


@pytest.mark.parametrize(
    "body",
    [
        {"find": "  ", "replace": "x", "field": "original"},
        {"find": "a", "replace": "x", "field": "speaker"},
        {"find": "a", "replace": "x", "field": "original", "regex": True},
    ],
)
def test_bad_requests_are_refused(
    client: TestClient, admin: Admin, interviews: dict[str, uuid.UUID], body: dict[str, object]
) -> None:
    assert signed_in(client, admin).post(path(interviews["public"]), json=body).status_code == 422


def test_unknown_interview_is_404_and_transcribing_is_409(
    client: TestClient, db_session: Session, admin: Admin, interviews: dict[str, uuid.UUID]
) -> None:
    client = signed_in(client, admin)
    body = {"find": "Swayambu", "replace": "Swayambhu", "field": "english"}
    assert client.post(path(uuid.uuid4()), json=body).status_code == 404
    jobs.enqueue(db_session, "transcribe", interviews["public"])
    db_session.commit()
    assert client.post(path(interviews["public"]), json=body).status_code == 409
    assert all(r.english_edited is None for r in lines(db_session, interviews["public"]))
