"""Live admin updates: change notifications from the database and the SSE stream."""

import json
import socket
import threading
import time
import uuid
from collections.abc import Iterator

import httpx2
import psycopg
import pytest
import uvicorn
from sqlalchemy import delete, func, update
from sqlalchemy.orm import Session
from swayambhu_core.models import AdminRow, InterviewRow, JobRow

from swayambhu_api.admins import SqlAlchemyAdminStore
from swayambhu_api.auth import get_token_verifier
from swayambhu_api.config import Settings, get_settings
from swayambhu_api.live import CHANNEL, require_admin_briefly
from swayambhu_api.main import app
from tests.fakes import ADMIN, TokenSigner

pytestmark = pytest.mark.integration


@pytest.fixture
def interview(db_session: Session) -> Iterator[InterviewRow]:
    db_session.execute(delete(InterviewRow))
    db_session.execute(delete(AdminRow))
    row = InterviewRow(title="Dawn", status="processing")
    db_session.add(row)
    db_session.flush()
    db_session.add(JobRow(interview_id=row.id, kind="transcribe", state="queued"))
    db_session.commit()
    yield row
    db_session.rollback()
    db_session.execute(delete(InterviewRow))
    db_session.execute(delete(AdminRow))
    db_session.commit()


@pytest.fixture
def listener(database_url: str) -> Iterator[psycopg.Connection[tuple[object, ...]]]:
    with psycopg.connect(database_url, autocommit=True) as conn:
        conn.execute(f"LISTEN {CHANNEL}")
        yield conn


def received(conn: psycopg.Connection[tuple[object, ...]]) -> list[str]:
    return [n.payload for n in conn.notifies(timeout=0.5)]


def test_job_state_change_notifies_once_per_transaction(
    db_session: Session, interview: InterviewRow, listener: psycopg.Connection[tuple[object, ...]]
) -> None:
    db_session.execute(
        update(JobRow).where(JobRow.interview_id == interview.id).values(state="running")
    )
    db_session.execute(
        update(InterviewRow).where(InterviewRow.id == interview.id).values(status_detail="Busy")
    )
    assert received(listener) == []  # nothing until commit
    db_session.commit()
    # Same payload from one transaction is folded into one notification.
    assert received(listener) == [str(interview.id)]


def test_heartbeat_does_not_notify(
    db_session: Session, interview: InterviewRow, listener: psycopg.Connection[tuple[object, ...]]
) -> None:
    db_session.execute(
        update(JobRow).where(JobRow.interview_id == interview.id).values(heartbeat_at=func.now())
    )
    db_session.commit()
    assert received(listener) == []


def test_new_and_deleted_interviews_notify(
    db_session: Session, listener: psycopg.Connection[tuple[object, ...]]
) -> None:
    row = InterviewRow(title="New", status="processing")
    db_session.add(row)
    db_session.commit()
    assert received(listener) == [str(row.id)]
    db_session.delete(row)
    db_session.commit()
    assert received(listener) == [str(row.id)]


@pytest.fixture
def server(settings: Settings) -> Iterator[str]:
    """The app on a real local server: TestClient waits for the whole body, a stream never ends."""
    quick = settings.model_copy(update={"live_stream_max_seconds": 3})
    app.dependency_overrides[get_settings] = lambda: quick
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    server = uvicorn.Server(uvicorn.Config(app, port=port, log_config=None))
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    while not server.started:
        time.sleep(0.01)
    yield f"http://127.0.0.1:{port}"
    server.should_exit = True
    thread.join(timeout=10)
    app.dependency_overrides.clear()


@pytest.fixture
def client(server: str) -> Iterator[httpx2.Client]:
    with httpx2.Client(base_url=server, timeout=10) as client:
        yield client


def events(lines: Iterator[str]) -> Iterator[tuple[str, dict[str, str]]]:
    """(event, data) pairs from an SSE body, skipping keep-alive comments."""
    name = "message"
    for line in lines:
        if line.startswith("event: "):
            name = line.removeprefix("event: ")
        elif line.startswith("data: "):
            yield name, json.loads(line.removeprefix("data: "))
            name = "message"


def test_anonymous_visitors_get_401(client: httpx2.Client) -> None:
    assert client.get("/api/admin/changes").status_code == 401


def test_signed_in_non_admins_get_403_and_admins_get_in(
    client: httpx2.Client, db_session: Session, interview: InterviewRow
) -> None:
    signer = TokenSigner()
    app.dependency_overrides[get_token_verifier] = signer.verifier
    SqlAlchemyAdminStore(db_session).add("lead@example.org")
    outsider = {"Authorization": f"Bearer {signer.token('uid-9')}"}
    assert client.get("/api/admin/changes", headers=outsider).status_code == 403
    admin = {"Authorization": f"Bearer {signer.token('uid-1', email='lead@example.org')}"}
    with client.stream("GET", "/api/admin/changes", headers=admin) as response:
        assert response.status_code == 200
        assert next(events(response.iter_lines())) == ("ready", {})


def test_admin_hears_changes(
    client: httpx2.Client, db_session: Session, interview: InterviewRow
) -> None:
    app.dependency_overrides[require_admin_briefly] = lambda: ADMIN
    with client.stream("GET", "/api/admin/changes") as response:
        assert response.status_code == 200
        assert response.headers["content-type"].startswith("text/event-stream")
        assert response.headers["cache-control"] == "no-cache"
        stream = events(response.iter_lines())
        assert next(stream) == ("ready", {})
        db_session.execute(
            update(JobRow).where(JobRow.interview_id == interview.id).values(state="done")
        )
        db_session.commit()
        assert next(stream) == ("change", {"interview_id": str(interview.id)})
        # The stream ends by itself after live_stream_max_seconds, so the page reconnects.
        assert list(stream) == []


def test_notification_with_bad_payload_is_ignored(
    client: httpx2.Client, database_url: str, interview: InterviewRow
) -> None:
    app.dependency_overrides[require_admin_briefly] = lambda: ADMIN
    with client.stream("GET", "/api/admin/changes") as response:
        stream = events(response.iter_lines())
        assert next(stream) == ("ready", {})
        with psycopg.connect(database_url, autocommit=True) as conn:
            conn.execute("SELECT pg_notify(%s, 'not-an-id')", (CHANNEL,))
            conn.execute("SELECT pg_notify(%s, %s)", (CHANNEL, str(uuid.UUID(int=7))))
        assert next(stream) == ("change", {"interview_id": str(uuid.UUID(int=7))})
