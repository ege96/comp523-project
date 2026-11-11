"""Database URL and engine helpers shared by the API and worker."""

from sqlalchemy import Engine, create_engine
from sqlalchemy.engine import URL, make_url


def sqlalchemy_url(database_url: str) -> URL:
    """DATABASE_URL stays a plain libpq URL; tell SQLAlchemy to use psycopg 3 with it."""
    url = make_url(database_url)
    if url.drivername in ("postgresql", "postgres"):
        url = url.set(drivername="postgresql+psycopg")
    return url


def make_engine(database_url: str, connect_timeout: int = 5) -> Engine:
    return create_engine(
        sqlalchemy_url(database_url),
        # Drop connections the database closed (restarts, idle timeouts) instead of failing.
        pool_pre_ping=True,
        connect_args={"connect_timeout": connect_timeout},
    )
