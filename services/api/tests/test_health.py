from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient

from swayambhu_api.config import Settings
from swayambhu_api.db import DatabaseStatus
from swayambhu_api.main import app, get_database_checker


@pytest.fixture
def client() -> Iterator[TestClient]:
    yield TestClient(app)
    app.dependency_overrides.clear()


def use_status(db: DatabaseStatus) -> None:
    def checker(_: Settings) -> DatabaseStatus:
        return db

    app.dependency_overrides[get_database_checker] = lambda: checker


def test_liveness_does_not_need_database(client: TestClient) -> None:
    use_status(DatabaseStatus(reachable=False, pgvector_version=None))
    res = client.get("/api/health")
    assert res.status_code == 200
    assert res.json() == {"status": "ok"}


def test_ready_when_database_and_pgvector_present(client: TestClient) -> None:
    use_status(DatabaseStatus(reachable=True, pgvector_version="0.8.0"))
    res = client.get("/api/health/ready")
    assert res.status_code == 200
    assert res.json() == {"status": "ok", "database": True, "pgvector": True}


def test_not_ready_without_pgvector(client: TestClient) -> None:
    use_status(DatabaseStatus(reachable=True, pgvector_version=None))
    res = client.get("/api/health/ready")
    assert res.status_code == 503
    assert res.json()["pgvector"] is False


def test_not_ready_when_database_unreachable(client: TestClient) -> None:
    use_status(DatabaseStatus(reachable=False, pgvector_version=None))
    res = client.get("/api/health/ready")
    assert res.status_code == 503
    assert res.json() == {"status": "unavailable", "database": False, "pgvector": False}
