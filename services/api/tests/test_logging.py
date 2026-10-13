import json
import logging
import sys
from collections.abc import Iterator

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from swayambhu_api.logging_setup import (
    REQUEST_ID_HEADER,
    JsonFormatter,
    install_request_context,
    request_id,
    setup_logging,
)
from swayambhu_api.main import app as main_app

app = FastAPI()
install_request_context(app)


@app.get("/ok")
def ok() -> dict[str, str]:
    logging.getLogger("test").info("inside the route")
    return {"ok": "yes"}


@app.get("/boom")
def boom() -> None:
    raise RuntimeError("secret detail")


client = TestClient(app)


@pytest.fixture
def restore_logging() -> Iterator[None]:
    root = logging.getLogger()
    saved = (root.handlers[:], root.level)
    yield
    root.handlers, root.level = saved[0], saved[1]
    logging.getLogger("uvicorn.access").disabled = False


def access_records(caplog: pytest.LogCaptureFixture) -> list[logging.LogRecord]:
    return [r for r in caplog.records if r.name == "swayambhu_api.access"]


def test_request_id_is_generated_and_returned() -> None:
    res = client.get("/ok")
    assert len(res.headers[REQUEST_ID_HEADER]) == 32


def test_callers_request_id_is_kept() -> None:
    res = client.get("/ok", headers={REQUEST_ID_HEADER: "abc-123.x_y"})
    assert res.headers[REQUEST_ID_HEADER] == "abc-123.x_y"


@pytest.mark.parametrize("bad", ["has space", "x" * 65, "new\nline", "<script>"])
def test_unsafe_request_id_is_replaced(bad: str) -> None:
    res = client.get("/ok", headers={REQUEST_ID_HEADER: bad})
    assert res.headers[REQUEST_ID_HEADER] != bad


def test_request_id_reaches_logs_written_in_the_route(caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level(logging.INFO)
    seen: list[str | None] = []

    class Capture(logging.Handler):
        def emit(self, record: logging.LogRecord) -> None:
            seen.append(request_id.get())

    handler = Capture()
    logging.getLogger("test").addHandler(handler)
    try:
        client.get("/ok", headers={REQUEST_ID_HEADER: "rid-1"})
    finally:
        logging.getLogger("test").removeHandler(handler)
    assert seen == ["rid-1"]
    assert request_id.get() is None  # reset after the request


def test_access_line_has_no_query_string_or_token(caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level(logging.INFO)
    client.get("/ok?q=private+search", headers={"Authorization": "Bearer tok-123"})
    [record] = access_records(caplog)
    fields = record.fields  # type: ignore[attr-defined]
    assert fields["path"] == "/ok"
    assert fields["status"] == 200
    assert fields["method"] == "GET"
    assert fields["duration_ms"] >= 0
    text = record.getMessage() + json.dumps(fields)
    assert "private" not in text
    assert "tok-123" not in text


def test_unhandled_error_is_a_logged_500_with_the_request_id(
    caplog: pytest.LogCaptureFixture,
) -> None:
    caplog.set_level(logging.INFO)
    res = client.get("/boom", headers={REQUEST_ID_HEADER: "rid-500"})
    assert res.status_code == 500
    assert res.json() == {"detail": "Internal error", "request_id": "rid-500"}
    assert res.headers[REQUEST_ID_HEADER] == "rid-500"
    assert "secret detail" not in res.text
    [error] = [r for r in caplog.records if r.name == "swayambhu_api.error"]
    assert error.exc_info is not None
    assert access_records(caplog)[0].fields["status"] == 500  # type: ignore[attr-defined]


def test_api_responses_are_nosniff() -> None:
    res = TestClient(main_app).get("/api/health")
    assert res.headers["X-Content-Type-Options"] == "nosniff"
    assert REQUEST_ID_HEADER in res.headers


def test_json_formatter_writes_one_object_per_line() -> None:
    record = logging.LogRecord("x", logging.WARNING, __file__, 1, "hello %s", ("you",), None)
    record.fields = {"status": 404}
    token = request_id.set("rid-json")
    try:
        line = JsonFormatter().format(record)
    finally:
        request_id.reset(token)
    entry = json.loads(line)
    assert entry["message"] == "hello you"
    assert entry["level"] == "WARNING"
    assert entry["request_id"] == "rid-json"
    assert entry["status"] == 404
    assert entry["time"].endswith("+00:00")


def test_json_formatter_includes_the_stack() -> None:
    try:
        raise ValueError("bad")
    except ValueError:
        record = logging.LogRecord("x", logging.ERROR, __file__, 1, "failed", (), sys.exc_info())
    entry = json.loads(JsonFormatter().format(record))
    assert "ValueError: bad" in entry["exception"]
    assert "request_id" not in entry


@pytest.mark.usefixtures("restore_logging")
def test_setup_logging_json(capsys: pytest.CaptureFixture[str]) -> None:
    setup_logging("json", "info")
    logging.getLogger("uvicorn.error").info("started")
    logging.getLogger("uvicorn.access").info("should be off")
    lines = capsys.readouterr().out.splitlines()
    assert [json.loads(line)["message"] for line in lines] == ["started"]


@pytest.mark.usefixtures("restore_logging")
def test_setup_logging_text(capsys: pytest.CaptureFixture[str]) -> None:
    setup_logging("text")
    logging.getLogger("swayambhu_api").warning("plain")
    assert capsys.readouterr().out.rstrip().endswith("WARNING swayambhu_api plain")


@pytest.mark.usefixtures("restore_logging")
def test_app_startup_configures_logging(capsys: pytest.CaptureFixture[str]) -> None:
    with TestClient(main_app) as c:
        c.get("/api/health")
    lines = [json.loads(line) for line in capsys.readouterr().out.splitlines()]
    assert any(e["logger"] == "swayambhu_api.access" for e in lines)
