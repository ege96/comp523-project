"""Run Alembic database migrations against DATABASE_URL (Proposal P-011).

    python -m swayambhu_api.migrate upgrade head
    python -m swayambhu_api.migrate current
    python -m swayambhu_api.migrate revision --autogenerate -m "add interviews"
    python -m swayambhu_api.migrate check   # fails if the models need a migration

Any Alembic command works. There is no alembic.ini: the config is built here, so the same
command works from a checkout and inside the API image.
"""

import logging
from collections.abc import Sequence
from pathlib import Path

from alembic.config import CommandLine, Config

from swayambhu_api.config import get_settings

MIGRATIONS_DIR = Path(__file__).parent / "migrations"


def alembic_config(database_url: str | None = None) -> Config:
    config = Config()
    config.set_main_option("script_location", str(MIGRATIONS_DIR))
    # Passed as an attribute, not an ini option, so a `%` in a password needs no escaping.
    config.attributes["database_url"] = database_url or get_settings().database_url
    return config


def main(argv: Sequence[str] | None = None) -> None:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s %(message)s")
    cli = CommandLine(prog="python -m swayambhu_api.migrate")
    options = cli.parser.parse_args(argv)
    if not hasattr(options, "cmd"):
        cli.parser.error("too few arguments")
    cli.run_cmd(alembic_config(), options)


if __name__ == "__main__":  # pragma: no cover
    main()
