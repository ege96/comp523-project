"""Allow `retranscribe` jobs: transcribe again even though admins have corrected lines.

An admin queues one only after confirming that the corrections will be replaced (P-013).
Only widens a CHECK, so the previous release keeps working while this runs.

Revision ID: 0008
Revises: 0007
Create Date: 2026-11-05
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0008"
down_revision: str | None = "0007"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

KINDS = ("transcribe", "translate", "index", "playback", "retranslate")


def _kinds(kinds: tuple[str, ...]) -> str:
    return f"kind IN ({', '.join(repr(k) for k in kinds)})"


def upgrade() -> None:
    op.drop_constraint(op.f("jobs_kind_valid"), "jobs", type_="check")
    op.create_check_constraint(op.f("jobs_kind_valid"), "jobs", _kinds((*KINDS, "retranscribe")))


def downgrade() -> None:
    op.execute("DELETE FROM jobs WHERE kind = 'retranscribe'")
    op.drop_constraint(op.f("jobs_kind_valid"), "jobs", type_="check")
    op.create_check_constraint(op.f("jobs_kind_valid"), "jobs", _kinds(KINDS))
