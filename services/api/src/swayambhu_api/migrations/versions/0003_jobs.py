"""Worker job queue (Proposal for Q-18): one `jobs` table, claimed with SKIP LOCKED.

A new table only, so the previous release keeps working while this runs.

Revision ID: 0003
Revises: 0002
Create Date: 2026-10-14
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0003"
down_revision: str | None = "0002"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "jobs",
        sa.Column("id", sa.BigInteger(), sa.Identity(always=True), nullable=False),
        sa.Column("kind", sa.Text(), nullable=False),
        sa.Column("interview_id", sa.UUID(), nullable=False),
        sa.Column("state", sa.Text(), server_default="queued", nullable=False),
        sa.Column("attempts", sa.Integer(), server_default="0", nullable=False),
        sa.Column("max_attempts", sa.Integer(), server_default="3", nullable=False),
        sa.Column(
            "run_after", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False
        ),
        sa.Column("heartbeat_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_error", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint(
            "kind IN ('transcribe', 'translate', 'index')", name=op.f("jobs_kind_valid")
        ),
        sa.CheckConstraint(
            "state IN ('queued', 'running', 'done', 'failed')", name=op.f("jobs_state_valid")
        ),
        sa.CheckConstraint("attempts >= 0 AND max_attempts >= 1", name=op.f("jobs_attempts_valid")),
        sa.ForeignKeyConstraint(
            ["interview_id"],
            ["interviews.id"],
            name=op.f("jobs_interview_id_fkey"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("jobs_pkey")),
    )
    op.create_index("jobs_interview_id_idx", "jobs", ["interview_id"], unique=False)
    op.create_index(
        "jobs_one_active_idx",
        "jobs",
        ["interview_id", "kind"],
        unique=True,
        postgresql_where=sa.text("state IN ('queued', 'running')"),
    )
    op.create_index(
        "jobs_queued_idx",
        "jobs",
        ["run_after"],
        unique=False,
        postgresql_where=sa.text("state = 'queued'"),
    )


def downgrade() -> None:
    op.drop_index(
        "jobs_queued_idx", table_name="jobs", postgresql_where=sa.text("state = 'queued'")
    )
    op.drop_index(
        "jobs_one_active_idx",
        table_name="jobs",
        postgresql_where=sa.text("state IN ('queued', 'running')"),
    )
    op.drop_index("jobs_interview_id_idx", table_name="jobs")
    op.drop_table("jobs")
