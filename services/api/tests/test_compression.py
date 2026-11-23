"""API responses are compressed when worth it."""

from fastapi.testclient import TestClient

from swayambhu_api.main import app


def test_large_json_is_gzipped_and_small_json_is_not() -> None:
    client = TestClient(app)
    large = client.get("/openapi.json", headers={"Accept-Encoding": "gzip"})
    assert large.headers.get("content-encoding") == "gzip"
    assert large.json()["info"]["title"] == "Swayambhu Stories API"
    small = client.get("/api/health", headers={"Accept-Encoding": "gzip"})
    assert "content-encoding" not in small.headers
