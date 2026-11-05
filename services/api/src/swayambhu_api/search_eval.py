"""Search quality evaluation (Proposal): Recall@K and MRR for keyword, semantic and hybrid
search, using the same queries the search API runs.

    python -m swayambhu_api.search_eval eval/search_synthetic.json
    python -m swayambhu_api.search_eval labels.json --k 10 --json

A set file lists queries, each with the transcript moments a good search returns for it. If
the set also lists interviews, they are loaded, indexed the way the worker indexes them, and
searched on their own (nothing else in the database competes), all in one transaction that is
rolled back, so nothing is saved. Without interviews, each expected moment names an existing
interview by id, and the whole archive is searched as an admin sees it.

A result finds an expected moment when it is in that interview and its chunk (or its line,
for an interview not indexed yet) covers the expected time. Recall@K is the share of a
query's expected moments found in its top K results. MRR is the mean over queries of
1 / rank of the first result that finds one (0 when none of the candidates does).

Semantic scores come from the configured embedder (EMBEDDING_PROVIDER etc.). `fake` gives
meaningless semantic scores but checks the plumbing; `local` gives real numbers offline.
OpenAI charges per call, so it runs only with --allow-paid.
"""

import argparse
import hashlib
import json
import sys
import uuid
from collections import defaultdict
from collections.abc import Sequence
from dataclasses import asdict, dataclass

from pydantic import BaseModel, Field
from sqlalchemy import ColumnElement, select, tuple_
from sqlalchemy.orm import Session
from swayambhu_core.chunking import Timed, chunk_segments, chunk_texts
from swayambhu_core.models import (
    CHUNKER,
    ChunkEmbeddingRow,
    InterviewLanguageRow,
    InterviewRow,
    SearchChunkRow,
    SegmentRow,
)
from swayambhu_providers import Embedder
from swayambhu_providers.factory import build_embedder

from swayambhu_api.admins import Admin
from swayambhu_api.auth import Viewer
from swayambhu_api.config import Settings
from swayambhu_api.db import new_session
from swayambhu_api.search import Hit, Source, fuse, keyword_hits, semantic_hits

MODES: tuple[str, ...] = ("keyword", "semantic", "hybrid")
EMBED_BATCH = 32
# Sees Private interviews too: labelled moments may be in interviews not yet published.
EVAL_VIEWER = Viewer(admin=Admin(0, "search-eval"))


class Line(BaseModel):
    start_s: float
    end_s: float
    text: str  # as spoken
    english: str | None = None  # None: English speech, or a failed translation


class Interview(BaseModel):
    key: str
    title: str
    language: str  # ISO 639 code in the languages table: en, ne, new
    lines: list[Line] = Field(min_length=1)


class Expected(BaseModel):
    interview: str  # a key from `interviews`, or an existing interview's id
    at_s: float


class Query(BaseModel):
    q: str
    language: str  # the query's language, for the per-language breakdown
    kind: str = "unlabelled"  # e.g. keyword (shares words) or paraphrase (doesn't)
    expect: list[Expected] = Field(min_length=1)


class EvalSet(BaseModel):
    synthetic: bool  # True: made-up text for testing the harness, not archive content
    description: str
    interviews: list[Interview] = []
    queries: list[Query] = Field(min_length=1)


@dataclass(frozen=True)
class QueryResult:
    q: str
    language: str
    kind: str
    mode: str
    recall: float
    reciprocal_rank: float
    first_rank: int | None


