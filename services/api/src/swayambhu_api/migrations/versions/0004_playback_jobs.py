"""Allow `playback` jobs: the worker makes a browser-playable copy of each recording.

Only widens a CHECK constraint, so the previous release keeps working while this runs.

Revision ID: 0004
Revises: 0003
Create Date: 2026-10-14
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0004"
down_revision: str | None = "0003"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.drop_constraint(op.f("jobs_kind_valid"), "jobs", type_="check")
    op.create_check_constraint(
        op.f("jobs_kind_valid"), "jobs", "kind IN ('transcribe', 'translate', 'index', 'playback')"
    )


def downgrade() -> None:
    op.execute("DELETE FROM jobs WHERE kind = 'playback'")
    op.drop_constraint(op.f("jobs_kind_valid"), "jobs", type_="check")
    op.create_check_constraint(
        op.f("jobs_kind_valid"), "jobs", "kind IN ('transcribe', 'translate', 'index')"
    )
