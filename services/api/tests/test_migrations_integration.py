import os
import subprocess
import sys

import pytest
from alembic import command
from sqlalchemy import create_engine, inspect, text

from swayambhu_api.db import sqlalchemy_url
from swayambhu_api.migrate import alembic_config

pytestmark = pytest.mark.integration

# db/init/002_admins.sql as it was before Alembic, which CloudApps databases were set up with.
LEGACY_ADMINS_SQL = """
CREATE TABLE admins (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    email text NOT NULL,
    auth_provider text,
    auth_subject text,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT admins_identity_complete CHECK ((auth_provider IS NULL) = (auth_subject IS NULL)),
    CONSTRAINT admins_identity_unique UNIQUE (auth_provider, auth_subject)
);
CREATE UNIQUE INDEX admins_email_unique ON admins (lower(email));
"""


def test_models_match_migrations(database_url: str) -> None:
    """Fails when a model changed without a migration: run `migrate revision --autogenerate`."""
    command.check(alembic_config(database_url))


def test_downgrade_and_upgrade_again(database_url: str) -> None:
    config = alembic_config(database_url)
    engine = create_engine(sqlalchemy_url(database_url))
    try:
        command.downgrade(config, "base")
        assert not inspect(engine).has_table("admins")
        command.upgrade(config, "head")
        assert inspect(engine).has_table("admins")
    finally:
        engine.dispose()


def test_adopts_database_created_by_old_init_sql(database_url: str) -> None:
    config = alembic_config(database_url)
    engine = create_engine(sqlalchemy_url(database_url))
    try:
        command.downgrade(config, "base")
        with engine.begin() as conn:
            conn.execute(text(LEGACY_ADMINS_SQL))
            conn.execute(text("INSERT INTO admins (email) VALUES ('kept@example.org')"))
        command.upgrade(config, "head")
        command.check(config)
        with engine.connect() as conn:
            assert conn.execute(text("SELECT email FROM admins")).scalars().all() == [
                "kept@example.org"
            ]
            conn.execute(text("DELETE FROM admins"))
            conn.commit()
    finally:
        engine.dispose()


def test_concurrent_upgrades_take_turns(database_url: str) -> None:
    """Each API pod runs `upgrade head` on startup; the advisory lock makes them take turns.

    Separate processes, like separate pods: Alembic's context is process-global.
    """
    config = alembic_config(database_url)
    command.downgrade(config, "base")
    cmd = [sys.executable, "-m", "swayambhu_api.migrate", "upgrade", "head"]
    env = {**os.environ, "DATABASE_URL": database_url}
    # Fixed argv, no shell.
    procs = [
        subprocess.Popen(cmd, env=env, stderr=subprocess.PIPE, text=True)  # noqa: S603
        for _ in range(3)
    ]
    for proc in procs:
        _, stderr = proc.communicate(timeout=60)
        assert proc.returncode == 0, stderr
    command.check(config)
