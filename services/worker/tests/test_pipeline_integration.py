import uuid
from collections.abc import Sequence
from datetime import timedelta
from itertools import pairwise
from pathlib import Path

import pytest
from audio_helpers import SPEECH_AND_PAUSES, make_audio
from sqlalchemy import func, select, update
from sqlalchemy.orm import Session
from swayambhu_core import jobs
from swayambhu_core.models import (
    ChunkEmbeddingRow,
    InterviewLanguageRow,
    InterviewRow,
    JobRow,
    MediaFileRow,
    SearchChunkRow,
    SegmentRow,
)
from swayambhu_core.storage import LocalMediaStore
from swayambhu_core.text import english_is_stale
from swayambhu_providers import (
    AudioClip,
    EmbeddingKind,
    ProviderError,
    TranscribedSegment,
    Translation,
)
from swayambhu_providers.fake_provider import FakeEmbedder, FakeTranslator

from swayambhu_worker.ingest import ingest
from swayambhu_worker.runner import JobRunner, SessionFactory
from swayambhu_worker.steps import Providers

pytestmark = pytest.mark.integration


class ScriptedTranscriber:
    """Says which piece it heard, in Nepali, reported the way ElevenLabs reports it."""

    name = "test:transcriber"

    def __init__(self) -> None:
        self.hints: set[tuple[str, ...]] = set()

    def transcribe(
        self, clip: AudioClip, language_hints: Sequence[str]
    ) -> list[TranscribedSegment]:
        self.hints.add(tuple(language_hints))
        return [TranscribedSegment(0, clip.duration_ms, f"टुक्रा {clip.path.stem}", "nep")]


class SilentTranscriber(ScriptedTranscriber):
    """Reports no language, like OpenAI's transcription models. The second piece is English."""

    def transcribe(
        self, clip: AudioClip, language_hints: Sequence[str]
    ) -> list[TranscribedSegment]:
        [segment] = super().transcribe(clip, language_hints)
        text = f"piece {clip.path.stem}" if clip.path.stem.endswith("1") else segment.text
        return [TranscribedSegment(0, clip.duration_ms, text, None)]


class DetectingTranslator(FakeTranslator):
    """Detects Devanagari as Nepali ("ne") and anything else as English, like Google."""

    def __init__(self) -> None:
        self.sources: list[str | None] = []

    def translate_to_english(
        self, texts: Sequence[str], source_language: str | None
    ) -> list[Translation]:
        self.sources.append(source_language)
        return [Translation(f"[en] {t}", "ne" if t.startswith("टुक्रा") else "en") for t in texts]


class FlakyTranslator(FakeTranslator):
    def __init__(self, *, retryable: bool) -> None:
        self.failures = 1
        self.retryable = retryable

    def translate_to_english(
        self, texts: Sequence[str], source_language: str | None
    ) -> list[Translation]:
        if self.failures:
            self.failures -= 1
            raise ProviderError("translator down", retryable=self.retryable)
        return super().translate_to_english(texts, source_language)


def start(
    new_session: SessionFactory,
    store: LocalMediaStore,
    tmp_path: Path,
    language: str | None = None,
    translator: FakeTranslator | None = None,
    transcriber: ScriptedTranscriber | None = None,
    recording: Path | None = None,
) -> tuple[uuid.UUID, JobRunner]:
    """Ingest a recording (130 s of speech unless given) and return its id and a runner."""
    recording = recording or make_audio(tmp_path / "talk.wav", SPEECH_AND_PAUSES, 130)
    with new_session() as session:
        interview_id = ingest(session, store, recording, "Test interview", language)
        session.commit()
    providers = Providers(
        transcriber or ScriptedTranscriber(), translator or FakeTranslator(), FakeEmbedder(8)
    )
    return interview_id, JobRunner(new_session, providers, store, lease=timedelta(minutes=10))


def drain(runner: JobRunner) -> int:
    handled = 0
    while runner.handle_one():
        handled += 1
    return handled


def job(session: Session, kind: str) -> JobRow:
    return session.scalars(select(JobRow).where(JobRow.kind == kind)).one()


