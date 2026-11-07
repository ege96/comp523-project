"""Claims one job from the queue, runs its step and records the outcome."""

import logging
from collections.abc import Callable
from datetime import timedelta

from sqlalchemy.orm import Session
from swayambhu_core import jobs
from swayambhu_core.storage import MediaStore
from swayambhu_providers import ProviderError

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
    ) -> None:
        self._new_session = new_session
        self._providers = providers
        self._store = store
        self._lease = lease

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
        try:
            with self._new_session() as session:
                STEPS[job.kind](
                    session, job.interview_id, self._providers, self._store, self._beat(job)
                )
                jobs.complete(session, job)
                session.commit()
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
            if jobs.fail(session, job, error, retryable=retryable):
                log.warning("job %s will be retried: %s", job.id, error)
            else:
                log.error("job %s failed: %s", job.id, error)
                GIVE_UP[job.kind](session, job.interview_id, message)
            session.commit()
