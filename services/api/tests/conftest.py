from collections.abc import Iterator

import pytest
from alembic import command
from sqlalchemy.engine import make_url
from sqlalchemy.orm import Session

from swayambhu_api.config import Settings
from swayambhu_api.db import new_session
from swayambhu_api.migrate import alembic_config


@pytest.fixture
def integration_settings() -> Settings:
    """Settings for integration tests, which wipe tables and roll migrations back and forth.

    Refuses any database whose name doesn't end in `_test`, so a DATABASE_URL left pointing
    at a real database can't be wiped by running the tests.
    """
    settings = Settings()
    name = make_url(settings.database_url).database or ""
    if not name.endswith("_test"):
        pytest.fail(f"Refusing to run integration tests against database {name!r}: use *_test")
    return settings


@pytest.fixture
def database_url(integration_settings: Settings) -> str:
    """The integration database's URL, migrated to the latest schema."""
    url = integration_settings.database_url
    command.upgrade(alembic_config(url), "head")
    return url


@pytest.fixture
def db_session(integration_settings: Settings, database_url: str) -> Iterator[Session]:
    with new_session(integration_settings) as session:
        yield session
