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
    MediaFileRow,
    SearchChunkRow,
    SegmentRow,
)
from swayambhu_providers import EmbeddingKind, ProviderError
from swayambhu_providers.fake_provider import FakeEmbedder

from swayambhu_api.config import Settings, get_settings
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


def original(interview_id: uuid.UUID, content_type: str) -> MediaFileRow:
    return MediaFileRow(
        interview_id=interview_id, kind="original", storage_key=f"{interview_id}/original",
        content_type=content_type,
    )  # fmt: skip


@pytest.fixture
def archive(db_session: Session) -> Iterator[dict[str, uuid.UUID]]:
    """Public and Private Nepali video interviews with the same transcript, indexed; a second
    chunk is embedded as "prayer wheels", which no line says. Plus a Public English audio
    interview with no interviewee or date that hasn't been indexed yet."""
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
        db_session.add(original(interview.id, "video/mp4"))
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
    db_session.add(original(english.id, "audio/mpeg"))
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
    # never a count
    assert set(body) == {
        "items", "interviews", "more_metadata_matches", "has_more", "search_mode",
    }  # fmt: skip
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
        ("media=video", {"public"}),
        ("media=audio", {"english"}),
    ],
)
def test_filters(
    client: TestClient, archive: dict[str, uuid.UUID], filters: str, expected: set[str]
) -> None:
    body = as_viewer(client).get(f"/api/search?q=butter lamp&{filters}").json()
    assert {m["interview"]["title"] for m in body["items"]} == expected


@pytest.mark.parametrize(
    ("filters", "expected"),
    [
        ("", {"public", "english"}),
        ("language=ne", {"public"}),
        ("interviewee=unknown", {"english"}),
        ("recorded_from=2024-01-01&recorded_to=2024-12-31", {"public"}),
        ("media=audio", {"english"}),
    ],
)
def test_the_interview_list_takes_the_same_filters(
    client: TestClient, archive: dict[str, uuid.UUID], filters: str, expected: set[str]
) -> None:
    body = as_viewer(client).get(f"/api/interviews?{filters}").json()
    assert {i["title"] for i in body["items"]} == expected
    assert body["total"] == len(expected)


@pytest.mark.parametrize("path", ["/api/search?q=lamp&", "/api/interviews?"])
@pytest.mark.parametrize(
    "dates",
    ["recorded_from=2024-02-01&recorded_to=2024-01-31", "recorded_from=0000-01-01"],
)
def test_reversed_date_ranges_and_year_zero_are_refused(
    client: TestClient, archive: dict[str, uuid.UUID], path: str, dates: str
) -> None:
    assert as_viewer(client).get(f"{path}{dates}").status_code == 422


def test_search_finds_interviews_by_their_details(
    client: TestClient, archive: dict[str, uuid.UUID], db_session: Session
) -> None:
    public = db_session.get(InterviewRow, archive["public"])
    assert public is not None
    public.description = "Recorded at the eastern stairway"
    db_session.commit()

    def titles(viewer: TestClient, query: str, page: str = "") -> list[str]:
        body = viewer.get(f"/api/search?q={query}{page}").json()
        return [i["title"] for i in body["interviews"]]

    visitor = as_viewer(client)
    assert titles(visitor, "Maya") == ["public"]  # the interviewee's name
    assert titles(visitor, "stairways") == ["public"]  # description, stemmed
    assert titles(visitor, "english") == ["english"]  # title, though no line says it
    assert titles(visitor, "Hidden") == []  # a Private interview's interviewee
    assert titles(as_viewer(client, ADMIN), "Hidden") == ["private"]
    assert titles(visitor, "Maya", "&media=audio") == []  # filters apply too
    assert titles(visitor, "Maya", "&offset=20") == []  # first page only


def test_search_says_when_more_interviews_match_by_details(
    client: TestClient, archive: dict[str, uuid.UUID], db_session: Session
) -> None:
    def add(visibility: str) -> None:
        db_session.add(InterviewRow(title="Chorten story", visibility=visibility))
        db_session.commit()

    def overflow(viewer: TestClient, page: str = "") -> tuple[int, bool]:
        body = viewer.get(f"/api/search?q=chorten{page}").json()
        return len(body["interviews"]), body["more_metadata_matches"]

    for _ in range(5):
        add("public")
    add("private")
    assert overflow(as_viewer(client, ADMIN)) == (5, True)
    visitor = as_viewer(client)
    assert overflow(visitor) == (5, False)  # the Private sixth match doesn't count
    add("public")
    assert overflow(visitor) == (5, True)
    assert overflow(visitor, "&offset=20") == (0, False)


def test_many_matching_lines_in_one_moment_leave_room_for_other_interviews(
    client: TestClient, archive: dict[str, uuid.UUID], db_session: Session, settings: Settings
) -> None:
    crowded = InterviewRow(title="crowded", visibility="public")
    other = InterviewRow(title="other", visibility="public")
    db_session.add_all([crowded, other])
    db_session.flush()
    db_session.add_all(
        SegmentRow(
            interview_id=crowded.id, seq=seq, start_ms=seq * 1000, end_ms=seq * 1000 + 1000,
            language="en", original_machine="mandala mandala mandala",
        )
        for seq in range(5)
    )  # fmt: skip
    db_session.add(
        SearchChunkRow(
            interview_id=crowded.id, chunker=CHUNKER, first_seq=0, last_seq=4,
            start_ms=0, end_ms=5000,
        )
    )  # fmt: skip
    db_session.add(
        SegmentRow(
            interview_id=other.id, seq=0, start_ms=0, end_ms=1000, language="en",
            original_machine="a sand mandala",
        )
    )  # fmt: skip
    db_session.commit()
    few = settings.model_copy(update={"search_candidates": 2})
    app.dependency_overrides[get_settings] = lambda: few
    app.dependency_overrides[get_embedder] = BrokenEmbedder

    found = moments(as_viewer(client), "mandala", "keyword_only")
    assert [f[:2] for f in found] == [("crowded", 0), ("other", 0)]


def test_filter_choices_only_come_from_visible_interviews(
    client: TestClient, archive: dict[str, uuid.UUID]
) -> None:
    body = as_viewer(client).get("/api/search/filters").json()
    assert [p["name"] for p in body["interviewees"]] == ["Maya"]
    assert [lang["code"] for lang in body["languages"]] == ["en", "ne"]
    names = as_viewer(client, ADMIN).get("/api/search/filters").json()["interviewees"]
    assert [p["name"] for p in names] == ["Hidden", "Maya"]


def test_filtering_by_a_private_interviewee_finds_nothing_for_visitors(
    client: TestClient, archive: dict[str, uuid.UUID], db_session: Session
) -> None:
    hidden = db_session.get(InterviewRow, archive["private"])
    assert hidden is not None and hidden.interviewee_id is not None
    path = f"/api/search?q=butter lamp&interviewee={hidden.interviewee_id}"
    assert as_viewer(client).get(path).json()["items"] == []
    assert [m["interview"]["title"] for m in as_viewer(client, ADMIN).get(path).json()["items"]]
