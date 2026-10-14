import uuid
from collections.abc import Iterator, Sequence
from datetime import date

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete
from sqlalchemy.orm import Session
from swayambhu_core.models import (
    CHUNKER,
    ChunkEmbeddingRow,
    IntervieweeRow,
    InterviewLanguageRow,
    InterviewRow,
    SearchChunkRow,
    SegmentRow,
)
from swayambhu_providers import EmbeddingKind, ProviderError
from swayambhu_providers.fake_provider import FakeEmbedder

from swayambhu_api.main import app
from swayambhu_api.search import get_embedder
from tests.fakes import ADMIN, as_viewer

pytestmark = pytest.mark.integration

EMBEDDER = FakeEmbedder(8)
# (start s, end s, English text); chunks are seq 0-2 and seq 3.
LINES = [
    (0, 10, "We climbed the steps before sunrise"),
    (10, 20, "Everyone brought a little rice"),
    (20, 40, "Then we lit a butter lamp"),
    (40, 80, "The bells rang across the hill"),
]


class BrokenEmbedder:
    name = EMBEDDER.name

    def embed(self, texts: Sequence[str], kind: EmbeddingKind) -> list[list[float]]:
        raise ProviderError("down", retryable=True)


@pytest.fixture
def archive(db_session: Session) -> Iterator[dict[str, uuid.UUID]]:
    """Public and Private Nepali interviews with the same transcript, indexed; a second chunk
    is embedded as "prayer wheels", which no line says. Plus a Public English interview with
    no interviewee or date that hasn't been indexed yet."""
    db_session.execute(delete(InterviewRow))
    db_session.execute(delete(IntervieweeRow))
    maya, hidden = IntervieweeRow(display_name="Maya"), IntervieweeRow(display_name="Hidden")
    db_session.add_all([maya, hidden])
    db_session.flush()
    ids = {}
    for name, visibility, person in (("public", "public", maya), ("private", "private", hidden)):
        interview = InterviewRow(
            title=name, visibility=visibility, interviewee_id=person.id, language_confirmed="ne",
            recorded_on=date(2024, 1, 1), recorded_on_precision="year",
        )  # fmt: skip
        db_session.add(interview)
        db_session.flush()
        db_session.add(InterviewLanguageRow(interview_id=interview.id, language_code="ne"))
        db_session.add_all(
            SegmentRow(
                interview_id=interview.id, seq=seq, start_ms=start * 1000, end_ms=end * 1000,
                language="ne", original_machine=f"नेपाली {seq}", english_machine=english,
            )
            for seq, (start, end, english) in enumerate(LINES)
        )  # fmt: skip
        for first, last, meaning in ((0, 2, "the steps"), (3, 3, "prayer wheels")):
            chunk = SearchChunkRow(
                interview_id=interview.id, chunker=CHUNKER, first_seq=first, last_seq=last,
                start_ms=LINES[first][0] * 1000, end_ms=LINES[last][1] * 1000,
            )  # fmt: skip
            db_session.add(chunk)
            db_session.flush()
            [vector] = EMBEDDER.embed([meaning], "passage")
            db_session.add(
                ChunkEmbeddingRow(
                    chunk_id=chunk.id, model=EMBEDDER.name, representation="english",
                    embedding=vector, source_hash="x",
                )
            )  # fmt: skip
        ids[name] = interview.id
    english = InterviewRow(title="english", visibility="public", language_confirmed="en")
    db_session.add(english)
    db_session.flush()
    db_session.add(InterviewLanguageRow(interview_id=english.id, language_code="en"))
    db_session.add(
        SegmentRow(
            interview_id=english.id, seq=0, start_ms=5000, end_ms=9000, language="en",
            original_machine="We lit butter lamps at dawn",
        )
    )  # fmt: skip
    ids["english"] = english.id
    db_session.commit()
    app.dependency_overrides[get_embedder] = lambda: EMBEDDER
    yield ids
    db_session.rollback()
    db_session.execute(delete(InterviewRow))
    db_session.execute(delete(IntervieweeRow))
    db_session.commit()


Found = tuple[str, int, tuple[int, ...], tuple[str, ...]]  # title, start, seqs, matched_by


def moments(client: TestClient, query: str, mode: str = "hybrid") -> list[Found]:
    body = client.get(f"/api/search?q={query}").json()
    assert set(body) == {"items", "has_more", "search_mode"}  # never a match count
    assert body["search_mode"] == mode
    return [
        (
            m["interview"]["title"], m["start_ms"], tuple(s["seq"] for s in m["excerpt"]),
            tuple(m["matched_by"]),
        )
        for m in body["items"]
    ]  # fmt: skip


@pytest.mark.parametrize("query", ["butter lamp", "prayer wheels"])
def test_visitors_never_get_private_moments(
    client: TestClient, archive: dict[str, uuid.UUID], query: str
) -> None:
    visitor = {found[0] for found in moments(as_viewer(client), query)}
    admin = {found[0] for found in moments(as_viewer(client, ADMIN), query)}
    assert "public" in visitor and "private" not in visitor
    assert admin >= visitor | {"private"}


def test_moments_start_at_the_matching_line_or_the_chunk(
    client: TestClient, archive: dict[str, uuid.UUID]
) -> None:
    visitor = as_viewer(client)
    # Keyword hits, stemmed ("lamps"), in an indexed interview and an unindexed English one.
    # The excerpt stops before the 40 s line that would take it past 30 s.
    found = {f[:3]: f[3] for f in moments(visitor, "butter lamp")}
    assert found[("public", 20_000, (2,))] == ("keyword", "semantic")
    assert found[("english", 5000, (0,))] == ("keyword",)  # no chunks yet
    # Semantic only: no line says it, so the moment is the chunk embedded with that meaning.
    assert moments(visitor, "prayer wheels")[0] == ("public", 40_000, (3,), ("semantic",))

    # The provider is down: keyword hits only, and the response says so.
    app.dependency_overrides[get_embedder] = BrokenEmbedder
    assert moments(visitor, "prayer wheels", "keyword_only") == []
    assert {f[:3] for f in moments(visitor, "butter lamp", "keyword_only")} == {
        ("public", 20_000, (2,)), ("english", 5000, (0,)),
    }  # fmt: skip


@pytest.mark.parametrize(
    ("filters", "expected"),
    [
        ("language=en", {"english"}),
        ("interviewee=unknown", {"english"}),
        ("recorded_from=2024-05-01&recorded_to=2024-05-31", {"public"}),  # year overlaps
        ("recorded_from=2025-01-01", set()),
        ("recorded_from=2025-01-01&undated=true", {"english"}),
    ],
)
def test_filters(
    client: TestClient, archive: dict[str, uuid.UUID], filters: str, expected: set[str]
) -> None:
    body = as_viewer(client).get(f"/api/search?q=butter lamp&{filters}").json()
    assert {m["interview"]["title"] for m in body["items"]} == expected


def test_filter_choices_only_come_from_visible_interviews(
    client: TestClient, archive: dict[str, uuid.UUID]
) -> None:
    body = as_viewer(client).get("/api/search/filters").json()
    assert [p["name"] for p in body["interviewees"]] == ["Maya"]
    assert [lang["code"] for lang in body["languages"]] == ["en", "ne"]
    names = as_viewer(client, ADMIN).get("/api/search/filters").json()["interviewees"]
    assert [p["name"] for p in names] == ["Hidden", "Maya"]
