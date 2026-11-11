"""Claims one job from the queue, runs its step and records the outcome.

Every commit a step makes, and the final one, first checks that this worker still holds the
job's claim (`jobs.hold_claim`), so a worker whose job was taken over writes nothing more.
"""

import logging
from collections.abc import Callable
from datetime import timedelta

from sqlalchemy import event
from sqlalchemy.orm import Session
from swayambhu_core import jobs
from swayambhu_core.storage import MediaStore
from swayambhu_providers import ProviderError

from swayambhu_worker import audio
from swayambhu_worker.audio import AudioError
from swayambhu_worker.messages import WORKER_STOPPED, explain
from swayambhu_worker.steps import GIVE_UP, STEPS, Providers, StepError

log = logging.getLogger("swayambhu_worker")

SessionFactory = Callable[[], Session]


class JobRunner:
    def __init__(
        self,
        new_session: SessionFactory,
        providers: Providers,
        store: MediaStore,
        lease: timedelta,
        media_timeout: timedelta = timedelta(seconds=audio.DEFAULT_TIMEOUT_SECONDS),
    ) -> None:
        self._new_session = new_session
        self._providers = providers
        self._store = store
        self._lease = lease
        self._media_timeout = media_timeout

    def handle_one(self) -> bool:
        """Run at most one job. Returns True if there was one."""
        with self._new_session() as session:
            for stale in jobs.reap_stale(session, self._lease):
                log.warning("job %s (%s) abandoned by its worker", stale.id, stale.kind)
                GIVE_UP[stale.kind](session, stale.interview_id, WORKER_STOPPED)
            job = jobs.claim(session, self._lease)
            session.commit()
        if job is None:
            return False

        log.info("job %s: %s %s (attempt %s)", job.id, job.kind, job.interview_id, job.attempts)
        beat = self._beat(job)

        def check_claim(step_session: Session) -> None:
            jobs.hold_claim(step_session, job)

        try:
            with (
                self._new_session() as session,
                audio.supervised(beat, self._media_timeout.total_seconds()),
            ):
                event.listen(session, "before_commit", check_claim)
                STEPS[job.kind](session, job.interview_id, self._providers, self._store, beat)
                # `complete` checks the claim in the final transaction itself.
                event.remove(session, "before_commit", check_claim)
                jobs.complete(session, job)
                session.commit()
        except jobs.ClaimLostError:
            log.warning(
                "job %s attempt %s was taken over; its work is dropped", job.id, job.attempts
            )
        except StepError as exc:  # already written for admins
            self._failed(job, str(exc), str(exc), retryable=False)
        except (AudioError, FileNotFoundError) as exc:
            self._failed(job, str(exc), explain(job.kind, exc), retryable=False)
        except ProviderError as exc:
            self._failed(job, str(exc), explain(job.kind, exc), retryable=exc.retryable)
        except Exception as exc:
            log.exception("job %s crashed", job.id)
            self._failed(job, f"Unexpected error: {exc}", explain(job.kind, exc), retryable=True)
        else:
            log.info("job %s done", job.id)
        return True

    def _beat(self, job: jobs.Job) -> Callable[[], None]:
        def beat() -> None:
            with self._new_session() as session:
                jobs.heartbeat(session, job)
                session.commit()

        return beat

    def _failed(self, job: jobs.Job, error: str, message: str, *, retryable: bool) -> None:
        """`error` is the technical detail, kept on the job for the operator; `message` is
        what admins see on the interview."""
        with self._new_session() as session:
            try:
                retrying = jobs.fail(session, job, error, retryable=retryable)
            except jobs.ClaimLostError:
                log.warning("job %s failed after it was taken over: %s", job.id, error)
                return
            if retrying:
                log.warning("job %s will be retried: %s", job.id, error)
            else:
                log.error("job %s failed: %s", job.id, error)
                GIVE_UP[job.kind](session, job.interview_id, message)
            session.commit()
