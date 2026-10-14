import uuid
from collections.abc import Sequence
from datetime import timedelta
from itertools import pairwise
from pathlib import Path

import pytest
from audio_helpers import SPEECH_AND_PAUSES, make_audio
from sqlalchemy import func, select, update
from swayambhu_core import jobs
from swayambhu_core.models import (
    ChunkEmbeddingRow,
    InterviewLanguageRow,
    InterviewRow,
    JobRow,
    SearchChunkRow,
    SegmentRow,
)
from swayambhu_core.storage import LocalMediaStore
from swayambhu_providers import AudioClip, ProviderError, TranscribedSegment
from swayambhu_providers.fake_provider import FakeEmbedder, FakeTranslator

from swayambhu_worker.ingest import ingest
from swayambhu_worker.runner import JobRunner, SessionFactory
from swayambhu_worker.steps import Providers

pytestmark = pytest.mark.integration


class ScriptedTranscriber:
    """Says which piece it heard, in Nepali, reported the way ElevenLabs reports it."""

    name = "test:transcriber"

    def __init__(self) -> None:
        self.hints: list[Sequence[str]] = []

    def transcribe(
        self, clip: AudioClip, language_hints: Sequence[str]
    ) -> list[TranscribedSegment]:
        self.hints.append(language_hints)
        return [TranscribedSegment(0, clip.duration_ms, f"टुक्रा {clip.path.stem}", "nep")]


class FlakyTranslator(FakeTranslator):
    def __init__(self, failures: int, *, retryable: bool) -> None:
        self.failures = failures
        self.retryable = retryable

    def translate_to_english(self, texts: Sequence[str], source_language: str | None) -> list[str]:
        if self.failures:
            self.failures -= 1
            raise ProviderError("translator down", retryable=self.retryable)
        return super().translate_to_english(texts, source_language)


def make_runner(
    new_session: SessionFactory, store: LocalMediaStore, translator: FakeTranslator | None = None
) -> JobRunner:
    providers = Providers(ScriptedTranscriber(), translator or FakeTranslator(), FakeEmbedder(8))
    return JobRunner(new_session, providers, store, lease=timedelta(minutes=10))


def add_interview(
    new_session: SessionFactory, store: LocalMediaStore, tmp_path: Path, language: str | None
) -> uuid.UUID:
    recording = make_audio(tmp_path / "talk.wav", SPEECH_AND_PAUSES, 130)
    with new_session() as session:
        interview_id = ingest(session, store, recording, "Test interview", language)
        session.commit()
    return interview_id


def drain(runner: JobRunner) -> int:
    handled = 0
    while runner.handle_one():
        handled += 1
    return handled


def make_due(new_session: SessionFactory) -> None:
    """Skip the retry backoff."""
    with new_session() as session:
        session.execute(update(JobRow).values(run_after=func.now()))
        session.commit()


def test_a_recording_becomes_segments_translations_and_embeddings(
    new_session: SessionFactory, store: LocalMediaStore, tmp_path: Path
) -> None:
    interview_id = add_interview(new_session, store, tmp_path, None)
    runner = make_runner(new_session, store)

    assert drain(runner) == 3  # transcribe, translate, index

    with new_session() as session:
        interview = session.get(InterviewRow, interview_id)
        assert interview is not None
        assert (interview.status, interview.status_detail) == ("needs_review", None)
        assert interview.duration_ms == 130_000
        assert (interview.language_detected, interview.language_detected_confidence) == ("ne", 1)
        assert interview.translation_status == "done"
        assert (interview.transcribed_by, interview.translated_by) == (
            "test:transcriber",
            "fake:translator",
        )
        assert session.scalars(select(InterviewLanguageRow.language_code)).all() == ["ne"]

        segments = session.scalars(select(SegmentRow).order_by(SegmentRow.seq)).all()
        assert segments[0].start_ms == 0
        assert segments[-1].end_ms == 130_000
        assert all(a.end_ms == b.start_ms for a, b in pairwise(segments))
        assert all(5_000 <= s.end_ms - s.start_ms <= 20_000 for s in segments[:-1])
        assert {s.language for s in segments} == {"ne"}
        assert segments[0].english_text == f"[fake ne->en] {segments[0].original_text}"

        chunks = session.scalars(select(SearchChunkRow).order_by(SearchChunkRow.first_seq)).all()
        assert chunks[0].start_ms == 0
        assert chunks[-1].last_seq == segments[-1].seq
        embeddings = session.scalars(select(ChunkEmbeddingRow)).all()
        assert sorted(e.representation for e in embeddings) == sorted(
            ["english", "original"] * len(chunks)
        )
        assert {e.model for e in embeddings} == {"fake:hash@8"}
        assert session.scalar(select(func.count()).select_from(JobRow)) == 3
        assert set(session.scalars(select(JobRow.state))) == {"done"}


def test_a_confirmed_language_is_passed_to_the_transcriber_and_english_is_not_translated(
    new_session: SessionFactory, store: LocalMediaStore, tmp_path: Path
) -> None:
    interview_id = add_interview(new_session, store, tmp_path, "en")
    runner = make_runner(new_session, store)
    transcriber = runner._providers.transcriber
    assert isinstance(transcriber, ScriptedTranscriber)

    drain(runner)

    assert set(map(tuple, transcriber.hints)) == {("en",)}
    with new_session() as session:
        interview = session.get(InterviewRow, interview_id)
        assert interview is not None
        assert interview.translation_status == "done"  # segments still reported Nepali
        assert interview.primary_language == "en"


