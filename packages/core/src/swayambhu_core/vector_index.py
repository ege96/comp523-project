"""The approximate (HNSW) index semantic search uses, one per vector size.

`chunk_embeddings.embedding` has no fixed size, because the embedding model is a setting.
pgvector can only index a fixed size, so the index is on an expression,
`embedding::halfvec(<dims>)`, limited to rows of that size, and search must cast its
distance in exactly the same way (`distance`, `same_size`) for Postgres to use it.
Half precision halves the index's size; at 90,000 e5-small vectors it found 99% of exact
search's top 10 (with `hnsw.ef_search` 1000), 16x faster (see perf/RESULTS.md).

A migration can't create it, since the size depends on the model, so the worker does
(`swayambhu_worker.search_index`). Until it exists, search still works, by scanning every
embedding.
"""

from pgvector.sqlalchemy import HALFVEC
from sqlalchemy import ColumnElement, cast, func, literal_column

from swayambhu_core.models import ChunkEmbeddingRow

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


def create_statement(dims: int) -> str:
    """CREATE INDEX for vectors of `dims` dimensions. Concurrent, so it blocks neither
    searches nor writes; it must run outside a transaction."""
    return (
        f"CREATE INDEX CONCURRENTLY IF NOT EXISTS {index_name(dims)} ON chunk_embeddings "
        f"USING hnsw ((embedding::halfvec({int(dims)})) halfvec_cosine_ops) "
        f"WHERE vector_dims(embedding) = {int(dims)}"
    )
