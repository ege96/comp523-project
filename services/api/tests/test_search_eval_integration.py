import json
from pathlib import Path

import pytest
from sqlalchemy import func, select
from sqlalchemy.orm import Session
from swayambhu_core.models import InterviewRow
from swayambhu_providers.fake_provider import FakeEmbedder

from swayambhu_api.config import Settings
from swayambhu_api.search_eval import (
    EvalSet,
    Expected,
    Query,
    QueryResult,
    evaluate,
    load_interviews,
    main,
)

pytestmark = pytest.mark.integration

SET_PATH = Path(__file__).parents[1] / "eval" / "search_synthetic.json"
EMBEDDER = FakeEmbedder(8)


def by(results: list[QueryResult], mode: str, kind: str) -> list[float]:
    return [r.recall for r in results if r.mode == mode and r.kind == kind]


def test_scores_each_mode_and_saves_nothing(db_session: Session, settings: Settings) -> None:
    eval_set = EvalSet.model_validate_json(SET_PATH.read_text(encoding="utf-8"))
    before = db_session.scalar(select(func.count()).select_from(InterviewRow))
    results = evaluate(db_session, eval_set, EMBEDDER, settings)
    assert len(results) == 3 * len(eval_set.queries)
    # Keyword search finds every query that shares the transcript's words, including a
    # Devanagari word on a line whose translation failed, and no paraphrase. (Fake vectors
    # make semantic scores noise, so they aren't checked.)
    assert by(results, "keyword", "keyword") == [1.0] * 8
    assert by(results, "keyword", "paraphrase") == [0.0] * 6
    assert all(r.recall == 1.0 for r in results if r.mode == "hybrid" and r.kind == "keyword")
    db_session.rollback()
    assert db_session.scalar(select(func.count()).select_from(InterviewRow)) == before

    # Labels against existing interviews name them by id and search the whole archive.
    ids = load_interviews(db_session, eval_set.interviews, EMBEDDER)
    archive = EvalSet(
        synthetic=True, description="ids",
        queries=[Query(q="gold plating", language="en", expect=[
            Expected(interview=str(ids["repairs"]), at_s=35)
        ])],
    )  # fmt: skip
    [keyword, _, hybrid] = evaluate(db_session, archive, EMBEDDER, settings)
    assert (keyword.recall, keyword.first_rank, hybrid.recall) == (1.0, 1, 1.0)
    db_session.rollback()


def test_cli(
    db_session: Session, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setenv("EMBEDDING_PROVIDER", "openai")
    with pytest.raises(SystemExit):
        main([str(SET_PATH)])  # costs money without --allow-paid
    monkeypatch.setenv("EMBEDDING_PROVIDER", "fake")
    main([str(SET_PATH), "--json"])
    payload = json.loads(capsys.readouterr().out)
    assert payload["summary"]["kind=keyword"]["keyword"]["recall"] == 1.0
    main([str(SET_PATH)])
    assert "hybrid R@5" in capsys.readouterr().out