def test_a_translator_outage_is_retried(
    new_session: SessionFactory, store: LocalMediaStore, tmp_path: Path
) -> None:
    interview_id = add_interview(new_session, store, tmp_path, None)
    runner = make_runner(new_session, store, FlakyTranslator(1, retryable=True))

    assert drain(runner) == 2  # transcribe, then translate fails and waits for its retry
    with new_session() as session:
        job = session.scalars(select(JobRow).where(JobRow.kind == "translate")).one()
        assert (job.state, job.attempts, job.last_error) == ("queued", 1, "translator down")

    make_due(new_session)
    assert drain(runner) == 2  # translate, index
    with new_session() as session:
        interview = session.get(InterviewRow, interview_id)
        assert interview is not None
        assert (interview.status, interview.translation_status) == ("needs_review", "done")


def test_a_permanent_translation_failure_still_indexes_the_original(
    new_session: SessionFactory, store: LocalMediaStore, tmp_path: Path
) -> None:
    interview_id = add_interview(new_session, store, tmp_path, None)
    runner = make_runner(new_session, store, FlakyTranslator(1, retryable=False))

    assert drain(runner) == 3
    with new_session() as session:
        interview = session.get(InterviewRow, interview_id)
        assert interview is not None
        assert (interview.status, interview.translation_status) == ("needs_review", "failed")
        assert interview.status_detail == "Translation failed: translator down"
        representations = set(session.scalars(select(ChunkEmbeddingRow.representation)))
        assert representations == {"original"}


def test_edited_transcripts_are_not_replaced(
    new_session: SessionFactory, store: LocalMediaStore, tmp_path: Path
) -> None:
    interview_id = add_interview(new_session, store, tmp_path, None)
    runner = make_runner(new_session, store)
    drain(runner)
    with new_session() as session:
        session.execute(
            update(SegmentRow)
            .where(SegmentRow.seq == 0)
            .values(original_edited="सच्याइएको", edited_at=func.now())
        )
        session.execute(update(JobRow).values(state="done"))
        jobs.enqueue(session, "transcribe", interview_id)
        session.commit()

    assert drain(runner) == 1
    with new_session() as session:
        interview = session.get(InterviewRow, interview_id)
        assert interview is not None
        assert interview.status == "failed"
        assert "edited" in (interview.status_detail or "")
        assert session.scalar(select(SegmentRow.original_text).where(SegmentRow.seq == 0)) == (
            "सच्याइएको"
        )


def test_unreadable_media_fails_without_retrying(
    new_session: SessionFactory, store: LocalMediaStore, tmp_path: Path
) -> None:
    junk = tmp_path / "junk.mp3"
    junk.write_bytes(b"not audio")
    with new_session() as session:
        interview_id = ingest(session, store, junk, "Broken", None)
        session.commit()

    assert drain(make_runner(new_session, store)) == 1
    with new_session() as session:
        interview = session.get(InterviewRow, interview_id)
        job = session.scalars(select(JobRow)).one()
        assert interview is not None
        assert interview.status == "failed"
        assert (job.state, job.attempts) == ("failed", 1)


def test_a_job_whose_worker_vanished_is_taken_over_then_given_up(
    new_session: SessionFactory, store: LocalMediaStore, tmp_path: Path
) -> None:
    interview_id = add_interview(new_session, store, tmp_path, None)
    stale = func.now() - timedelta(hours=1)
    with new_session() as session:
        session.execute(update(JobRow).values(state="running", attempts=1, heartbeat_at=stale))
        session.commit()

    runner = make_runner(new_session, store)
    assert runner.handle_one()  # attempt 2 takes it over
    with new_session() as session:
        job = session.scalars(select(JobRow).where(JobRow.kind == "transcribe")).one()
        assert (job.state, job.attempts) == ("done", 2)

        session.execute(
            update(JobRow)
            .where(JobRow.kind == "translate")
            .values(state="running", attempts=3, heartbeat_at=stale)
        )
        session.commit()

    # Out of attempts, so translation is given up and indexing runs without English.
    assert drain(runner) == 1
    with new_session() as session:
        interview = session.get(InterviewRow, interview_id)
        assert interview is not None
        assert (interview.status, interview.translation_status) == ("needs_review", "failed")
        job = session.scalars(select(JobRow).where(JobRow.kind == "translate")).one()
        assert job.state == "failed"


def test_the_ingest_command_queues_a_file(
    new_session: SessionFactory,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    from swayambhu_worker import ingest as ingest_cli

    monkeypatch.setenv("MEDIA_ROOT", str(tmp_path / "media"))
    recording = make_audio(tmp_path / "Talk.MP3", SPEECH_AND_PAUSES, 3)
    ingest_cli.main([str(recording), "--title", "From the CLI", "--language", "new"])

    with new_session() as session:
        interview = session.scalars(select(InterviewRow)).one()
        assert (interview.title, interview.language_confirmed) == ("From the CLI", "new")
        assert session.scalars(select(JobRow.kind)).all() == ["transcribe"]
    assert capsys.readouterr().out == f"Queued interview {interview.id}\n"
    assert (tmp_path / "media" / "interviews" / str(interview.id) / "original.mp3").is_file()
