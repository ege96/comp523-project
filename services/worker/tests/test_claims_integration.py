"""A worker whose job was taken over publishes nothing; playback copies never overwrite the
bytes in use; reindex repair isn't held back by unrelated jobs."""

import uuid
from collections.abc import Sequence
from datetime import timedelta
from pathlib import Path

import pytest
from sqlalchemy import func, select, update
from swayambhu_core import jobs
from swayambhu_core.models import JobRow, MediaFileRow, SegmentRow
from swayambhu_core.storage import LocalMediaStore
from swayambhu_providers import AudioClip, TranscribedSegment
from swayambhu_providers.fake_provider import FakeEmbedder, FakeTranslator
from test_pipeline_integration import ScriptedTranscriber, drain, start

from swayambhu_worker.reindex import needs_index
from swayambhu_worker.runner import JobRunner, SessionFactory
from swayambhu_worker.steps import Providers

pytestmark = pytest.mark.integration

LEASE = timedelta(minutes=10)


def runner_providers() -> Providers:
    return Providers(ScriptedTranscriber(), FakeTranslator(), FakeEmbedder(8))


def take_over(new_session: SessionFactory, kind: str) -> None:
    """What another worker's `claim` does once this one's heartbeat is stale."""
    with new_session() as session:
        session.execute(
            update(JobRow)
            .where(JobRow.kind == kind, JobRow.state == "running")
            .values(attempts=JobRow.attempts + 1, heartbeat_at=func.now())
        )
        session.commit()


def test_a_reclaimed_attempt_cannot_heartbeat_fail_complete_or_publish(
    new_session: SessionFactory, store: LocalMediaStore, tmp_path: Path
) -> None:
    start(new_session, store, tmp_path)
    with new_session() as session:
        first = jobs.claim(session, LEASE)
        session.commit()
        assert first is not None
        session.execute(update(JobRow).values(heartbeat_at=func.now() - timedelta(hours=1)))
        session.commit()
        second = jobs.claim(session, LEASE)
        session.commit()
        assert second is not None
        assert (second.id, second.attempts) == (first.id, 2)

        for stale_write in (
            lambda: jobs.hold_claim(session, first),
            lambda: jobs.heartbeat(session, first),
            lambda: jobs.complete(session, first),
            lambda: jobs.fail(session, first, "x", retryable=True),
            lambda: jobs.fail(session, first, "x", retryable=False),
        ):
            with pytest.raises(jobs.ClaimLostError):
                stale_write()
            session.rollback()

        jobs.hold_claim(session, second)
        jobs.heartbeat(session, second)
        jobs.complete(session, second)
        session.commit()
        assert session.get_one(JobRow, first.id).state == "done"


class TakenOverTranscriber(ScriptedTranscriber):
    """Another worker takes the job over while this one is transcribing."""

    def __init__(self, new_session: SessionFactory) -> None:
        super().__init__()
        self.new_session = new_session

    def transcribe(
        self, clip: AudioClip, language_hints: Sequence[str]
    ) -> list[TranscribedSegment]:
        take_over(self.new_session, "transcribe")
        return super().transcribe(clip, language_hints)


def test_a_worker_whose_job_was_taken_over_writes_nothing(
    new_session: SessionFactory, store: LocalMediaStore, tmp_path: Path
) -> None:
    _, runner = start(new_session, store, tmp_path, transcriber=TakenOverTranscriber(new_session))
    assert runner.handle_one()
    with new_session() as session:
        transcribe = session.scalars(select(JobRow).where(JobRow.kind == "transcribe")).one()
        # Still the new owner's: not completed, failed or retried by the old one.
        assert (transcribe.state, transcribe.attempts, transcribe.last_error) == (
            "running", 2, None,
        )  # fmt: skip
        assert session.scalar(select(func.count()).select_from(SegmentRow)) == 0
        assert session.scalar(select(JobRow.id).where(JobRow.kind == "translate")) is None


def playback_row(new_session: SessionFactory, interview_id: uuid.UUID) -> MediaFileRow:
    with new_session() as session:
        return session.scalars(
            select(MediaFileRow).where(
                MediaFileRow.interview_id == interview_id, MediaFileRow.kind == "playback"
            )
        ).one()


def playback_files(tmp_path: Path, interview_id: uuid.UUID) -> list[str]:
    """Names of the playback copies in the `store` fixture's directory."""
    folder = tmp_path / "media" / "interviews" / str(interview_id)
    return sorted(p.name for p in folder.glob("playback*"))


def test_a_new_playback_copy_gets_its_own_key_and_replaces_the_old_after_commit(
    new_session: SessionFactory, store: LocalMediaStore, tmp_path: Path
) -> None:
    interview_id, runner = start(new_session, store, tmp_path)
    drain(runner)
    old = playback_row(new_session, interview_id)
    with new_session() as session:
        jobs.enqueue(session, "playback", interview_id)
        session.commit()
    assert drain(runner) == 1

    new = playback_row(new_session, interview_id)
    assert new.id == old.id
    assert new.storage_key != old.storage_key
    assert playback_files(tmp_path, interview_id) == [Path(new.storage_key).name]


class TakeOverOnPut(LocalMediaStore):
    def __init__(self, root: Path, new_session: SessionFactory) -> None:
        super().__init__(root)
        self.new_session = new_session

    def put(self, key: str, source: Path, *, move: bool = False) -> None:
        super().put(key, source, move=move)
        take_over(self.new_session, "playback")


def test_a_taken_over_playback_job_keeps_the_current_copy(
    new_session: SessionFactory, store: LocalMediaStore, tmp_path: Path
) -> None:
    interview_id, runner = start(new_session, store, tmp_path)
    drain(runner)
    old = playback_row(new_session, interview_id)
    with new_session() as session:
        jobs.enqueue(session, "playback", interview_id)
        session.commit()

    stale = JobRunner(
        new_session, runner_providers(), TakeOverOnPut(tmp_path / "media", new_session), LEASE
    )
    assert stale.handle_one()

    assert playback_row(new_session, interview_id).storage_key == old.storage_key
    assert playback_files(tmp_path, interview_id) == [Path(old.storage_key).name]


def test_reindex_is_not_held_back_by_playback_but_waits_for_indexing(
    new_session: SessionFactory, store: LocalMediaStore, tmp_path: Path
) -> None:
    interview_id, runner = start(new_session, store, tmp_path)
    drain(runner)
    with new_session() as session:
        jobs.enqueue(session, "playback", interview_id)
        session.commit()
        assert needs_index(session, "other:model") == [interview_id]
        jobs.enqueue(session, "index", interview_id)
        session.commit()
        assert needs_index(session, "other:model") == []