def test_a_recording_becomes_segments_translations_embeddings_and_playback(
    new_session: SessionFactory, store: LocalMediaStore, tmp_path: Path
) -> None:
    interview_id, runner = start(new_session, store, tmp_path)
    assert drain(runner) == 4  # transcribe, playback, translate, index

    with new_session() as session:
        interview = session.get_one(InterviewRow, interview_id)
        assert (interview.status, interview.status_detail, interview.duration_ms) == (
            "needs_review", None, 130_000,
        )  # fmt: skip
        assert (interview.language_detected, interview.language_detected_confidence) == ("ne", 1)
        assert (interview.translation_status, interview.transcribed_by) == (
            "done", "test:transcriber",
        )  # fmt: skip
        assert session.scalars(select(InterviewLanguageRow.language_code)).all() == ["ne"]
        assert set(session.scalars(select(JobRow.state))) == {"done"}

        segments = session.scalars(select(SegmentRow).order_by(SegmentRow.seq)).all()
        assert (segments[0].start_ms, segments[-1].end_ms) == (0, 130_000)
        assert all(a.end_ms == b.start_ms for a, b in pairwise(segments))
        assert all(5_000 <= s.end_ms - s.start_ms <= 20_000 for s in segments[:-1])
        assert {s.language for s in segments} == {"ne"}
        assert segments[0].english_text == f"[fake ne->en] {segments[0].original_text}"

        chunks = session.scalars(select(SearchChunkRow).order_by(SearchChunkRow.first_seq)).all()
        assert (chunks[0].start_ms, chunks[-1].last_seq) == (0, segments[-1].seq)
        embeddings = session.execute(
            select(ChunkEmbeddingRow.representation, ChunkEmbeddingRow.model)
        ).all()
        assert sorted(embeddings) == sorted(
            [("english", "fake:hash@8"), ("original", "fake:hash@8")] * len(chunks)
        )

        playback = session.scalars(
            select(MediaFileRow).where(MediaFileRow.kind == "playback")
        ).one()
        assert (playback.content_type, playback.storage_key) == (
            "audio/mp4", f"interviews/{interview_id}/playback.m4a",
        )  # fmt: skip
        with store.local_copy(playback.storage_key) as copy:
            assert copy.stat().st_size == playback.size_bytes


def test_the_translator_detects_languages_the_transcriber_did_not_report(
    new_session: SessionFactory, store: LocalMediaStore, tmp_path: Path
) -> None:
    translator = DetectingTranslator()
    interview_id, runner = start(
        new_session, store, tmp_path, None, translator, SilentTranscriber()
    )
    drain(runner)

    assert translator.sources == [None]  # one call, Google detects
    with new_session() as session:
        segments = session.scalars(select(SegmentRow).order_by(SegmentRow.seq)).all()
        assert [s.language for s in segments][:3] == ["ne", "en", "ne"]
        assert (segments[1].english_machine, segments[1].english_text) == (None, None)
        assert segments[0].english_text == f"[en] {segments[0].original_text}"

        interview = session.get_one(InterviewRow, interview_id)
        assert interview.language_detected == "ne"
        assert 0.5 < (interview.language_detected_confidence or 0) < 1
        languages = session.scalars(select(InterviewLanguageRow.language_code)).all()
        assert sorted(languages) == ["en", "ne"]


def test_a_confirmed_language_is_used_instead_of_detection(
    new_session: SessionFactory, store: LocalMediaStore, tmp_path: Path
) -> None:
    translator, transcriber = DetectingTranslator(), SilentTranscriber()
    interview_id, runner = start(new_session, store, tmp_path, "new", translator, transcriber)
    drain(runner)

    assert (transcriber.hints, translator.sources) == ({("new",)}, ["new"])
    with new_session() as session:
        assert set(session.scalars(select(SegmentRow.language))) == {None}
        assert session.get_one(InterviewRow, interview_id).primary_language == "new"


