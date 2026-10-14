from collections.abc import Iterator
from pathlib import Path

import pytest
from alembic import command
from fastapi.testclient import TestClient
from sqlalchemy.engine import make_url
from sqlalchemy.orm import Session

from swayambhu_api.config import Settings, get_settings
from swayambhu_api.db import new_session
from swayambhu_api.main import app
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


@pytest.fixture
def settings(integration_settings: Settings, tmp_path: Path) -> Settings:
    return integration_settings.model_copy(
        update={"media_root": tmp_path, "media_url_secret": None}
    )


@pytest.fixture
def client(settings: Settings) -> Iterator[TestClient]:
    app.dependency_overrides[get_settings] = lambda: settings
    yield TestClient(app)
    app.dependency_overrides.clear()
