"""Track which original text each line's English was made from, and allow `retranslate` jobs.

`english_source_hash` is for the machine English, `english_edit_source_hash` for an admin's
English edit. Both start NULL, which means "made from the machine original";
that holds for every line translated before this column existed. Only adds a nullable column
and widens a CHECK, so the previous release keeps working while this runs.

Revision ID: 0006
Revises: 0005
Create Date: 2026-10-25
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0006"
down_revision: str | None = "0005"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("segments", sa.Column("english_source_hash", sa.Text(), nullable=True))
    op.add_column("segments", sa.Column("english_edit_source_hash", sa.Text(), nullable=True))
    op.drop_constraint(op.f("jobs_kind_valid"), "jobs", type_="check")
    op.create_check_constraint(
        op.f("jobs_kind_valid"),
        "jobs",
        "kind IN ('transcribe', 'translate', 'index', 'playback', 'retranslate')",
    )


def downgrade() -> None:
    op.execute("DELETE FROM jobs WHERE kind = 'retranslate'")
    op.drop_constraint(op.f("jobs_kind_valid"), "jobs", type_="check")
    op.create_check_constraint(
        op.f("jobs_kind_valid"), "jobs", "kind IN ('transcribe', 'translate', 'index', 'playback')"
    )
    op.drop_column("segments", "english_edit_source_hash")
    op.drop_column("segments", "english_source_hash")