def test_a_translator_outage_is_retried(
    new_session: SessionFactory, store: LocalMediaStore, tmp_path: Path
) -> None:
    translator = FlakyTranslator(retryable=True)
    interview_id, runner = start(new_session, store, tmp_path, None, translator)

    assert drain(runner) == 3  # transcribe, playback, then translate fails and waits
    with new_session() as session:
        translate = job(session, "translate")
        assert (translate.state, translate.attempts, translate.last_error) == (
            "queued", 1, "translator down",
        )  # fmt: skip
        session.execute(update(JobRow).values(run_after=func.now()))  # skip the backoff
        session.commit()

    assert drain(runner) == 2  # translate, index
    with new_session() as session:
        interview = session.get_one(InterviewRow, interview_id)
        assert (interview.status, interview.translation_status) == ("needs_review", "done")


def test_a_permanent_translation_failure_still_indexes_the_original(
    new_session: SessionFactory, store: LocalMediaStore, tmp_path: Path
) -> None:
    translator = FlakyTranslator(retryable=False)
    interview_id, runner = start(new_session, store, tmp_path, None, translator)

    assert drain(runner) == 4
    with new_session() as session:
        interview = session.get_one(InterviewRow, interview_id)
        assert (interview.status, interview.translation_status) == ("needs_review", "failed")
        assert interview.status_detail == "Translation failed: translator down"
        assert set(session.scalars(select(ChunkEmbeddingRow.representation))) == {"original"}


def test_edited_transcripts_are_not_replaced(
    new_session: SessionFactory, store: LocalMediaStore, tmp_path: Path
) -> None:
    interview_id, runner = start(new_session, store, tmp_path)
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
        interview = session.get_one(InterviewRow, interview_id)
        assert interview.status == "failed"
        assert "edited" in (interview.status_detail or "")
        first = select(SegmentRow.original_text).where(SegmentRow.seq == 0)
        assert session.scalar(first) == "सच्याइएको"


class CountingEmbedder(FakeEmbedder):
    def __init__(self) -> None:
        super().__init__(8)
        self.texts: list[str] = []

    def embed(self, texts: Sequence[str], kind: EmbeddingKind) -> list[list[float]]:
        self.texts += texts
        return super().embed(texts, kind)


def test_an_edit_reembeds_only_its_own_chunk(
    new_session: SessionFactory, store: LocalMediaStore, tmp_path: Path
) -> None:
    interview_id, runner = start(new_session, store, tmp_path)
    drain(runner)
    with new_session() as session:
        before = dict(session.execute(select(SearchChunkRow.id, SearchChunkRow.first_seq)).all())
        assert len(before) >= 2
        # What the API does when an admin saves a line: edit it, then queue indexing.
        session.execute(
            update(SegmentRow)
            .where(SegmentRow.seq == 0)
            .values(english_edited="The first line, corrected", edited_at=func.now())
        )
        jobs.enqueue(session, "index", interview_id)
        session.commit()

    embedder = CountingEmbedder()
    providers = Providers(ScriptedTranscriber(), FakeTranslator(), embedder)
    runner = JobRunner(new_session, providers, store, lease=timedelta(minutes=10))
    assert drain(runner) == 1
    assert len(embedder.texts) == 1  # the first chunk's English; its Nepali didn't change
    assert embedder.texts[0].startswith("The first line, corrected ")
    with new_session() as session:
        after = dict(session.execute(select(SearchChunkRow.id, SearchChunkRow.first_seq)).all())
        assert after == before  # chunk rows kept, so their other embeddings were kept too
        assert session.scalar(select(func.count()).select_from(ChunkEmbeddingRow)) == 2 * len(
            before
        )

    # Indexing again with nothing changed embeds nothing.
    with new_session() as session:
        jobs.enqueue(session, "index", interview_id)
        session.commit()
    assert drain(runner) == 1
    assert len(embedder.texts) == 1


class RecordingTranslator(FakeTranslator):
    def __init__(self) -> None:
        self.texts: list[str] = []

    def translate_to_english(
        self, texts: Sequence[str], source_language: str | None
    ) -> list[Translation]:
        self.texts += texts
        return super().translate_to_english(texts, source_language)


