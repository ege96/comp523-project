"""Let a job wait behind a running job of the same step, instead of being dropped.

Before, an interview could have one queued-or-running job per step, so a step queued while
the same step was running (an admin editing a transcript while it's being indexed) was
silently skipped. Now one may wait while one runs; the worker won't start it until the
running one ends.

Revision ID: 0005
Revises: 0004
Create Date: 2026-10-22
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0005"
down_revision: str | None = "0004"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_index(
        "jobs_one_queued_idx",
        "jobs",
        ["interview_id", "kind"],
        unique=True,
        postgresql_where=sa.text("state = 'queued'"),
    )
    op.drop_index(
        "jobs_one_active_idx",
        table_name="jobs",
        postgresql_where=sa.text("state IN ('queued', 'running')"),
    )


def downgrade() -> None:
    # The old index allows only one of the two: drop the waiting copy.
    op.execute(
        """
        DELETE FROM jobs AS queued USING jobs AS running
        WHERE queued.state = 'queued' AND running.state = 'running'
          AND queued.interview_id = running.interview_id AND queued.kind = running.kind
        """
    )
    op.create_index(
        "jobs_one_active_idx",
        "jobs",
        ["interview_id", "kind"],
        unique=True,
        postgresql_where=sa.text("state IN ('queued', 'running')"),
    )
    op.drop_index(
        "jobs_one_queued_idx", table_name="jobs", postgresql_where=sa.text("state = 'queued'")
    )
