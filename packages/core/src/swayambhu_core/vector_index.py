"""The approximate (HNSW) index semantic search uses, one per vector size.

`chunk_embeddings.embedding` has no fixed size, because the embedding model is a setting.
pgvector can only index a fixed size, so the index is on an expression,
`embedding::halfvec(<dims>)`, limited to rows of that size, and search must cast its
distance in exactly the same way (`distance`, `same_size`) for Postgres to use it.
Half precision halves the index's size; at 90,000 e5-small vectors it found 99% of exact
search's top 10 (with `hnsw.ef_search` 1000), 16x faster (see perf/RESULTS.md).

A migration can't create it, since the size depends on the model, so the worker does
(`ensure`): it reads the size from the stored embeddings and builds the index
concurrently, without blocking searches or writes. Until it exists, search still works, by
scanning every embedding.
"""

import logging
from typing import Any

from pgvector.sqlalchemy import HALFVEC
from sqlalchemy import ColumnElement, Engine, cast, func, literal_column, select, text

from swayambhu_core.models import ChunkEmbeddingRow

log = logging.getLogger(__name__)

PREFIX = "chunk_embeddings_hnsw_"
# pgvector's limit for indexing halfvec.
MAX_DIMENSIONS = 4000


def index_name(dims: int) -> str:
    return f"{PREFIX}halfvec_{int(dims)}"


def distance(dims: int, vector: list[float]) -> ColumnElement[float]:
    """Cosine distance to `vector`, cast to match the index."""
    kind = HALFVEC(int(dims))
    result: ColumnElement[float] = cast(ChunkEmbeddingRow.embedding, kind).cosine_distance(
        cast(vector, kind)
    )
    return result


def same_size(dims: int) -> ColumnElement[bool]:
    """The index's own condition, written as a literal so Postgres can match it even when the
    rest of the query is a prepared statement."""
    return func.vector_dims(ChunkEmbeddingRow.embedding) == literal_column(str(int(dims)))


def stored_dimensions(engine: Engine, model: str) -> int | None:
    with engine.connect() as connection:
        return connection.scalar(
            select(func.vector_dims(ChunkEmbeddingRow.embedding))
            .where(ChunkEmbeddingRow.model == model)
            .limit(1)
        )


def ensure(engine: Engine, model: str) -> bool:
    """Build the index for `model`'s vector size if it is missing or a build was interrupted.
    Returns True when it built one. Takes minutes on a large archive."""
    dims = stored_dimensions(engine, model)
    if dims is None or dims > MAX_DIMENSIONS:
        return False
    name = index_name(dims)
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
        connection.execute(
            text(
                f"CREATE INDEX CONCURRENTLY IF NOT EXISTS {name} ON chunk_embeddings "
                f"USING hnsw ((embedding::halfvec({int(dims)})) halfvec_cosine_ops) "
                f"WHERE vector_dims(embedding) = {int(dims)}"
            )
        )
        log.info("built the search index %s", name)
        return True
