"""Database connections through SQLAlchemy (Proposal P-010).

One engine (and connection pool) per process. Routes get a short-lived `Session` per request
through the `DbSession` dependency; nothing opens a connection until a query runs.
"""

from collections.abc import Iterator
from dataclasses import dataclass
from functools import lru_cache
from typing import Annotated

from fastapi import Depends
from sqlalchemy import Engine, create_engine, text
from sqlalchemy.engine import URL, make_url
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from swayambhu_api.config import Settings, get_settings


def sqlalchemy_url(database_url: str) -> URL:
    """DATABASE_URL stays a plain libpq URL (P-003); tell SQLAlchemy to use psycopg 3 with it."""
    url = make_url(database_url)
    if url.drivername in ("postgresql", "postgres"):
        url = url.set(drivername="postgresql+psycopg")
    return url


@lru_cache
def _engine(database_url: str, connect_timeout: int) -> Engine:
    return create_engine(
        sqlalchemy_url(database_url),
        # Drop connections the database closed (restarts, idle timeouts) instead of failing.
        pool_pre_ping=True,
        connect_args={"connect_timeout": connect_timeout},
    )


def get_engine(settings: Settings) -> Engine:
    return _engine(settings.database_url, settings.db_connect_timeout_seconds)


def new_session(settings: Settings) -> Session:
    # Objects stay readable after commit, so a store can return what it just wrote.
    return Session(get_engine(settings), expire_on_commit=False)


def get_session(settings: Annotated[Settings, Depends(get_settings)]) -> Iterator[Session]:
    """One session per request. Writes must commit; anything uncommitted is rolled back."""
    with new_session(settings) as session:
        yield session


DbSession = Annotated[Session, Depends(get_session)]


@dataclass(frozen=True)
class DatabaseStatus:
    reachable: bool
    pgvector_version: str | None


def check_database(settings: Settings) -> DatabaseStatus:
    """Report whether Postgres is reachable and whether the pgvector extension is installed."""
    try:
        with get_engine(settings).connect() as conn:
            version = conn.execute(
                text("SELECT extversion FROM pg_extension WHERE extname = 'vector'")
            ).scalar_one_or_none()
    except SQLAlchemyError:
        return DatabaseStatus(reachable=False, pgvector_version=None)
    return DatabaseStatus(reachable=True, pgvector_version=version)
