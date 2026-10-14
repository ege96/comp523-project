from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Annotated, Literal

from fastapi import Depends, FastAPI, Response, status
from pydantic import BaseModel

from swayambhu_api.admin_interviews import router as admin_interviews_router
from swayambhu_api.auth import CurrentAdmin
from swayambhu_api.config import Settings, get_settings
from swayambhu_api.db import DatabaseStatus, check_database
from swayambhu_api.interviews import router as interviews_router
from swayambhu_api.logging_setup import install_request_context, setup_logging
from swayambhu_api.search import router as search_router
from swayambhu_api.uploads import require_upload_admin
from swayambhu_api.uploads import router as uploads_router


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    settings = get_settings()
    setup_logging(settings.log_format, settings.log_level)
    yield


app = FastAPI(title="Swayambhu Stories API", version="0.1.0", lifespan=lifespan)
install_request_context(app)
app.include_router(interviews_router)
app.include_router(search_router)
app.include_router(admin_interviews_router)
# Router-level, so the admin check runs before tuspyserver's PATCH dependency starts reading
# the body; its own `auth` dependency runs after that one.
app.include_router(uploads_router, dependencies=[Depends(require_upload_admin)])


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
