"""Steps that call a provider write against what is stored when they finish, not what they
read before the call: admins keep editing while the worker runs."""

import hashlib
from collections.abc import Callable, Iterator, Sequence
from datetime import timedelta
from pathlib import Path
from typing import Any

import pytest
from sqlalchemy import event, func, select, text, update
from swayambhu_core import jobs
from swayambhu_core.models import (
    ChunkEmbeddingRow,
    InterviewLanguageRow,
    InterviewRow,
    JobRow,
    SegmentRow,
)
from swayambhu_core.storage import LocalMediaStore
from swayambhu_core.text import english_is_stale
from swayambhu_providers import AudioClip, EmbeddingKind, TranscribedSegment, Translation
from swayambhu_providers.fake_provider import FakeEmbedder, FakeTranslator
from test_pipeline_integration import ScriptedTranscriber, drain, start

from swayambhu_worker.runner import JobRunner, SessionFactory
from swayambhu_worker.steps import Providers

pytestmark = pytest.mark.integration


def elsewhere(new_session: SessionFactory, statement: Any) -> None:
    """What an admin's request does meanwhile: its own transaction, which gives up rather
    than wait long for a lock."""
    with new_session() as session:
        session.execute(text("SET LOCAL lock_timeout = '2s'"))
        session.execute(statement)
        session.commit()


class TranscriberWithSideEffect(ScriptedTranscriber):
    def __init__(self, during: Callable[[], None], *, silent: bool = False) -> None:
        super().__init__()
        self.during = during
        self.silent = silent

    def transcribe(
        self, clip: AudioClip, language_hints: Sequence[str]
    ) -> list[TranscribedSegment]:
        self.during()
        self.during = lambda: None
        return [] if self.silent else super().transcribe(clip, language_hints)


def runner_with(
    new_session: SessionFactory,
    store: LocalMediaStore,
    transcriber: ScriptedTranscriber | None = None,
    translator: FakeTranslator | None = None,
    embedder: FakeEmbedder | None = None,
) -> JobRunner:
    providers = Providers(
        transcriber or ScriptedTranscriber(),
        translator or FakeTranslator(),
        embedder or FakeEmbedder(8),
    )
    return JobRunner(new_session, providers, store, lease=timedelta(minutes=10))


def first_line(new_session: SessionFactory) -> SegmentRow:
    with new_session() as session:
        return session.scalars(select(SegmentRow).where(SegmentRow.seq == 0)).one()


def test_a_correction_saved_after_retranscription_was_confirmed_is_kept(
    new_session: SessionFactory, store: LocalMediaStore, tmp_path: Path
) -> None:
    interview_id, runner = start(new_session, store, tmp_path)
    drain(runner)
    with new_session() as session:
        session.execute(update(SegmentRow).values(original_edited="पुरानो", edited_at=func.now()))
        session.execute(update(JobRow).values(state="done"))
        jobs.enqueue(session, "retranscribe", interview_id)  # the admin confirmed replacing it
        session.commit()

    # Another correction is saved while the new transcript is being made.
    edit = (
        update(SegmentRow)
        .where(SegmentRow.seq == 1)
        .values(original_edited="नयाँ सच्याइ", edited_at=func.clock_timestamp())
    )
    transcriber = TranscriberWithSideEffect(lambda: elsewhere(new_session, edit))
    assert drain(runner_with(new_session, store, transcriber)) == 1

    with new_session() as session:
        interview = session.get_one(InterviewRow, interview_id)
        assert interview.status == "failed"
        assert "saved after replacing the transcript was confirmed" in (
            interview.status_detail or ""
        )
        line = select(SegmentRow.original_text).where(SegmentRow.seq == 1)
        assert session.scalar(line) == "नयाँ सच्याइ"


def test_an_empty_transcription_keeps_the_existing_transcript(
    new_session: SessionFactory, store: LocalMediaStore, tmp_path: Path
) -> None:
    interview_id, runner = start(new_session, store, tmp_path)
    drain(runner)
    before = first_line(new_session).original_text
    with new_session() as session:
        session.execute(update(JobRow).values(state="done"))
        jobs.enqueue(session, "transcribe", interview_id)
        session.commit()

    silent = TranscriberWithSideEffect(lambda: None, silent=True)
    assert drain(runner_with(new_session, store, silent)) == 1
    with new_session() as session:
        interview = session.get_one(InterviewRow, interview_id)
        assert interview.status == "failed"
        assert "returned no text" in (interview.status_detail or "")
    assert first_line(new_session).original_text == before


def test_a_language_confirmed_during_transcription_is_kept_in_the_filters(
    new_session: SessionFactory, store: LocalMediaStore, tmp_path: Path
) -> None:
    interview_id, _ = start(new_session, store, tmp_path)
    confirm = (
        update(InterviewRow).where(InterviewRow.id == interview_id).values(language_confirmed="new")
    )
    transcriber = TranscriberWithSideEffect(lambda: elsewhere(new_session, confirm))
    drain(runner_with(new_session, store, transcriber))

    with new_session() as session:
        languages = session.scalars(select(InterviewLanguageRow.language_code))
        assert sorted(languages) == ["ne", "new"]  # heard, and confirmed
        interview = session.get_one(InterviewRow, interview_id)
        assert (interview.language_detected, interview.language_confirmed) == ("ne", "new")