def test_retranslation_refreshes_only_lines_whose_original_changed(
    new_session: SessionFactory, store: LocalMediaStore, tmp_path: Path
) -> None:
    interview_id, runner = start(new_session, store, tmp_path)
    drain(runner)
    with new_session() as session:
        assert (
            session.scalar(select(func.count()).where(SegmentRow.english_source_hash.is_(None)))
            == 0
        )
        # Line 0: new words. Line 1: new words, and a human English that must survive.
        # Line 2: punctuation only, so its English is still current.
        for seq, original in ((0, "नयाँ शब्द"), (1, "अर्को शब्द"), (2, None)):
            values: dict[str, object] = {"edited_at": func.now()}
            if original:
                values["original_edited"] = original
            else:
                values["original_edited"] = SegmentRow.original_machine + " ।"
            if seq == 1:
                values["english_edited"] = "Human English"
            session.execute(update(SegmentRow).where(SegmentRow.seq == seq).values(**values))
        jobs.enqueue(session, "retranslate", interview_id)
        session.commit()

    translator = RecordingTranslator()
    providers = Providers(ScriptedTranscriber(), translator, FakeEmbedder(8))
    runner = JobRunner(new_session, providers, store, lease=timedelta(minutes=10))
    assert drain(runner) == 2  # retranslate, then index
    assert sorted(translator.texts) == ["अर्को शब्द", "नयाँ शब्द"]
    with new_session() as session:
        lines = session.scalars(
            select(SegmentRow).where(SegmentRow.seq < 3).order_by(SegmentRow.seq)
        ).all()
        assert lines[0].english_text == "[fake ne->en] नयाँ शब्द"
        assert (lines[1].english_machine, lines[1].english_text) == (
            "[fake ne->en] अर्को शब्द", "Human English",
        )  # fmt: skip
        assert not any(english_is_stale(line) for line in lines)

    # Nothing out of date: no translation and no re-indexing.
    with new_session() as session:
        jobs.enqueue(session, "retranslate", interview_id)
        session.commit()
    assert drain(runner) == 1
    assert len(translator.texts) == 2


def test_switching_embedder_adds_its_vectors_beside_the_old_ones(
    new_session: SessionFactory, store: LocalMediaStore, tmp_path: Path
) -> None:
    interview_id, runner = start(new_session, store, tmp_path)
    drain(runner)
    with new_session() as session:
        jobs.enqueue(session, "index", interview_id)
        session.commit()
    providers = Providers(ScriptedTranscriber(), FakeTranslator(), FakeEmbedder(4))
    runner = JobRunner(new_session, providers, store, lease=timedelta(minutes=10))
    assert drain(runner) == 1
    with new_session() as session:
        chunks = session.scalar(select(func.count()).select_from(SearchChunkRow)) or 0
        models = session.execute(
            select(ChunkEmbeddingRow.model, func.count()).group_by(ChunkEmbeddingRow.model)
        ).all()
        assert sorted(models) == [("fake:hash@4", 2 * chunks), ("fake:hash@8", 2 * chunks)]


def test_a_step_queued_while_it_runs_waits_then_runs_again(
    new_session: SessionFactory, store: LocalMediaStore, tmp_path: Path
) -> None:
    interview_id, runner = start(new_session, store, tmp_path)
    drain(runner)
    with new_session() as session:
        jobs.enqueue(session, "index", interview_id)
        session.commit()
        running = jobs.claim(session, timedelta(minutes=10))
        session.commit()
        assert running is not None
        # An admin saves an edit while that index runs: a second one waits behind it.
        jobs.enqueue(session, "index", interview_id)
        jobs.enqueue(session, "index", interview_id)
        session.commit()
        assert jobs.claim(session, timedelta(minutes=10)) is None  # not while one runs
        queued = select(func.count()).where(JobRow.kind == "index", JobRow.state == "queued")
        assert session.scalar(queued) == 1

        # A retryable failure leaves the retry to the waiting job.
        assert jobs.fail(session, running, "embedder down", retryable=True)
        session.commit()
        assert job_states(session, "index")[-2:] == ["failed", "queued"]
    assert drain(runner) == 1
    with new_session() as session:
        assert job_states(session, "index")[-1] == "done"


