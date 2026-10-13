from collections.abc import Callable
from typing import Annotated, Literal

from fastapi import Depends, FastAPI, Response, status
from pydantic import BaseModel

from swayambhu_api.config import Settings, get_settings
from swayambhu_api.db import DatabaseStatus, check_database

app = FastAPI(title="Swayambhu Stories API", version="0.1.0")


class LivenessResponse(BaseModel):
    status: Literal["ok"]


class ReadinessResponse(BaseModel):
    status: Literal["ok", "unavailable"]
    database: bool
    pgvector: bool


DatabaseChecker = Callable[[Settings], DatabaseStatus]


def get_database_checker() -> DatabaseChecker:
    return check_database


@app.get("/api/health", response_model=LivenessResponse)
def health() -> LivenessResponse:
    """Liveness: the process is up. Does not touch the database."""
    return LivenessResponse(status="ok")


@app.get("/api/health/ready", response_model=ReadinessResponse)
def ready(
    response: Response,
    settings: Annotated[Settings, Depends(get_settings)],
    checker: Annotated[DatabaseChecker, Depends(get_database_checker)],
) -> ReadinessResponse:
    """Readiness: Postgres is reachable and pgvector is installed. 503 otherwise."""
    db = checker(settings)
    ok = db.reachable and db.pgvector_version is not None
    if not ok:
        response.status_code = status.HTTP_503_SERVICE_UNAVAILABLE
    return ReadinessResponse(
        status="ok" if ok else "unavailable",
        database=db.reachable,
        pgvector=db.pgvector_version is not None,
    )