class EditingTranslator(FakeTranslator):
    """An admin corrects line 0 while its first English is being made."""

    def __init__(self, new_session: SessionFactory) -> None:
        self.new_session = new_session
        self.calls = 0

    def translate_to_english(
        self, texts: Sequence[str], source_language: str | None
    ) -> list[Translation]:
        self.calls += 1
        if self.calls == 1:
            edit = (
                update(SegmentRow)
                .where(SegmentRow.seq == 0)
                .values(original_edited="सच्याइएको", edited_at=func.now())
            )
            elsewhere(self.new_session, edit)
        return super().translate_to_english(texts, source_language)


def test_a_line_edited_during_the_first_translation_is_translated_again(
    new_session: SessionFactory, store: LocalMediaStore, tmp_path: Path
) -> None:
    translator = EditingTranslator(new_session)
    interview_id, runner = start(new_session, store, tmp_path, translator=translator)
    drain(runner)

    assert translator.calls == 2  # the first translation, then the edited line again
    line = first_line(new_session)
    assert line.english_text == "[fake ne->en] सच्याइएको"
    assert not english_is_stale(line)
    with new_session() as session:
        assert session.get_one(InterviewRow, interview_id).translation_status == "done"


class EmptyTranslator(FakeTranslator):
    def translate_to_english(
        self, texts: Sequence[str], source_language: str | None
    ) -> list[Translation]:
        return [Translation("") for _ in texts]


def test_no_english_at_all_is_a_translation_failure_not_done(
    new_session: SessionFactory, store: LocalMediaStore, tmp_path: Path
) -> None:
    interview_id, runner = start(new_session, store, tmp_path, translator=EmptyTranslator())
    drain(runner)
    with new_session() as session:
        interview = session.get_one(InterviewRow, interview_id)
        assert (interview.status, interview.translation_status) == ("done", "failed")
        assert "returned no English" in (interview.status_detail or "")


class SideEffectEmbedder(FakeEmbedder):
    def __init__(self, during: Callable[[], None]) -> None:
        super().__init__(8)
        self.during = during
        self.texts: list[list[str]] = []

    def embed(self, texts: Sequence[str], kind: EmbeddingKind) -> list[list[float]]:
        self.during()
        self.during = lambda: None
        self.texts.append(list(texts))
        return super().embed(texts, kind)


@pytest.fixture
def embedding_inserts(new_session: SessionFactory) -> Iterator[list[str]]:
    with new_session() as session:
        engine = session.get_bind()
    statements: list[str] = []

    def record(_conn: object, _cursor: object, statement: str, *_: object) -> None:
        if statement.lstrip().upper().startswith("INSERT INTO CHUNK_EMBEDDINGS"):
            statements.append(statement)

    event.listen(engine, "before_cursor_execute", record)
    yield statements
    event.remove(engine, "before_cursor_execute", record)


def test_metadata_can_change_while_embedding_and_vectors_are_written_together(
    new_session: SessionFactory,
    store: LocalMediaStore,
    tmp_path: Path,
    embedding_inserts: list[str],
) -> None:
    interview_id, _ = start(new_session, store, tmp_path)
    rename = update(InterviewRow).where(InterviewRow.id == interview_id).values(title="Renamed")
    embedder = SideEffectEmbedder(lambda: elsewhere(new_session, rename))
    drain(runner_with(new_session, store, embedder=embedder))

    with new_session() as session:
        interview = session.get_one(InterviewRow, interview_id)
        assert (interview.title, interview.status) == ("Renamed", "done")
        vectors = session.scalar(select(func.count()).select_from(ChunkEmbeddingRow)) or 0
    assert vectors == len(embedder.texts[0]) > 2
    assert len(embedding_inserts) == 1


def test_text_edited_while_embedding_is_indexed_again(
    new_session: SessionFactory, store: LocalMediaStore, tmp_path: Path
) -> None:
    interview_id, _ = start(new_session, store, tmp_path)
    edit = (
        update(SegmentRow)
        .where(SegmentRow.interview_id == interview_id, SegmentRow.seq == 0)
        .values(english_edited="Corrected while indexing", edited_at=func.now())
    )
    embedder = SideEffectEmbedder(lambda: elsewhere(new_session, edit))
    drain(runner_with(new_session, store, embedder=embedder))

    assert len(embedder.texts) == 2  # the stale plan was dropped and indexed again
    with new_session() as session:
        hashes = set(session.scalars(select(ChunkEmbeddingRow.source_hash)))
    english = next(t for t in embedder.texts[1] if t.startswith("Corrected while indexing"))
    assert hashlib.sha256(english.encode()).hexdigest() in hashes
