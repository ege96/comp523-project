"""Original-text keyword search folds Devanagari digits, zero-width joiners and Unicode forms.

So `२०७२` finds `2072`, and a word typed with a zero-width (non-)joiner finds the same word
without one. Postgres 16 can't change a generated column's expression, so the column and its
index are rebuilt; every segment is re-read once.

Revision ID: 0008
Revises: 0007
Create Date: 2026-11-05
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import TSVECTOR

revision: str = "0008"
down_revision: str | None = "0007"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

ORIGINAL = "COALESCE(original_edited, original_machine)"
# A copy of swayambhu_core.models.FOLD_SQL as of this revision.
FOLDED = (
    f"translate(normalize({ORIGINAL}, NFC), "
    r"U&'\0966\0967\0968\0969\096A\096B\096C\096D\096E\096F\200C\200D', "
    "'0123456789')"
)


def _rebuild(text_sql: str) -> None:
    op.drop_index("segments_original_tsv_idx", table_name="segments", postgresql_using="gin")
    op.drop_column("segments", "original_tsv")
    op.add_column(
        "segments",
        sa.Column(
            "original_tsv",
            TSVECTOR(),
            sa.Computed(f"to_tsvector('simple'::regconfig, {text_sql})", persisted=True),
            nullable=False,
        ),
    )
    op.create_index(
        "segments_original_tsv_idx", "segments", ["original_tsv"], postgresql_using="gin"
    )


def upgrade() -> None:
    _rebuild(FOLDED)


def downgrade() -> None:
    _rebuild(ORIGINAL)
