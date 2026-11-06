"""Exact vector search vs HNSW indexes (full and half precision), on the search's own query.

Used by `python -m swayambhu_api.perf.bench ann`. For each variant it reports, on the real
search path as a visitor sees it (Public interviews only, nearest 100 chunks):

- latency of the vector query,
- overlap with exact search: the share of exact search's top 10 / top 100 chunks it also
  returns (recall against exact),
- with `--corpus`, task recall: the share of labelled queries whose answer is in the top 10,
  searched as an admin (every interview), by query kind (e.g. ne->en, a Nepali query whose
  answer is an English passage),
- index size, build time and the bytes the vectors take.

All variants use the search's own query (`search.nearest_chunks`): the nearest 2 x N
embeddings, filtered by visibility, then grouped by chunk. With an index, the visibility
filter is applied as the index is walked (pgvector 0.8 iterative scan). The column has no
fixed size, so each index is on an expression, `(embedding::vector(384))` or
`(embedding::halfvec(384))`, and the query's distance casts the same way.
Each index is built inside a transaction that is rolled back, so it never stays behind.
"""

import json
import statistics
import time
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import psycopg
from pgvector.sqlalchemy import HALFVEC, VECTOR
from sqlalchemy import cast, select, text
from sqlalchemy.orm import Session
from swayambhu_core.models import CHUNKER, ChunkEmbeddingRow, InterviewRow, SearchChunkRow
from swayambhu_providers import EmbeddingKind
from swayambhu_providers.factory import build_embedder

from swayambhu_api.admins import Admin
from swayambhu_api.auth import Viewer
from swayambhu_api.config import Settings
from swayambhu_api.db import new_session
from swayambhu_api.search import nearest_chunks, semantic_hits
from swayambhu_api.visibility import visible_to

VISITOR = Viewer(admin=None)
ADMIN = Viewer(admin=Admin(0, "perf"))
OPS = {
    "vector": ("vector", VECTOR, "vector_cosine_ops"),
    "halfvec": ("halfvec", HALFVEC, "halfvec_cosine_ops"),
}


@dataclass(frozen=True)
class Query:
    text: str
    kind: str  # perf/queries.txt kind, or a label kind such as ne->en
    answers: frozenset[int] = frozenset()  # chunk ids that count as a right answer


@dataclass
class Variant:
    name: str
    latency: dict[str, float]
    recall_at_10: float  # against exact search
    recall_at_100: float
    task_recall_at_10: dict[str, float] = field(default_factory=dict)
    index_mb: float | None = None
    build_s: float | None = None
    uses_index: bool | None = None


@dataclass
class AnnResult:
    vectors: int
    queries: int
    labelled: int
    vector_mb: float
    halfvec_mb: float
    settings: dict[str, str]
    variants: list[Variant]
    notices: list[str]


class _Fixed:
    def __init__(self, name: str, vectors: dict[str, list[float]]) -> None:
        self.name = name
        self._vectors = vectors

    def embed(self, texts: Sequence[str], kind: EmbeddingKind) -> list[list[float]]:
        return [self._vectors[t] for t in texts]


def ann_chunks(
    session: Session, viewer: Viewer, model: str, vector: list[float], op: str, dims: int,
    candidates: int,
) -> list[int]:  # fmt: skip
    """The search's nearest chunks, with the distance cast to match an index on
    `embedding::<op>(dims)`."""
    _, kind, _ = OPS[op]
    distance = cast(ChunkEmbeddingRow.embedding, kind(dims)).cosine_distance(
        cast(vector, kind(dims))
    )
    hits = nearest_chunks(session, viewer, [], model, distance, candidates)
    return [h.chunk_id for h in hits if h.chunk_id is not None]


def _overlap(exact: list[list[int]], other: list[list[int]], k: int) -> float:
    return statistics.mean(
        len(set(e[:k]) & set(o[:k])) / max(len(e[:k]), 1) for e, o in zip(exact, other, strict=True)
    )


def _task_recall(labelled: list[Query], results: list[list[int]], k: int) -> dict[str, float]:
    hits: dict[str, list[float]] = {}
    for q, ids in zip(labelled, results, strict=True):
        found = 1.0 if q.answers & set(ids[:k]) else 0.0
        hits.setdefault("all", []).append(found)
        hits.setdefault(q.kind, []).append(found)
    return {kind: statistics.mean(v) for kind, v in sorted(hits.items())}


def load_labels(corpus: Path, session: Session) -> list[Query]:
    # perf.seed --corpus stores each embedding's passage id in source_hash.
    rows = session.execute(
        text(
            "SELECT DISTINCT source_hash, chunk_id FROM chunk_embeddings WHERE source_hash LIKE :p"
        ),
        {"p": "perf-corpus:%"},
    )
    chunk_of = {int(h.split(":")[1]): int(c) for h, c in rows}
    queries = []
    with (corpus / "labels.jsonl").open(encoding="utf-8") as f:
        for line in f:
            label = json.loads(line)
            answers = frozenset(chunk_of[p] for p in label["passage_ids"] if p in chunk_of)
            if answers:  # only labels whose answers are loaded into this archive
                queries.append(Query(label["query"], label["kind"], answers))
    return queries


