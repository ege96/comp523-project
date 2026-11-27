"""Builds search's HNSW index (`swayambhu_core.vector_index`) once there are embeddings to
size it by. The worker calls `ensure` at startup and after each indexing job; it is a quick
check when the index already exists, and takes minutes the first time on a large archive."""

import logging
from typing import Any

from sqlalchemy import Engine, func, select, text
from swayambhu_core import vector_index
from swayambhu_core.models import ChunkEmbeddingRow

log = logging.getLogger(__name__)


def stored_dimensions(engine: Engine, model: str) -> int | None:
    with engine.connect() as connection:
        return connection.scalar(
            select(func.vector_dims(ChunkEmbeddingRow.embedding))
            .where(ChunkEmbeddingRow.model == model)
            .limit(1)
        )


def ensure(engine: Engine, model: str) -> bool:
    """Build the index for `model`'s vector size if it is missing or a build was interrupted.
    Returns True when it built one."""
    dims = stored_dimensions(engine, model)
    if dims is None or dims > vector_index.MAX_DIMENSIONS:
        return False
    name = vector_index.index_name(dims)
    with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as connection:
        valid: Any = connection.scalar(
            text(
                "SELECT i.indisvalid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid "
                "WHERE c.relname = :name"
            ),
            {"name": name},
        )
        if valid:
            return False
        if valid is not None:  # left invalid by an interrupted concurrent build
            connection.execute(text(f"DROP INDEX CONCURRENTLY IF EXISTS {name}"))
        log.info("building the search index %s", name)
        connection.execute(text(vector_index.create_statement(dims)))
        log.info("built the search index %s", name)
        return True