def load_interviews(
    session: Session, interviews: list[Interview], embedder: Embedder | None
) -> dict[str, uuid.UUID]:
    """Add the set's interviews, chunked and embedded like the worker's index step, as
    Private interviews. Returns their ids by key. The caller rolls them back."""
    ids: dict[str, uuid.UUID] = {}
    pending: list[tuple[int, str, str]] = []  # chunk id, representation, text
    for item in interviews:
        interview = InterviewRow(
            title=f"[search eval] {item.title}", visibility="private", status="done",
            language_confirmed=item.language, translation_status="done",
        )  # fmt: skip
        session.add(interview)
        session.flush()
        session.add(InterviewLanguageRow(interview_id=interview.id, language_code=item.language))
        segments = [
            SegmentRow(
                interview_id=interview.id, seq=seq, start_ms=round(line.start_s * 1000),
                end_ms=round(line.end_s * 1000), language=item.language,
                original_machine=line.text, english_machine=line.english,
            )
            for seq, line in enumerate(item.lines)
        ]  # fmt: skip
        session.add_all(segments)
        session.flush()  # original_text and english_text are computed by Postgres
        for chunk in chunk_segments([Timed(s.seq, s.start_ms, s.end_ms) for s in segments]):
            row = SearchChunkRow(
                interview_id=interview.id, chunker=CHUNKER, first_seq=chunk.first_seq,
                last_seq=chunk.last_seq, start_ms=chunk.start_ms, end_ms=chunk.end_ms,
            )  # fmt: skip
            session.add(row)
            session.flush()
            members = segments[chunk.first_seq : chunk.last_seq + 1]
            pending.extend(
                (row.id, rep, text) for rep, text in chunk_texts(members, interview).items()
            )
        ids[item.key] = interview.id
    if embedder is not None:
        for start in range(0, len(pending), EMBED_BATCH):
            batch = pending[start : start + EMBED_BATCH]
            vectors = embedder.embed([text for _, _, text in batch], "passage")
            session.add_all(
                ChunkEmbeddingRow(
                    chunk_id=chunk_id, model=embedder.name, representation=rep, embedding=vector,
                    source_hash=hashlib.sha256(text.encode()).hexdigest(),
                )
                for (chunk_id, rep, text), vector in zip(batch, vectors, strict=True)
            )  # fmt: skip
        session.flush()
    return ids


def _spans(session: Session, hits: list[Hit]) -> dict[Hit, tuple[int, int]]:
    """The time each hit's moment covers: its chunk, or its line when it has no chunk."""
    chunk_ids = {h.chunk_id for h in hits if h.chunk_id is not None}
    chunks = dict(
        (i, (s, e))
        for i, s, e in session.execute(
            select(SearchChunkRow.id, SearchChunkRow.start_ms, SearchChunkRow.end_ms).where(
                SearchChunkRow.id.in_(chunk_ids)
            )
        )
    )
    lines = {(h.interview_id, h.seq) for h in hits if h.chunk_id is None}
    by_line = {
        (i, q): (s, e)
        for i, q, s, e in session.execute(
            select(SegmentRow.interview_id, SegmentRow.seq, SegmentRow.start_ms, SegmentRow.end_ms)
            .where(tuple_(SegmentRow.interview_id, SegmentRow.seq).in_(lines))
        )
    } if lines else {}  # fmt: skip
    return {
        h: chunks[h.chunk_id] if h.chunk_id is not None else by_line[(h.interview_id, h.seq)]
        for h in hits
    }


def score(
    ranked: list[Hit],
    spans: dict[Hit, tuple[int, int]],
    expected: list[tuple[uuid.UUID, int]],
    k: int,
) -> tuple[float, float, int | None]:
    """(recall@k, reciprocal rank, 1-based rank of the first result that finds a moment)."""

    def finds(hit: Hit, moment: tuple[uuid.UUID, int]) -> bool:
        start, end = spans[hit]
        return hit.interview_id == moment[0] and start <= moment[1] < end

    found = sum(any(finds(h, m) for h in ranked[:k]) for m in expected)
    first = next(
        (rank for rank, h in enumerate(ranked, 1) if any(finds(h, m) for m in expected)), None
    )
    return found / len(expected), (1 / first if first else 0.0), first


