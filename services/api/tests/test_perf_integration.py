from pathlib import Path

import pytest
from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session
from swayambhu_core.models import ChunkEmbeddingRow, IntervieweeRow, InterviewRow, SegmentRow

from swayambhu_api.config import Settings
from swayambhu_api.db import get_engine
from swayambhu_api.perf import bench, seed

pytestmark = pytest.mark.integration

QUERIES = bench.load_queries(bench.DEFAULT_QUERIES)


@pytest.fixture
def archive(db_session: Session, settings: Settings) -> Settings:
    """A tiny seeded archive (3 interviews x 2 min) with 16-dim fake embeddings."""
    perf = settings.model_copy(update={"embedding_provider": "fake", "embedding_dimensions": 16})
    counts = seed.seed(get_engine(perf), 3, 2, "fake:hash@16", 16)
    # 60 lines of 2 s each, in 2 chunks; Nepali chunks get two vectors, English one.
    assert counts == seed.Counts(3, 180, 6, 10)
    yield perf
    db_session.execute(delete(InterviewRow))
    db_session.execute(delete(IntervieweeRow))
    db_session.commit()


def test_seed_is_repeatable_and_refuses_real_databases(
    archive: Settings, db_session: Session
) -> None:
    first = db_session.scalars(select(SegmentRow.original_text).order_by(SegmentRow.id)).all()
    seed.seed(get_engine(archive), 3, 2, "fake:hash@16", 16)
    again = db_session.scalars(select(SegmentRow.original_text).order_by(SegmentRow.id)).all()
    assert first == again
    public = select(func.count()).where(InterviewRow.visibility == "public")
    assert db_session.scalar(public) == 2
    dims = db_session.scalar(select(func.vector_dims(ChunkEmbeddingRow.embedding)).limit(1))
    assert dims == 16
    with pytest.raises(SystemExit, match="Refusing"):
        seed.check_database("postgresql://u@h/swayambhu")


def test_bench_split_and_hnsw(archive: Settings, capsys: pytest.CaptureFixture[str]) -> None:
    rows = bench.split(archive, QUERIES[:3], runs=2)
    assert set(rows) == {"keyword SQL", "vector SQL"} and rows["vector SQL"]["n"] == 6
    result = bench.hnsw(archive, QUERIES[:3], runs=1, ef_search=100)
    # 10 vectors: the index finds them all, and is gone afterwards.
    assert (result.vectors, result.recall_at_10) == (10, 1.0)
    with get_engine(archive).connect() as conn:
        assert conn.exec_driver_sql("SELECT to_regclass('perf_hnsw')").scalar() is None


def test_query_file_and_stats(tmp_path: Path) -> None:
    kinds = {q.kind for q in QUERIES}
    assert kinds == {"word", "phrase", "filter"} and len(QUERIES) == 50
    assert all(q.extra for q in QUERIES if q.kind == "filter")
    s = bench.stats([float(ms) for ms in range(1, 101)])
    assert (s["p50"], round(s["p95"], 2), s["max"]) == (50.5, 95.05, 100.0)
