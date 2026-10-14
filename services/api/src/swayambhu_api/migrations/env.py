"""Alembic environment. Run it through `python -m swayambhu_api.migrate`."""

from alembic import context
from sqlalchemy import create_engine, pool, text
from swayambhu_core.models import Base

from swayambhu_api.db import sqlalchemy_url

# Any fixed number works; it only has to match between API pods. Each pod runs
# `upgrade head` on startup, so two pods starting together queue on this lock instead of
# both applying the same migration. The second one then finds the database at head.
MIGRATION_LOCK_KEY = 523_000_001

config = context.config
url = sqlalchemy_url(config.attributes["database_url"])

if context.is_offline_mode():
    context.configure(url=url, target_metadata=Base.metadata, literal_binds=True)
    with context.begin_transaction():
        context.run_migrations()
else:
    engine = create_engine(url, poolclass=pool.NullPool)
    with engine.connect() as connection:
        context.configure(connection=connection, target_metadata=Base.metadata)
        with context.begin_transaction():
            # Held until this transaction ends, so it is released even if a migration fails.
            connection.execute(
                text("SELECT pg_advisory_xact_lock(:key)"), {"key": MIGRATION_LOCK_KEY}
            )
            context.run_migrations()
