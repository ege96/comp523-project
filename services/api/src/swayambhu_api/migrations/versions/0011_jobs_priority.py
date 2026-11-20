"""Job priority, so admins' work and started interviews run before new recordings.

See `swayambhu_core.jobs.Priority`.

Adds a column with a default, so the previous release keeps working while this runs.

Revision ID: 0011
Revises: 0008
Create Date: 2026-11-20
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0011"
down_revision: str | None = "0008"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "jobs", sa.Column("priority", sa.SmallInteger(), server_default="1", nullable=False)
    )


def downgrade() -> None:
    op.drop_column("jobs", "priority")
