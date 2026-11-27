"""Searching transcripts for timestamped moments.

Transcript search merges available keyword and semantic hits with reciprocal rank fusion:
- keyword: Postgres full-text search over display segments, with English stemming on
  English text and the `simple` configuration on original text, so a Devanagari query
  matches Nepali or Nepal Bhasa words directly;
- semantic: the query's embedding against the stored chunk embeddings of the configured model
  (both the original and English representations), by exact cosine distance.

A moment is one search chunk. A keyword hit in a chunk anchors the moment at the
matching line; a semantic-only hit starts at the chunk's first line. A keyword hit in an
interview that hasn't been indexed yet is its own moment, so visitors find what is ready
Results are ranked, never counted: there is no total, only whether more exist.

Interviews whose details (title, description, people, place) match the query's words come
back beside the moments, since such a match has no timestamp of its own.

Every query joins `interviews` and filters with `visible_to`, like the rest of the API.
"""

import logging
import uuid
from collections.abc import Iterable
from dataclasses import dataclass
from functools import lru_cache
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel
from sqlalchemy import (
    ColumnElement,
    Row,
    Select,
    and_,
    case,
    exists,
    func,
    literal,
    literal_column,
    or_,
    select,
    union_all,
)
from swayambhu_core import vector_index
from swayambhu_core.models import (
    CHUNKER,
    ChunkEmbeddingRow,
    IntervieweeRow,
    InterviewLanguageRow,
    InterviewRow,
    LanguageRow,
    SearchChunkRow,
    SegmentRow,
)
from swayambhu_providers import Embedder, ProviderError
from swayambhu_providers.factory import ProviderConfigError, build_embedder

from swayambhu_api.auth import CurrentViewer
from swayambhu_api.config import Settings, get_settings
from swayambhu_api.db import DbSession
from swayambhu_api.filters import InterviewFilters
from swayambhu_api.interviews import (
    InterviewSummary,
    Language,
    Segment,
    summary_query,
    to_segment,
    to_summary,
)
from swayambhu_api.visibility import visible_to

log = logging.getLogger(__name__)
router = APIRouter()

EXCERPT_MAX_SEGMENTS = 10
DETAIL_MATCHES = 5

_ENGLISH: ColumnElement[str] = literal_column("'english'::regconfig")
_SIMPLE: ColumnElement[str] = literal_column("'simple'::regconfig")


@lru_cache
def _embedder() -> Embedder:
    settings = get_settings()
    # A visitor is waiting: give up on the provider quickly and fall back to keywords.
    timeout = {"provider_timeout_seconds": settings.search_embedding_timeout_seconds}
    return build_embedder(settings.model_copy(update=timeout))


def get_embedder() -> Embedder | None:
    """The embedder the worker used for stored chunks (both read the same settings), or None
    when it isn't configured, which leaves keyword search only."""
    try:
        return _embedder()
    except ProviderConfigError as exc:
        log.error("Semantic search is off: %s", exc)
        return None


EmbedderDep = Annotated[Embedder | None, Depends(get_embedder)]

Source = Literal["keyword", "semantic"]


class Moment(BaseModel):
    interview: InterviewSummary
    # The excerpt's span, in ms from the start of the recording. The viewer seeks to
    # start_ms and highlights the first segment.
    start_ms: int
    end_ms: int
    # Original and (when there is one) English text of each line.
    excerpt: list[Segment]
    # Which searches found it. Semantic alone means "related", not that the words appear.
    matched_by: list[Source]


class SearchResults(BaseModel):
    items: list[Moment]
    # Interviews whose details (title, description, interviewee, interviewer, location) match
    # the query's words, best first, at most DETAIL_MATCHES. Only on the first page.
    interviews: list[InterviewSummary]
    # More visible interviews match by their details than `interviews` lists. Only ever true
    # on the first page.
    more_metadata_matches: bool = False
    has_more: bool
    # keyword_only: semantic search was unavailable (provider down, slow or not configured),
    # so the results may miss moments that don't use the query's words.
    search_mode: Literal["hybrid", "keyword_only"]


