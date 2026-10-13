from dataclasses import dataclass

import psycopg

from swayambhu_api.config import Settings


@dataclass(frozen=True)
class DatabaseStatus:
    reachable: bool
    pgvector_version: str | None


def check_database(settings: Settings) -> DatabaseStatus:
    """Report whether Postgres is reachable and whether the pgvector extension is installed."""
    try:
        with psycopg.connect(
            settings.database_url, connect_timeout=settings.db_connect_timeout_seconds
        ) as conn:
            row = conn.execute(
                "SELECT extversion FROM pg_extension WHERE extname = 'vector'"
            ).fetchone()
    except psycopg.Error:
        return DatabaseStatus(reachable=False, pgvector_version=None)
    return DatabaseStatus(reachable=True, pgvector_version=row[0] if row else None)