def evaluate(
    session: Session,
    eval_set: EvalSet,
    embedder: Embedder | None,
    settings: Settings,
    k: int = 5,
) -> list[QueryResult]:
    """Run every query in every mode. Leaves the set's interviews in the session: roll back."""
    ids = load_interviews(session, eval_set.interviews, embedder)
    where: list[ColumnElement[bool]] = [InterviewRow.id.in_(ids.values())] if ids else []
    n, rrf_k = settings.search_candidates, settings.search_rrf_k
    results = []
    for query in eval_set.queries:
        expected = [
            (
                ids[e.interview] if e.interview in ids else uuid.UUID(e.interview),
                round(e.at_s * 1000),
            )
            for e in query.expect
        ]
        found: dict[Source, list[Hit]] = {
            "keyword": keyword_hits(session, EVAL_VIEWER, query.q, where, n),
            # None (embedding failed or no embedder) scores as no semantic results.
            "semantic": semantic_hits(session, EVAL_VIEWER, embedder, query.q, where, n) or [],
        }
        by_mode = {
            "keyword": fuse({"keyword": found["keyword"]}, rrf_k),
            "semantic": fuse({"semantic": found["semantic"]}, rrf_k),
            "hybrid": fuse(found, rrf_k),
        }
        spans = _spans(session, [h for ranked in by_mode.values() for h, _ in ranked])
        for mode, ranked in by_mode.items():
            recall, rr, first = score([h for h, _ in ranked], spans, expected, k)
            results.append(
                QueryResult(query.q, query.language, query.kind, mode, recall, rr, first)
            )
    return results


def summarize(results: list[QueryResult]) -> dict[str, dict[str, dict[str, float]]]:
    """Mean recall and MRR per mode, overall and by query language and kind:
    {group: {mode: {"recall": .., "mrr": .., "queries": ..}}}."""
    groups: dict[str, dict[str, list[QueryResult]]] = defaultdict(lambda: defaultdict(list))
    for r in results:
        for group in ("all", f"language={r.language}", f"kind={r.kind}"):
            groups[group][r.mode].append(r)
    return {
        group: {
            mode: {
                "recall": sum(r.recall for r in rs) / len(rs),
                "mrr": sum(r.reciprocal_rank for r in rs) / len(rs),
                "queries": len(rs),
            }
            for mode, rs in modes.items()
        }
        for group, modes in sorted(groups.items(), key=lambda item: (item[0] != "all", item[0]))
    }


def report(results: list[QueryResult], k: int, embedder: str) -> str:
    out = [f"Embedder: {embedder}   Chunker: {CHUNKER}", ""]
    header = f"{'group':<22}{'queries':>8}" + "".join(
        f"{mode + f' R@{k}':>16}{mode + ' MRR':>15}" for mode in MODES
    )
    out.append(header)
    for group, modes in summarize(results).items():
        cells = "".join(f"{modes[m]['recall']:>16.2f}{modes[m]['mrr']:>15.2f}" for m in MODES)
        out.append(f"{group:<22}{int(modes['hybrid']['queries']):>8}{cells}")
    misses = [r for r in results if r.mode == "hybrid" and r.recall < 1]
    if misses:
        out += ["", f"Hybrid misses (not all expected moments in the top {k}):"]
        out += [
            f"  [{r.language}/{r.kind}] {r.q}  (first found at rank {r.first_rank})" for r in misses
        ]
    return "\n".join(out)


def main(argv: Sequence[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("set", help="labelled query set (JSON)")
    parser.add_argument("--k", type=int, default=5, help="cut-off for recall (default 5)")
    parser.add_argument("--json", action="store_true", help="print per-query results as JSON")
    parser.add_argument(
        "--allow-paid", action="store_true", help="allow EMBEDDING_PROVIDER=openai (costs money)"
    )
    args = parser.parse_args(argv)
    settings = Settings()
    if settings.embedding_provider == "openai" and not args.allow_paid:
        parser.error("EMBEDDING_PROVIDER=openai charges per call: pass --allow-paid, or use local")
    with open(args.set, encoding="utf-8") as f:
        eval_set = EvalSet.model_validate_json(f.read())
    embedder = build_embedder(settings)
    with new_session(settings) as session:
        try:
            results = evaluate(session, eval_set, embedder, settings, args.k)
        finally:
            session.rollback()
    if args.json:
        payload = {
            "embedder": embedder.name, "chunker": CHUNKER, "k": args.k,
            "synthetic": eval_set.synthetic, "summary": summarize(results),
            "queries": [asdict(r) for r in results],
        }  # fmt: skip
        json.dump(payload, sys.stdout, ensure_ascii=False, indent=2)
        print()
    else:
        if eval_set.synthetic:
            print("Synthetic set: checks the harness, says little about the real archive.\n")
        print(report(results, args.k, embedder.name))


if __name__ == "__main__":
    main()
