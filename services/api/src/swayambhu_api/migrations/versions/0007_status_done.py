"""Statuses become processing / done / failed: there's no manual review step any more.

Needs review and Reviewed both become Done. Visitors see every finished transcript labelled
as machine-generated, with corrected lines marked (amends D-008, Eric 2026-11-05).

Revision ID: 0007
Revises: 0006
Create Date: 2026-11-05
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0007"
down_revision: str | None = "0006"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.drop_constraint(op.f("interviews_status_valid"), "interviews", type_="check")
    op.execute("UPDATE interviews SET status = 'done' WHERE status IN ('needs_review', 'reviewed')")
    op.create_check_constraint(
        op.f("interviews_status_valid"), "interviews", "status IN ('processing', 'done', 'failed')"
    )


def downgrade() -> None:
    op.drop_constraint(op.f("interviews_status_valid"), "interviews", type_="check")
    op.execute("UPDATE interviews SET status = 'needs_review' WHERE status = 'done'")
    op.create_check_constraint(
        op.f("interviews_status_valid"),
        "interviews",
        "status IN ('processing', 'needs_review', 'reviewed', 'failed')",
    )
