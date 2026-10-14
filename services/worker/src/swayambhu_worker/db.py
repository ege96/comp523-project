from functools import partial

from sqlalchemy.orm import Session
from swayambhu_core.db import make_engine

from swayambhu_worker.config import WorkerSettings
from swayambhu_worker.runner import SessionFactory


def session_factory(settings: WorkerSettings) -> SessionFactory:
    # Objects stay readable after commit; steps commit part-way through.
    return partial(Session, make_engine(settings.database_url), expire_on_commit=False)