class Interviewee(BaseModel):
    id: int
    name: str


class SearchFilters(BaseModel):
    """Filter choices drawn only from interviews the viewer may see. Interviews with no
    interviewee or no recording date are reached with `interviewee=unknown` and `undated`."""

    languages: list[Language]
    interviewees: list[Interviewee]


@dataclass(frozen=True)
class Hit:
    """One ranked hit from either search, keyed by the chunk it falls in (None when the
    interview has no chunks yet). `seq` is the line a moment from it would start at."""

    interview_id: uuid.UUID
    chunk_id: int | None
    seq: int


def fuse(ranked: dict[Source, list[Hit]], k: int) -> list[tuple[Hit, list[Source]]]:
    """Reciprocal rank fusion. Each list counts once per moment, at its best rank; the best
    keyword hit's line wins over a chunk's first line."""
    scores: dict[object, float] = {}
    anchors: dict[object, Hit] = {}
    sources: dict[object, list[Source]] = {}
    for source in ("keyword", "semantic"):
        for rank, hit in enumerate(ranked.get(source, [])):
            key = hit.chunk_id if hit.chunk_id is not None else (hit.interview_id, hit.seq)
            if source in sources.setdefault(key, []):
                continue
            sources[key].append(source)
            scores[key] = scores.get(key, 0.0) + 1 / (k + rank + 1)
            anchors.setdefault(key, hit)
    return [(anchors[key], sources[key]) for key in sorted(scores, key=lambda key: -scores[key])]


def keyword_hits(
    session: DbSession,
    viewer: CurrentViewer,
    q: str,
    where: list[ColumnElement[bool]],
    candidates: int,
) -> list[Hit]:
    return _hits(session.execute(_keyword_query(viewer, q, where, candidates)))


def _hits(rows: Iterable[Row[Any]]) -> list[Hit]:
    return [Hit(r.interview_id, r.chunk_id, r.seq) for r in rows]


def _keyword_query(
    viewer: CurrentViewer, q: str, where: list[ColumnElement[bool]], candidates: int
) -> Select[Any]:
    """The `candidates` best keyword moments, best first, with their position (`pos`)."""
    english_q = func.websearch_to_tsquery(_ENGLISH, q)
    simple_q = func.websearch_to_tsquery(_SIMPLE, q)
    # English speech has no english_text, and neither has text whose translation failed.
    untranslated = func.to_tsvector(_ENGLISH, SegmentRow.original_text)
    no_english = SegmentRow.english_text.is_(None)
    rank = func.greatest(
        func.ts_rank_cd(SegmentRow.english_tsv, english_q),
        func.ts_rank_cd(SegmentRow.original_tsv, simple_q),
        case((no_english, func.ts_rank_cd(untranslated, english_q))),
    )
    # Each moment counts once, at its best line, before the cap, so many matching lines in
    # one interview can't crowd every other interview out of the candidates.
    best_in_moment = (
        func.row_number()
        .over(
            partition_by=(
                SegmentRow.interview_id,
                SearchChunkRow.id,
                case((SearchChunkRow.id.is_(None), SegmentRow.seq)),
            ),
            order_by=(rank.desc(), SegmentRow.seq),
        )
        .label("best_in_moment")
    )
    lines = (
        select(
            SegmentRow.interview_id,
            SearchChunkRow.id.label("chunk_id"),
            SegmentRow.seq,
            rank.label("rank"),
            best_in_moment,
        )
        .join(InterviewRow, InterviewRow.id == SegmentRow.interview_id)
        .outerjoin(
            SearchChunkRow,
            and_(
                SearchChunkRow.interview_id == SegmentRow.interview_id,
                SearchChunkRow.chunker == CHUNKER,
                SegmentRow.seq.between(SearchChunkRow.first_seq, SearchChunkRow.last_seq),
            ),
        )
        .where(
            visible_to(viewer.admin),
            *where,
            or_(
                SegmentRow.english_tsv.op("@@")(english_q),
                SegmentRow.original_tsv.op("@@")(simple_q),
                and_(no_english, untranslated.op("@@")(english_q)),
            ),
        )
        .subquery()
    )
    order = (lines.c.rank.desc(), lines.c.interview_id, lines.c.seq)
    return (
        select(
            lines.c.interview_id,
            lines.c.chunk_id,
            lines.c.seq,
            func.row_number().over(order_by=order).label("pos"),
        )
        .where(lines.c.best_in_moment == 1)
        .order_by(*order)
        .limit(candidates)
    )