def job_states(session: Session, kind: str) -> list[str]:
    return list(
        session.scalars(select(JobRow.state).where(JobRow.kind == kind).order_by(JobRow.id))
    )


def test_unreadable_media_fails_without_retrying(
    new_session: SessionFactory, store: LocalMediaStore, tmp_path: Path
) -> None:
    junk = tmp_path / "junk.mp3"
    junk.write_bytes(b"not audio")
    interview_id, runner = start(new_session, store, tmp_path, recording=junk)

    assert drain(runner) == 2  # transcribe and playback
    with new_session() as session:
        assert session.get_one(InterviewRow, interview_id).status == "failed"
        transcribe = job(session, "transcribe")
        assert (transcribe.state, transcribe.attempts) == ("failed", 1)


def test_a_job_whose_worker_vanished_is_taken_over_then_given_up(
    new_session: SessionFactory, store: LocalMediaStore, tmp_path: Path
) -> None:
    interview_id, runner = start(new_session, store, tmp_path)
    stale = func.now() - timedelta(hours=1)
    with new_session() as session:
        session.execute(update(JobRow).values(state="running", attempts=1, heartbeat_at=stale))
        session.commit()

    assert runner.handle_one()  # attempt 2 takes it over
    with new_session() as session:
        transcribe = job(session, "transcribe")
        assert (transcribe.state, transcribe.attempts) == ("done", 2)
        session.execute(
            update(JobRow)
            .where(JobRow.kind == "translate")
            .values(state="running", attempts=3, heartbeat_at=stale)
        )
        session.commit()

    # Out of attempts, so translation is given up and indexing runs without English.
    assert drain(runner) == 2  # the stale playback job, then index
    with new_session() as session:
        interview = session.get_one(InterviewRow, interview_id)
        assert (interview.status, interview.translation_status) == ("needs_review", "failed")
        assert job(session, "translate").state == "failed"


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
        assert session.scalars(select(JobRow.kind)).all() == ["transcribe", "playback"]
    assert capsys.readouterr().out == f"Queued interview {interview.id}\n"
    assert (tmp_path / "media" / "interviews" / str(interview.id) / "original.mp3").is_file()


def test_the_reindex_command_queues_interviews_missing_the_configured_model(
    new_session: SessionFactory,
    store: LocalMediaStore,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    from swayambhu_worker import reindex

    def run(*args: str) -> str:
        reindex.main(list(args))
        return capsys.readouterr().out

    interview_id, runner = start(new_session, store, tmp_path)
    drain(runner)  # embedded with fake:hash@8
    monkeypatch.setenv("EMBEDDING_PROVIDER", "fake")
    monkeypatch.setenv("EMBEDDING_DIMENSIONS", "8")
    assert run() == "Queued 0 interview(s) for indexing with fake:hash@8\n"

    monkeypatch.setenv("EMBEDDING_DIMENSIONS", "4")  # as if the model changed
    assert run("--dry-run") == (
        f"{interview_id}\nWould queue 1 interview(s) for indexing with fake:hash@4\n"
    )
    assert run() == f"{interview_id}\nQueued 1 interview(s) for indexing with fake:hash@4\n"
    assert run().startswith("Queued 0")  # its index job is already waiting

    providers = Providers(ScriptedTranscriber(), FakeTranslator(), FakeEmbedder(4))
    assert drain(JobRunner(new_session, providers, store, lease=timedelta(minutes=10))) == 1
    with new_session() as session:
        # The old model's vectors stay beside the new ones (index is incremental).
        assert set(session.scalars(select(ChunkEmbeddingRow.model))) == {
            "fake:hash@4", "fake:hash@8",
        }  # fmt: skip
    assert run().startswith("Queued 0")
    assert run("--all").startswith(f"{interview_id}\nQueued 1")
