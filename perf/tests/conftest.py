from collections.abc import Iterator
from pathlib import Path

import pytest
from alembic import command
from sqlalchemy.engine import make_url
from sqlalchemy.orm import Session
from swayambhu_api.config import Settings
from swayambhu_api.db import new_session
from swayambhu_api.migrate import alembic_config


@pytest.fixture
def settings(tmp_path: Path) -> Settings:
    """Settings for the integration tests, which wipe tables. Like the API's own tests, they
    refuse any database whose name doesn't end in `_test`, and migrate it to the latest schema."""
    settings = Settings()
    name = make_url(settings.database_url).database or ""
    if not name.endswith("_test"):
        pytest.fail(f"Refusing to run integration tests against database {name!r}: use *_test")
    command.upgrade(alembic_config(settings.database_url), "head")
    return settings.model_copy(update={"media_root": tmp_path, "media_url_secret": None})


@pytest.fixture
def db_session(settings: Settings) -> Iterator[Session]:
    with new_session(settings) as session:
        yield session