def _detail_matches(
    session: DbSession, viewer: CurrentViewer, q: str, where: list[ColumnElement[bool]]
) -> tuple[list[InterviewSummary], bool]:
    """The best DETAIL_MATCHES interviews whose details contain the query's words, and
    whether more match. The details are a few short fields per interview, so they are
    matched on the fly rather than indexed."""
    details = func.concat_ws(
        " ",
        InterviewRow.title,
        InterviewRow.description,
        InterviewRow.interviewer,
        InterviewRow.location,
        IntervieweeRow.display_name,
    )
    english_q = func.websearch_to_tsquery(_ENGLISH, q)
    simple_q = func.websearch_to_tsquery(_SIMPLE, q)
    english_tsv = func.to_tsvector(_ENGLISH, details)
    simple_tsv = func.to_tsvector(_SIMPLE, details)
    rank = func.greatest(
        func.ts_rank_cd(english_tsv, english_q), func.ts_rank_cd(simple_tsv, simple_q)
    )
    rows = session.execute(
        summary_query(viewer)
        .where(*where, or_(english_tsv.op("@@")(english_q), simple_tsv.op("@@")(simple_q)))
        .order_by(rank.desc(), InterviewRow.created_at.desc(), InterviewRow.id)
        .limit(DETAIL_MATCHES + 1)
    ).all()
    found = [InterviewSummary.model_validate(to_summary(i, p, lang)) for i, p, lang in rows]
    return found[:DETAIL_MATCHES], len(found) > DETAIL_MATCHES


def semantic_hits(
    session: DbSession,
    viewer: CurrentViewer,
    embedder: Embedder | None,
    q: str,
    where: list[ColumnElement[bool]],
    candidates: int,
) -> list[Hit] | None:
    """None when semantic search is unavailable."""
    vector = _query_vector(embedder, q)
    if embedder is None or vector is None:
        return None
    return _hits(session.execute(_semantic_query(viewer, where, embedder.name, vector, candidates)))


def _query_vector(embedder: Embedder | None, q: str) -> list[float] | None:
    """None when semantic search is unavailable."""
    if embedder is None:
        return None
    try:
        [vector] = embedder.embed([q], "query")
    except ProviderError as exc:
        # Keyword results are still worth returning when the provider is down. The error
        # text can echo the request, and search terms are never logged.
        log.warning("Query embedding failed (retryable=%s); keyword results only", exc.retryable)
        return None
    return vector


def _semantic_query(
    viewer: CurrentViewer,
    where: list[ColumnElement[bool]],
    model: str,
    vector: list[float],
    candidates: int,
) -> Select[Any]:
    """Nearest chunks through the HNSW index (`vector_index`): at half precision, and with
    `hnsw.ef_search` set on every connection (db.py), it returns ~99% of exact search's top
    10. Without the index it scans every embedding, exactly."""
    dims = len(vector)
    return _nearest_query(
        viewer,
        [*where, vector_index.same_size(dims)],
        model,
        vector_index.distance(dims, vector),
        candidates,
    )


def nearest_chunks(
    session: DbSession,
    viewer: CurrentViewer,
    where: list[ColumnElement[bool]],
    model: str,
    distance: ColumnElement[float],
    candidates: int,
) -> list[Hit]:
    return _hits(session.execute(_nearest_query(viewer, where, model, distance, candidates)))


