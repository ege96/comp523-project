"""Search latency benchmark, on an archive filled by `swayambhu_api.perf.seed`.

    # End to end: each query from perf/queries.txt, 20 times, one at a time, over HTTP
    python -m swayambhu_api.perf.bench latency --url http://localhost:8000 --runs 20
    # Where the time goes: keyword SQL vs vector SQL, in process
    python -m swayambhu_api.perf.bench split
    # Would an HNSW index on the vectors help? Builds one, compares, drops it
    python -m swayambhu_api.perf.bench hnsw

Reports median, p95 and p99 in milliseconds, overall and by query kind (word, phrase,
filter). `latency --max-p95-ms N` exits 1 when p95 is over N, for CI. Run the API with the
same EMBEDDING_* settings the seeder used, so semantic search has vectors to compare.
"""

import argparse
import json
import statistics
import sys
import time
import urllib.parse
import urllib.request
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from pathlib import Path

from sqlalchemy import text
from swayambhu_providers import EmbeddingKind
from swayambhu_providers.factory import build_embedder

from swayambhu_api.auth import Viewer
from swayambhu_api.config import Settings
from swayambhu_api.db import get_engine, new_session
from swayambhu_api.search import keyword_hits, semantic_hits

DEFAULT_QUERIES = Path(__file__).parents[5] / "perf" / "queries.txt"
VISITOR = Viewer(admin=None)


@dataclass(frozen=True)
class PerfQuery:
    kind: str
    q: str
    extra: str  # more query-string parameters, e.g. language=ne


def load_queries(path: Path) -> list[PerfQuery]:
    queries = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.strip() and not line.startswith("#"):
            kind, q, *extra = line.split("\t")
            queries.append(PerfQuery(kind, q, extra[0] if extra else ""))
    return queries


def stats(samples: Sequence[float]) -> dict[str, float]:
    """n, p50, p95, p99 and max of millisecond samples (needs at least two)."""
    cuts = statistics.quantiles(samples, n=100, method="inclusive")
    return {
        "n": len(samples),
        "p50": statistics.median(samples),
        "p95": cuts[94],
        "p99": cuts[98],
        "max": max(samples),
    }


def by_kind(timed: list[tuple[str, float]]) -> dict[str, dict[str, float]]:
    groups: dict[str, list[float]] = {"all": [ms for _, ms in timed]}
    for kind, ms in timed:
        groups.setdefault(kind, []).append(ms)
    return {kind: stats(samples) for kind, samples in groups.items()}


def table(title: str, rows: dict[str, dict[str, float]]) -> str:
    out = [title, f"{'':<12}{'n':>6}{'p50 ms':>10}{'p95 ms':>10}{'p99 ms':>10}{'max ms':>10}"]
    out += [
        f"{name:<12}{int(s['n']):>6}{s['p50']:>10.1f}{s['p95']:>10.1f}{s['p99']:>10.1f}"
        f"{s['max']:>10.1f}"
        for name, s in rows.items()
    ]
    return "\n".join(out)


def _ms(fn: Callable[..., object], *args: object) -> float:
    began = time.perf_counter()
    fn(*args)
    return (time.perf_counter() - began) * 1000


def latency(url: str, queries: list[PerfQuery], runs: int) -> dict[str, dict[str, float]]:
    """Time GET /api/search for each query, `runs` times after one warm-up pass."""

    def get(query: PerfQuery) -> None:
        qs = urllib.parse.urlencode({"q": query.q}) + (f"&{query.extra}" if query.extra else "")
        address = f"{url.rstrip('/')}/api/search?{qs}"
        with urllib.request.urlopen(address, timeout=30) as r:  # noqa: S310 (the developer's URL)
            if "items" not in json.load(r):
                raise RuntimeError(f"Unexpected search response for {query.q!r}")

    for query in queries:
        get(query)
    return by_kind([(q.kind, _ms(get, q)) for _ in range(runs) for q in queries])


class _FixedEmbedder:
    """Answers with vectors computed beforehand, so `split` times only the SQL."""

    def __init__(self, name: str, vectors: dict[str, list[float]]) -> None:
        self.name = name
        self._vectors = vectors

    def embed(self, texts: Sequence[str], kind: EmbeddingKind) -> list[list[float]]:
        return [self._vectors[t] for t in texts]


def split(settings: Settings, queries: list[PerfQuery], runs: int) -> dict[str, dict[str, float]]:
    """Keyword and vector SQL timed apart, as a visitor, without filters."""
    embedder = build_embedder(settings)
    unique = sorted({q.q for q in queries})
    fixed = _FixedEmbedder(
        embedder.name, dict(zip(unique, embedder.embed(unique, "query"), strict=True))
    )
    n = settings.search_candidates
    keyword: list[tuple[str, float]] = []
    vector: list[tuple[str, float]] = []
    with new_session(settings) as session:
        for _ in range(runs):
            for query in queries:
                keyword.append(("keyword", _ms(keyword_hits, session, VISITOR, query.q, [], n)))
                vector.append(
                    ("vector", _ms(semantic_hits, session, VISITOR, fixed, query.q, [], n))
                )
    return {
        "keyword SQL": stats([ms for _, ms in keyword]),
        "vector SQL": stats([ms for _, ms in vector]),
    }


