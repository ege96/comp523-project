"""Admins table (D-005), moved here from db/init/002_admins.sql.

Revision ID: 0001
Revises:
Create Date: 2026-10-13
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import context, op

revision: str = "0001"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # pgvector's types are used from 0002 on. db/init creates the extension for Docker and CI,
    # but a fresh CloudApps database has nothing to run it, so the migrations do it too.
    # Needs a role allowed to create extensions (the pgvector image's user is).
    op.execute("CREATE EXTENSION IF NOT EXISTS vector")
    # Databases set up before Alembic already have this table from db/init/002_admins.sql,
    # with the same columns and constraint names. Adopt it as-is instead of failing.
    if not context.is_offline_mode() and sa.inspect(op.get_bind()).has_table("admins"):
        return
    op.create_table(
        "admins",
        sa.Column("id", sa.BigInteger(), sa.Identity(always=True), nullable=False),
        sa.Column("email", sa.Text(), nullable=False),
        sa.Column("auth_provider", sa.Text(), nullable=True),
        sa.Column("auth_subject", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "(auth_provider IS NULL) = (auth_subject IS NULL)", name="identity_complete"
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("auth_provider", "auth_subject", name="admins_identity_unique"),
    )
    op.create_index("admins_email_unique", "admins", [sa.text("lower(email)")], unique=True)


def downgrade() -> None:
    op.drop_index("admins_email_unique", table_name="admins")
    op.drop_table("admins")