def _nearest_query(
    viewer: CurrentViewer,
    where: list[ColumnElement[bool]],
    model: str,
    distance: ColumnElement[float],
    candidates: int,
) -> Select[Any]:
    """The `candidates` chunks with the nearest embedding, nearest first, with their
    position (`pos`).

    The inner query keeps only the nearest 2 x candidates embeddings. A chunk has at most two
    (original and English), so the k-th best chunk's best embedding ranks at most 2k - 1, and
    the result is still exact. Sorting just (chunk id, distance) pairs this way is far cheaper
    than grouping every 1.5 KB vector row by chunk first, which spilled to disk, and it is the
    shape an HNSW index on `distance` could serve.
    """
    nearest = (
        select(ChunkEmbeddingRow.chunk_id, distance.label("distance"))
        .join(SearchChunkRow, SearchChunkRow.id == ChunkEmbeddingRow.chunk_id)
        .join(InterviewRow, InterviewRow.id == SearchChunkRow.interview_id)
        .where(
            visible_to(viewer.admin),
            *where,
            SearchChunkRow.chunker == CHUNKER,
            ChunkEmbeddingRow.model == model,
        )
        .order_by(distance)
        .limit(2 * candidates)
        .subquery()
    )
    order = (func.min(nearest.c.distance), SearchChunkRow.id)
    return (
        select(
            SearchChunkRow.interview_id,
            SearchChunkRow.id.label("chunk_id"),
            SearchChunkRow.first_seq.label("seq"),
            func.row_number().over(order_by=order).label("pos"),
        )
        .join(nearest, nearest.c.chunk_id == SearchChunkRow.id)
        .group_by(SearchChunkRow.id)
        .order_by(*order)
        .limit(candidates)
    )


def _candidates(
    session: DbSession,
    viewer: CurrentViewer,
    embedder: Embedder | None,
    q: str,
    where: list[ColumnElement[bool]],
    candidates: int,
) -> dict[Source, list[Hit]]:
    """Keyword and semantic candidates in one round trip. "semantic" is missing when
    semantic search is unavailable."""
    vector = _query_vector(embedder, q)
    queries: dict[Source, Select[Any]] = {"keyword": _keyword_query(viewer, q, where, candidates)}
    if embedder is not None and vector is not None:
        queries["semantic"] = _semantic_query(viewer, where, embedder.name, vector, candidates)
    parts = []
    for source, query in queries.items():
        sub = query.subquery()
        parts.append(
            select(
                literal(source).label("source"),
                sub.c.interview_id,
                sub.c.chunk_id,
                sub.c.seq,
                sub.c.pos,
            )
        )
    combined = union_all(*parts).subquery()
    rows = session.execute(select(combined).order_by(combined.c.source, combined.c.pos)).all()
    found: dict[Source, list[Hit]] = {source: [] for source in queries}
    for row in rows:
        found[row.source].append(Hit(row.interview_id, row.chunk_id, row.seq))
    return found


def _excerpts(
    session: DbSession, viewer: CurrentViewer, hits: list[Hit], excerpt_ms: int
) -> tuple[dict[uuid.UUID, InterviewSummary], dict[tuple[uuid.UUID, int], list[Segment]]]:
    """Each hit's interview summary and its lines from the anchor onward, about excerpt_ms
    long, in one query."""
    summaries: dict[uuid.UUID, InterviewSummary] = {}
    by_interview: dict[uuid.UUID, list[SegmentRow]] = {}
    rows = session.execute(
        summary_query(viewer)
        .add_columns(SegmentRow)
        .join(SegmentRow, SegmentRow.interview_id == InterviewRow.id)
        .where(
            or_(
                *(
                    and_(
                        SegmentRow.interview_id == h.interview_id,
                        SegmentRow.seq.between(h.seq, h.seq + EXCERPT_MAX_SEGMENTS - 1),
                    )
                    for h in hits
                )
            ),
        )
        .order_by(SegmentRow.interview_id, SegmentRow.seq)
    ).all()
    for interview, person, language, segment in rows:
        if interview.id not in summaries:
            summaries[interview.id] = InterviewSummary.model_validate(
                to_summary(interview, person, language)
            )
        by_interview.setdefault(interview.id, []).append(segment)
    excerpts: dict[tuple[uuid.UUID, int], list[Segment]] = {}
    for h in hits:
        lines = [s for s in by_interview.get(h.interview_id, []) if s.seq >= h.seq]
        excerpt = lines[:1]
        for line in lines[1:EXCERPT_MAX_SEGMENTS]:
            if line.seq != excerpt[-1].seq + 1 or line.end_ms - excerpt[0].start_ms > excerpt_ms:
                break
            excerpt.append(line)
        excerpts[(h.interview_id, h.seq)] = [to_segment(s) for s in excerpt]
    return summaries, excerpts


