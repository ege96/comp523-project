import random
from pathlib import Path

import numpy as np
import pytest
from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session
from swayambhu_core.models import ChunkEmbeddingRow, IntervieweeRow, InterviewRow, SegmentRow

from swayambhu_api.config import Settings
from swayambhu_api.db import get_engine
from swayambhu_api.perf import ann, bench, corpus, seed

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


def test_bench_split(archive: Settings) -> None:
    rows = bench.split(archive, QUERIES[:3], runs=2)
    assert set(rows) == {"keyword SQL", "vector SQL"} and rows["vector SQL"]["n"] == 6


def _fleurs(directory: Path, sentences: int) -> None:
    """Tiny FLEURS-shaped transcripts: id, file, text, in train/dev/test."""
    for language, word in (("ne_np", "वाक्य"), ("en_us", "sentence")):
        rows = [f"{i}\t{i}.wav\t{word} {i}." for i in range(sentences)]
        for n, split in enumerate(("train", "dev", "test")):
            (directory / f"{language}.{split}.tsv").write_text("\n".join(rows[n::3]) + "\n")


def test_real_corpus_loads_and_ann_bench_compares_indexes(
    archive: Settings, db_session: Session, tmp_path: Path
) -> None:
    _fleurs(tmp_path, 66)  # 11 passages of 6: a Nepali interview of 10, an English one of 1
    interviews = corpus.fleurs_interviews(tmp_path)
    corpus.number_passages(interviews)
    labels = corpus.build_labels(interviews, random.Random(1), per_kind=3)  # noqa: S311
    corpus.write_corpus(tmp_path, {"model": "tiny"}, interviews, labels)
    vectors = np.random.default_rng(1).normal(size=(len(corpus.texts(interviews)), 16))
    np.save(tmp_path / "vectors-0000.npy", vectors.astype(np.float32))
    assert [i.language for i in interviews] == ["ne", "en"]
    assert {label.kind for label in labels} == {"ne->ne", "en->ne", "en->en", "ne->en"}

    # Nepali passages get an original and an English vector, English ones one; one line per
    # sentence, and the Nepali lines carry their human translation.
    counts = seed.seed_corpus(get_engine(archive), tmp_path, None, "fake:hash@16")
    assert counts == seed.Counts(2, 66, 11, 21)
    translated = select(func.count()).where(SegmentRow.english_text.is_not(None))
    assert db_session.scalar(translated) == 60

    result = ann.run(archive, [ann.Query("stupa", "word")], tmp_path, 1, [40], 16, 64, bench.stats)
    assert [v.name for v in result.variants] == ["exact", "hnsw vector ef=40", "hnsw halfvec ef=40"]
    assert (result.vectors, result.labelled, result.queries) == (21, len(labels), len(labels) + 1)
    assert set(result.variants[0].task_recall_at_10) == {
        "all",
        "ne->ne",
        "en->ne",
        "en->en",
        "ne->en",
    }
    assert result.variants[2].index_mb and result.halfvec_mb < result.vector_mb
    with get_engine(archive).connect() as conn:  # each index was rolled back
        assert conn.exec_driver_sql("SELECT to_regclass('perf_ann')").scalar() is None


def test_query_file_and_stats(tmp_path: Path) -> None:
    kinds = {q.kind for q in QUERIES}
    assert kinds == {"word", "phrase", "filter"} and len(QUERIES) == 50
    assert all(q.extra for q in QUERIES if q.kind == "filter")
    s = bench.stats([float(ms) for ms in range(1, 101)])
    assert (s["p50"], round(s["p95"], 2), s["max"]) == (50.5, 95.05, 100.0)
