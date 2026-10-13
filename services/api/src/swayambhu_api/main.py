from typing import Annotated, Literal

from fastapi import Depends, FastAPI, Response, status
from pydantic import BaseModel

from swayambhu_api.auth import CurrentAdmin
from swayambhu_api.config import Settings, get_settings
from swayambhu_api.db import DatabaseStatus, check_database

app = FastAPI(title="Swayambhu Stories API", version="0.1.0")


class LivenessResponse(BaseModel):
    status: Literal["ok"]


class ReadinessResponse(BaseModel):
    status: Literal["ok", "unavailable"]
    database: bool
    pgvector: bool


class AdminResponse(BaseModel):
    id: int
    email: str


def get_database_status(settings: Annotated[Settings, Depends(get_settings)]) -> DatabaseStatus:
    return check_database(settings)


@app.get("/api/health", response_model=LivenessResponse)
def health() -> LivenessResponse:
    """Liveness: the process is up. Does not touch the database."""
    return LivenessResponse(status="ok")


@app.get("/api/health/ready", response_model=ReadinessResponse)
def ready(
    response: Response,
    db: Annotated[DatabaseStatus, Depends(get_database_status)],
) -> ReadinessResponse:
    """Readiness: Postgres is reachable and pgvector is installed. 503 otherwise."""
    ok = db.reachable and db.pgvector_version is not None
    if not ok:
        response.status_code = status.HTTP_503_SERVICE_UNAVAILABLE
    return ReadinessResponse(
        status="ok" if ok else "unavailable",
        database=db.reachable,
        pgvector=db.pgvector_version is not None,
    )


@app.get("/api/auth/me", response_model=AdminResponse)
def me(admin: CurrentAdmin) -> AdminResponse:
    """The signed-in admin. 401 without a valid token, 403 if the account isn't an admin."""
    return AdminResponse(id=admin.id, email=admin.email)
