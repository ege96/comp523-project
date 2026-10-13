"""Logs as one JSON object per line on stdout (Proposal P-014), and a request ID on each line.

OpenShift collects stdout. Every request gets an ID (the caller's `X-Request-ID` if it looks
safe, else a new one); it is sent back in the response and added to every log line written
while that request runs, so one ID finds everything a request did.
"""

import json
import logging
import re
import sys
import time
import uuid
from collections.abc import Awaitable, Callable
from contextvars import ContextVar
from datetime import UTC, datetime
from typing import Any, Literal

from fastapi import FastAPI, Request, Response
from fastapi.responses import JSONResponse

LogFormat = Literal["json", "text"]

REQUEST_ID_HEADER = "X-Request-ID"
_SAFE_REQUEST_ID = re.compile(r"[A-Za-z0-9._-]{1,64}")

request_id: ContextVar[str | None] = ContextVar("request_id", default=None)

access_log = logging.getLogger("swayambhu_api.access")
error_log = logging.getLogger("swayambhu_api.error")


class JsonFormatter(logging.Formatter):
    """Structured fields go in `extra={"fields": {...}}` and land as top-level keys."""

    def format(self, record: logging.LogRecord) -> str:
        entry: dict[str, Any] = {
            "time": datetime.fromtimestamp(record.created, UTC).isoformat(timespec="milliseconds"),
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
        }
        rid = request_id.get()
        if rid is not None:
            entry["request_id"] = rid
        entry.update(getattr(record, "fields", {}))
        if record.exc_info:
            entry["exception"] = self.formatException(record.exc_info)
        return json.dumps(entry, default=str)


def setup_logging(log_format: LogFormat, level: str = "INFO") -> None:
    """Send all logs, uvicorn's included, to stdout in one format.

    uvicorn's own access log is turned off: `request_context` writes a richer line instead.
    """
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(
        JsonFormatter()
        if log_format == "json"
        else logging.Formatter("%(asctime)s %(levelname)s %(name)s %(message)s")
    )
    root = logging.getLogger()
    root.handlers = [handler]
    root.setLevel(level.upper())
    for name in ("uvicorn", "uvicorn.error"):
        logger = logging.getLogger(name)
        logger.handlers = []
        logger.propagate = True
    logging.getLogger("uvicorn.access").disabled = True


def _request_id_from(request: Request) -> str:
    given = request.headers.get(REQUEST_ID_HEADER)
    if given is not None and _SAFE_REQUEST_ID.fullmatch(given):
        return given
    return uuid.uuid4().hex


def install_request_context(app: FastAPI) -> None:
    """Request IDs, one access line per request, and a logged 500 for unhandled errors."""

    @app.middleware("http")
    async def request_context(
        request: Request, call_next: Callable[[Request], Awaitable[Response]]
    ) -> Response:
        rid = _request_id_from(request)
        token = request_id.set(rid)
        started = time.perf_counter()
        try:
            try:
                response = await call_next(request)
            except Exception:
                # Logged with the stack here; the caller gets only the ID to quote.
                error_log.exception("Unhandled error")
                response = JSONResponse(
                    {"detail": "Internal error", "request_id": rid}, status_code=500
                )
            response.headers[REQUEST_ID_HEADER] = rid
            # /api is routed straight to the API, past nginx's headers.
            response.headers["X-Content-Type-Options"] = "nosniff"
            # Path only: query strings carry what visitors search for. Headers are never logged.
            access_log.info(
                "%s %s %s",
                request.method,
                request.url.path,
                response.status_code,
                extra={
                    "fields": {
                        "method": request.method,
                        "path": request.url.path,
                        "status": response.status_code,
                        "duration_ms": round((time.perf_counter() - started) * 1000, 1),
                        "client_ip": request.client.host if request.client else None,
                    }
                },
            )
            return response
        finally:
            request_id.reset(token)
