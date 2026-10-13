from urllib.parse import quote

import pytest

from swayambhu_api.config import Settings
from swayambhu_api.db import check_database, sqlalchemy_url
from swayambhu_api.migrate import MIGRATIONS_DIR, alembic_config, main


@pytest.mark.parametrize(
    ("given", "driver"),
    [
        ("postgresql://u@h:5432/d", "postgresql+psycopg"),
        ("postgres://u@h/d", "postgresql+psycopg"),
        ("postgresql+psycopg://u@h/d", "postgresql+psycopg"),
    ],
)
def test_libpq_urls_use_psycopg3(given: str, driver: str) -> None:
    assert sqlalchemy_url(given).drivername == driver


def test_password_survives_url_conversion() -> None:
    reserved = "".join(["@", ":", "%", "/"])
    url = sqlalchemy_url(f"postgresql://u:{quote(reserved, safe='')}@h/d")
    assert url.password == reserved


def test_unreachable_database_is_reported_not_raised() -> None:
    settings = Settings(database_url="postgresql://u@127.0.0.1:9/d", db_connect_timeout_seconds=1)
    status = check_database(settings)
    assert status.reachable is False
    assert status.pgvector_version is None


def test_alembic_config_points_at_packaged_migrations() -> None:
    config = alembic_config("postgresql://u@h/d")
    assert config.get_main_option("script_location") == str(MIGRATIONS_DIR)
    assert config.attributes["database_url"] == "postgresql://u@h/d"
    assert (MIGRATIONS_DIR / "env.py").is_file()


def test_migrate_cli_needs_a_command() -> None:
    with pytest.raises(SystemExit):
        main([])


def test_migrate_cli_runs_offline_upgrade(capsys: pytest.CaptureFixture[str]) -> None:
    # --sql renders the migration without a database: proves the CLI wiring and env.py.
    main(["upgrade", "head", "--sql"])
    assert "CREATE TABLE admins" in capsys.readouterr().out