@router.get("/api/search", response_model=SearchResults)
def search(
    session: DbSession,
    viewer: CurrentViewer,
    embedder: EmbedderDep,
    settings: Annotated[Settings, Depends(get_settings)],
    q: Annotated[str, Query(min_length=1, max_length=500, pattern=r"\S")],
    where: InterviewFilters,
    limit: Annotated[int, Query(ge=1, le=50)] = 20,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> SearchResults:
    """Transcript moments most relevant to `q`, best first. Paging goes as deep as
    SEARCH_CANDIDATES moments from each search; every page embeds the query and ranks
    them again."""
    try:
        return _search(session, viewer, embedder, settings, q, where, limit, offset)
    finally:
        # Hand the connection back now. FastAPI validates the response on a worker thread;
        # holding the connection while waiting for one let an overload park every
        # connection behind requests that every thread was waiting on (perf/ load test).
        session.close()


def _search(
    session: DbSession,
    viewer: CurrentViewer,
    embedder: Embedder | None,
    settings: Settings,
    q: str,
    where: list[ColumnElement[bool]],
    limit: int,
    offset: int,
) -> SearchResults:
    found = _candidates(session, viewer, embedder, q, where, settings.search_candidates)
    mode: Literal["hybrid", "keyword_only"] = "hybrid" if "semantic" in found else "keyword_only"
    ranked = fuse(found, settings.search_rrf_k)
    page = ranked[offset : offset + limit]
    interviews, more_interviews = (
        _detail_matches(session, viewer, q, where) if offset == 0 else ([], False)
    )
    if not page:
        return SearchResults(
            items=[],
            interviews=interviews,
            more_metadata_matches=more_interviews,
            has_more=False,
            search_mode=mode,
        )

    summaries, excerpts = _excerpts(
        session, viewer, [h for h, _ in page], settings.search_excerpt_ms
    )
    items = []
    for hit, matched_by in page:
        excerpt = excerpts.get((hit.interview_id, hit.seq))
        if hit.interview_id in summaries and excerpt:
            items.append(
                Moment(
                    interview=summaries[hit.interview_id],
                    start_ms=excerpt[0].start_ms,
                    end_ms=excerpt[-1].end_ms,
                    excerpt=excerpt,
                    matched_by=matched_by,
                )
            )
    return SearchResults(
        items=items,
        interviews=interviews,
        more_metadata_matches=more_interviews,
        has_more=len(ranked) > offset + limit,
        search_mode=mode,
    )


@router.get("/api/search/filters", response_model=SearchFilters)
def search_filters(session: DbSession, viewer: CurrentViewer) -> SearchFilters:
    visible = select(InterviewRow.id).where(visible_to(viewer.admin))
    languages = session.execute(
        select(LanguageRow.code, LanguageRow.english_name)
        .where(
            exists().where(
                InterviewLanguageRow.language_code == LanguageRow.code,
                InterviewLanguageRow.interview_id.in_(visible),
            )
        )
        .order_by(LanguageRow.english_name)
    ).all()
    people = session.execute(
        select(IntervieweeRow.id, IntervieweeRow.display_name)
        .where(
            exists().where(
                InterviewRow.interviewee_id == IntervieweeRow.id, visible_to(viewer.admin)
            )
        )
        .order_by(IntervieweeRow.display_name, IntervieweeRow.id)
    ).all()
    return SearchFilters(
        languages=[Language(code=c, name=n) for c, n in languages],
        interviewees=[Interviewee(id=i, name=n) for i, n in people],
    )