def run(
    settings: Settings,
    plain: list[Query],
    corpus: Path | None,
    runs: int,
    ef_search: Sequence[int],
    m: int,
    ef_construction: int,
    stats: Callable[..., Any],
) -> AnnResult:
    embedder = build_embedder(settings)  # the API's own, so queries match the stored vectors
    model = embedder.name
    n = settings.search_candidates
    with new_session(settings) as session:
        labelled = load_labels(corpus, session) if corpus else []
        dims = session.scalar(
            text("SELECT vector_dims(embedding) FROM chunk_embeddings WHERE model = :m LIMIT 1"),
            {"m": model},
        )
        if not dims:
            raise SystemExit(f"No {model} embeddings in this database; seed it first")
        queries = plain + labelled
        unique = sorted({q.text for q in queries})
        vectors = dict(zip(unique, embedder.embed(unique, "query"), strict=True))
        fixed = _Fixed(model, vectors)

        def time_all(
            search: Callable[[Query, Viewer], list[int]],
        ) -> tuple[dict[str, float], list[list[int]]]:
            times, results = [], []
            for r in range(runs):
                for q in queries:
                    began = time.perf_counter()
                    ids = search(q, VISITOR)
                    times.append((time.perf_counter() - began) * 1000)
                    if r == 0:
                        results.append(ids)
            return stats(times), results

        def exact(q: Query, viewer: Viewer) -> list[int]:
            hits = semantic_hits(session, viewer, fixed, q.text, [], n) or []
            return [h.chunk_id for h in hits if h.chunk_id is not None]

        size_sql = (
            "SELECT count(*), sum(pg_column_size(embedding)), "  # noqa: S608 (int)
            f"sum(pg_column_size(embedding::halfvec({int(dims)}))) "
            "FROM chunk_embeddings WHERE model = :m"
        )
        sizes = session.execute(text(size_sql), {"m": model}).one()
        mb = 1024 * 1024
        config = {
            k: session.scalar(text(f"SHOW {k}"))
            for k in ("shared_buffers", "maintenance_work_mem", "work_mem")
        }
        exact_latency, exact_ids = time_all(exact)
        variants = [
            Variant(
                "exact",
                exact_latency,
                1.0,
                1.0,
                _task_recall(labelled, [exact(q, ADMIN) for q in labelled], 10),
            )
        ]
        notices: list[str] = []
        _driver(session).add_notice_handler(lambda d: notices.append(d.message_primary or ""))

        for op in ("vector", "halfvec"):
            sql_type, _, opclass = OPS[op]
            began = time.perf_counter()
            session.execute(
                text(
                    f"CREATE INDEX perf_ann ON chunk_embeddings USING hnsw "
                    f"((embedding::{sql_type}({int(dims)})) {opclass}) "
                    f"WITH (m = {int(m)}, ef_construction = {int(ef_construction)})"
                )
            )
            build_s = time.perf_counter() - began
            index_mb = (session.scalar(text("SELECT pg_relation_size('perf_ann')")) or 0) / mb
            session.execute(text("SET LOCAL hnsw.iterative_scan = relaxed_order"))
            for ef in ef_search:
                session.execute(text(f"SET LOCAL hnsw.ef_search = {int(ef)}"))

                def ann(q: Query, viewer: Viewer, op: str = op) -> list[int]:
                    return ann_chunks(session, viewer, model, vectors[q.text], op, dims, n)

                latency, ids = time_all(ann)
                variants.append(
                    Variant(
                        f"hnsw {op} ef={ef}",
                        latency,
                        _overlap(exact_ids, ids, 10),
                        _overlap(exact_ids, ids, 100),
                        _task_recall(labelled, [ann(q, ADMIN) for q in labelled], 10),
                        index_mb,
                        build_s,
                        _uses_index(session, model, vectors[unique[0]], op, int(dims), n),
                    )
                )
            session.rollback()  # drops the index; the next one is built from scratch
        return AnnResult(
            int(sizes[0]),
            len(queries),
            len(labelled),
            sizes[1] / mb,
            sizes[2] / mb,
            config,
            variants,
            sorted(set(notices)),
        )


def _driver(session: Session) -> psycopg.Connection[Any]:
    conn = session.connection().connection.driver_connection
    if not isinstance(conn, psycopg.Connection):
        raise TypeError("expected a psycopg 3 connection")
    return conn


def _uses_index(
    session: Session, model: str, vector: list[float], op: str, dims: int, n: int
) -> bool:
    """Whether the planner walks perf_ann for the visitor query (it may prefer a scan)."""
    _, kind, _ = OPS[op]
    distance = cast(ChunkEmbeddingRow.embedding, kind(dims)).cosine_distance(
        cast(vector, kind(dims))
    )
    query = (
        select(ChunkEmbeddingRow.chunk_id)
        .join(SearchChunkRow, SearchChunkRow.id == ChunkEmbeddingRow.chunk_id)
        .join(InterviewRow, InterviewRow.id == SearchChunkRow.interview_id)
        .where(
            visible_to(None), SearchChunkRow.chunker == CHUNKER, ChunkEmbeddingRow.model == model
        )
        .order_by(distance)
        .limit(2 * n)
    )
    compiled = query.compile(session.get_bind())
    params = {
        k: "[" + ",".join(map(str, v)) + "]" if isinstance(v, list) else v
        for k, v in compiled.params.items()
    }
    # The session's own DB-API connection, so the plan sees the uncommitted index.
    with _driver(session).cursor() as cur:
        cur.execute(f"EXPLAIN {compiled}", params)
        plan = cur.fetchall()
    return any("perf_ann" in row[0] for row in plan)
