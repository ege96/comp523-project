from collections.abc import Iterator
from pathlib import Path

import pytest
from sqlalchemy import text
from sqlalchemy.engine import make_url
from swayambhu_core.models import Base, LanguageRow
from swayambhu_core.storage import LocalMediaStore

from swayambhu_worker.config import WorkerSettings
from swayambhu_worker.db import session_factory
from swayambhu_worker.runner import SessionFactory


@pytest.fixture
def new_session() -> Iterator[SessionFactory]:
    """Sessions on an empty copy of the schema, built from the models.

    The API's migrations are the real schema; its tests check that they match the models.
    Refuses any database whose name doesn't end in `_test`, since every table is dropped.
    """
    url = WorkerSettings().database_url
    if not (make_url(url).database or "").endswith("_test"):
        pytest.fail(f"Refusing to run integration tests against {url!r}: use a *_test database")
    factory = session_factory(WorkerSettings(database_url=url))
    with factory() as session:
        engine = session.get_bind()
        session.execute(text("CREATE EXTENSION IF NOT EXISTS vector"))
        session.commit()
    Base.metadata.drop_all(engine)
    Base.metadata.create_all(engine)
    with factory() as session:
        session.add_all(
            [
                LanguageRow(code="en", english_name="English"),
                LanguageRow(code="ne", english_name="Nepali"),
                LanguageRow(code="new", english_name="Nepal Bhasa"),
            ]
        )
        session.commit()
    yield factory


@pytest.fixture
def store(tmp_path: Path) -> LocalMediaStore:
    return LocalMediaStore(tmp_path / "media")
