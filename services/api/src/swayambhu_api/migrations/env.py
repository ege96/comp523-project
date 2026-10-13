"""Alembic environment. Run it through `python -m swayambhu_api.migrate`."""

from alembic import context
from sqlalchemy import create_engine, pool

from swayambhu_api.db import sqlalchemy_url
from swayambhu_api.models import Base

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
            context.run_migrations()
