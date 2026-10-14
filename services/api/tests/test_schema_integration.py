"""The interview/segment schema (migration 0002) and the shared visibility filter."""

import uuid
from collections.abc import Iterator

import pytest
from sqlalchemy import delete, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from swayambhu_core.models import (
    ChunkEmbeddingRow,
    InterviewLanguageRow,
    InterviewRow,
    LanguageRow,
    MediaFileRow,
    SearchChunkRow,
    SegmentRow,
)

from swayambhu_api.admins import Admin
from swayambhu_api.visibility import visible_to

pytestmark = pytest.mark.integration

ADMIN = Admin(id=1, email="admin@example.org")


@pytest.fixture
def session(db_session: Session) -> Iterator[Session]:
    db_session.execute(delete(InterviewRow))
    db_session.commit()
    yield db_session
    db_session.rollback()
    db_session.execute(delete(InterviewRow))
    db_session.commit()


def add_interview(session: Session, title: str, visibility: str) -> uuid.UUID:
    row = InterviewRow(title=title, visibility=visibility)
    session.add(row)
    session.flush()
    session.add(
        SegmentRow(
            interview_id=row.id, seq=0, start_ms=0, end_ms=12_000, original_machine=f"{title} text"
        )
    )
    session.commit()
    return row.id


def test_languages_are_seeded(session: Session) -> None:
    names = dict(session.execute(select(LanguageRow.code, LanguageRow.english_name)).all())
    assert names == {"en": "English", "ne": "Nepali", "new": "Nepal Bhasa"}


def test_new_interview_defaults_to_private_and_processing(session: Session) -> None:
    row = InterviewRow(title="Untitled")
    session.add(row)
    session.commit()
    session.refresh(row)
    assert (row.visibility, row.status, row.translation_status) == (
        "private",
        "processing",
        "pending",
    )
    assert isinstance(row.id, uuid.UUID)


def test_anonymous_sees_only_public_interviews_and_segments(session: Session) -> None:
    public = add_interview(session, "Public one", "public")
    private = add_interview(session, "Private one", "private")

    def interview_ids(viewer: Admin | None) -> set[uuid.UUID]:
        return set(session.scalars(select(InterviewRow.id).where(visible_to(viewer))))

    def segment_texts(viewer: Admin | None) -> set[str]:
        stmt = select(SegmentRow.original_text).join(InterviewRow).where(visible_to(viewer))
        return set(session.scalars(stmt))

    assert interview_ids(None) == {public}
    assert segment_texts(None) == {"Public one text"}
    assert interview_ids(ADMIN) == {public, private}
    assert segment_texts(ADMIN) == {"Public one text", "Private one text"}


def test_publish_does_not_depend_on_status(session: Session) -> None:
    """D-008: a Public interview is visible while still processing."""
    interview_id = add_interview(session, "In progress", "public")
    status = session.scalar(
        select(InterviewRow.status).where(InterviewRow.id == interview_id, visible_to(None))
    )
    assert status == "processing"


def test_edits_are_kept_apart_from_machine_text(session: Session) -> None:
    interview_id = add_interview(session, "Edits", "private")
    segment = session.scalars(
        select(SegmentRow).where(SegmentRow.interview_id == interview_id)
    ).one()
    segment.english_machine = "machine english"
    session.commit()
    session.refresh(segment)
    assert segment.english_text == "machine english"

    segment.english_edited = "corrected english"
    session.commit()
    session.refresh(segment)
    assert (segment.english_machine, segment.english_text) == (
        "machine english",
        "corrected english",
    )


def test_keyword_columns_index_devanagari_and_english(session: Session) -> None:
    interview_id = add_interview(session, "Keywords", "private")
    session.add(
        SegmentRow(
            interview_id=interview_id,
            seq=1,
            start_ms=12_000,
            end_ms=20_000,
            language="ne",
            original_machine="स्वयम्भू महाचैत्य को इतिहास",
            english_machine="The history of the Swayambhu stupa",
        )
    )
    session.commit()

    def hits(column: object, config: str, query: str) -> int:
        stmt = select(func.count()).where(
            SegmentRow.interview_id == interview_id,
            column.op("@@")(func.plainto_tsquery(config, query)),  # type: ignore[attr-defined]
        )
        return session.scalar(stmt) or 0

    assert hits(SegmentRow.original_tsv, "simple", "महाचैत्य") == 1
    assert hits(SegmentRow.english_tsv, "english", "histories") == 1  # stemmed


def test_segment_times_must_be_ordered(session: Session) -> None:
    interview_id = add_interview(session, "Times", "private")
    session.add(
        SegmentRow(interview_id=interview_id, seq=1, start_ms=5, end_ms=5, original_machine="x")
    )
    with pytest.raises(IntegrityError):
        session.commit()


def test_embeddings_take_any_dimension_and_cascade(session: Session) -> None:
    """The vector size comes from config, so the column must accept any dimension."""
    interview_id = add_interview(session, "Vectors", "private")
    session.add(InterviewLanguageRow(interview_id=interview_id, language_code="new"))
    session.add(
        MediaFileRow(
            interview_id=interview_id,
            kind="original",
            storage_key="dev/abc",
            content_type="video/mp4",
        )
    )
    chunk = SearchChunkRow(
        interview_id=interview_id,
        chunker="time-60s-v1",
        first_seq=0,
        last_seq=0,
        start_ms=0,
        end_ms=12_000,
    )
    session.add(chunk)
    session.flush()
    session.add_all(
        [
            ChunkEmbeddingRow(
                chunk_id=chunk.id,
                model="small",
                representation="english",
                embedding=[0.1, 0.2, 0.3],
                source_hash="h1",
            ),
            ChunkEmbeddingRow(
                chunk_id=chunk.id,
                model="large",
                representation="original",
                embedding=[0.1] * 5,
                source_hash="h1",
            ),
        ]
    )
    session.commit()

    nearest = session.scalar(
        select(ChunkEmbeddingRow.representation)
        .where(ChunkEmbeddingRow.model == "small")
        .order_by(ChunkEmbeddingRow.embedding.cosine_distance([0.1, 0.2, 0.3]))
    )
    assert nearest == "english"

    session.execute(delete(InterviewRow).where(InterviewRow.id == interview_id))
    session.commit()
    for table in (SegmentRow, SearchChunkRow, ChunkEmbeddingRow, MediaFileRow):
        assert session.scalar(select(func.count()).select_from(table)) == 0
    assert session.scalar(select(func.count()).select_from(InterviewLanguageRow)) == 0