@dataclass(frozen=True)
class HnswResult:
    vectors: int
    build_s: float
    exact: dict[str, float]
    hnsw: dict[str, float]
    recall_at_10: float
    recall_at_100: float


def hnsw(settings: Settings, queries: list[PerfQuery], runs: int, ef_search: int) -> HnswResult:
    """Exact nearest vectors vs an HNSW index, on the raw vector query. Recall is the share of
    the exact top 10 / top 100 vectors that the index also returns. The index is dropped
    afterwards."""
    embedder = build_embedder(settings)
    dims = settings.embedding_dimensions or 384
    vectors = embedder.embed(sorted({q.q for q in queries}), "query")
    # The column has no fixed size, so the index (and the query) cast to one.
    nearest = text(
        f"SELECT chunk_id, representation FROM chunk_embeddings WHERE model = :model "  # noqa: S608 (dims is an int)
        f"ORDER BY embedding::vector({dims}) <=> CAST(:q AS vector({dims})) LIMIT 100"
    )
    with get_engine(settings).connect() as conn:
        count = conn.scalar(
            text("SELECT count(*) FROM chunk_embeddings WHERE model = :m"), {"m": embedder.name}
        )

        def run_all() -> tuple[list[float], list[list[tuple[int, str]]]]:
            times, results = [], []
            for _ in range(runs):
                for v in vectors:
                    params = {"model": embedder.name, "q": str(v)}
                    began = time.perf_counter()
                    ids = [(c, r) for c, r in conn.execute(nearest, params)]
                    times.append((time.perf_counter() - began) * 1000)
                    results.append(ids)
            return times, results

        exact_times, exact_ids = run_all()
        began = time.perf_counter()
        conn.execute(
            text(
                f"CREATE INDEX perf_hnsw ON chunk_embeddings "
                f"USING hnsw ((embedding::vector({dims})) vector_cosine_ops)"
            )
        )
        build_s = time.perf_counter() - began
        conn.execute(text(f"SET hnsw.ef_search = {int(ef_search)}"))
        try:
            hnsw_times, hnsw_ids = run_all()
        finally:
            conn.rollback()  # drops the index: it was built inside this transaction

    def recall(k: int) -> float:
        pairs = list(zip(exact_ids, hnsw_ids, strict=True))
        return statistics.mean(len(set(e[:k]) & set(h[:k])) / max(len(e[:k]), 1) for e, h in pairs)

    return HnswResult(
        count or 0, build_s, stats(exact_times), stats(hnsw_times), recall(10), recall(100)
    )


def main(argv: Sequence[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("latency", "split", "hnsw"):
        cmd = sub.add_parser(name)
        cmd.add_argument("--queries", type=Path, default=DEFAULT_QUERIES)
        cmd.add_argument("--runs", type=int, default=20 if name == "latency" else 5)
        cmd.add_argument("--json", action="store_true")
        if name == "latency":
            cmd.add_argument("--url", required=True, help="the API, e.g. http://localhost:8000")
            cmd.add_argument("--max-p95-ms", type=float, help="exit 1 if overall p95 is above")
        if name == "hnsw":
            cmd.add_argument("--ef-search", type=int, default=200)
    args = parser.parse_args(argv)
    queries = load_queries(args.queries)
    settings = Settings()

    result: object
    if args.command == "latency":
        rows = latency(args.url, queries, args.runs)
        result, report = rows, table(f"GET /api/search, {args.runs} runs per query", rows)
    elif args.command == "split":
        rows = split(settings, queries, args.runs)
        result, report = rows, table(f"Search SQL as a visitor, {args.runs} runs per query", rows)
    else:
        h = hnsw(settings, queries, args.runs, args.ef_search)
        result = h.__dict__
        report = (
            table(
                f"Nearest 100 of {h.vectors} vectors, {args.runs} runs per query",
                {"exact": h.exact, "hnsw": h.hnsw},
            )
            + f"\nHNSW build {h.build_s:.1f} s, ef_search {args.ef_search}: "
            f"recall@10 {h.recall_at_10:.3f}, recall@100 {h.recall_at_100:.3f}"
        )
    if args.json:
        json.dump(result, sys.stdout, indent=2)
        print()
    else:
        print(report)
    if args.command == "latency" and args.max_p95_ms is not None:
        p95 = rows["all"]["p95"]
        if p95 > args.max_p95_ms:
            sys.exit(f"p95 {p95:.0f} ms is over the {args.max_p95_ms:.0f} ms limit")


if __name__ == "__main__":
    main()
