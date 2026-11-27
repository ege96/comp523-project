"""Database connections through SQLAlchemy.

One engine (and connection pool) per process. Routes get a short-lived `Session` per request
through the `DbSession` dependency; nothing opens a connection until a query runs.
"""

from collections.abc import Iterator
from dataclasses import dataclass
from functools import lru_cache
from typing import Annotated, Any

from fastapi import Depends
from sqlalchemy import Engine, event, text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session
from swayambhu_core.db import make_engine, sqlalchemy_url

from swayambhu_api.config import Settings, get_settings

__all__ = ["DbSession", "check_database", "get_engine", "new_session", "sqlalchemy_url"]


@lru_cache
def _engine(database_url: str, connect_timeout: int, ef_search: int) -> Engine:
    engine = make_engine(database_url, connect_timeout)

    @event.listens_for(engine, "connect")
    def search_settings(dbapi_connection: Any, _record: object) -> None:
        # Once per connection rather than per search, saving a round trip. relaxed_order
        # lets an HNSW scan keep going until enough rows pass the visibility filter; the
        # query sorts its result again (search.py).
        with dbapi_connection.cursor() as cursor:
            cursor.execute(f"SET hnsw.ef_search = {int(ef_search)}")
            cursor.execute("SET hnsw.iterative_scan = relaxed_order")
        dbapi_connection.commit()

    return engine


def get_engine(settings: Settings) -> Engine:
    return _engine(
        settings.database_url, settings.db_connect_timeout_seconds, settings.search_ef_search
    )


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
