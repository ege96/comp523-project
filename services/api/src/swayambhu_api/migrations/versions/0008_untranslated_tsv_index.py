"""Index the English keyword match on lines that have no English text.

Keyword search also matches English words against the original text of lines without an
English translation (English speech, or a failed translation). That condition had no index,
so every search scanned every line: the performance benchmark measured 380 ms of keyword SQL
at 300 hours of audio, 10x today's expected archive.

Revision ID: 0008
Revises: 0007
Create Date: 2026-11-06
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0008"
down_revision: str | None = "0007"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        "CREATE INDEX segments_untranslated_tsv_idx ON segments "
        "USING gin (to_tsvector('english'::regconfig, original_text)) "
        "WHERE english_text IS NULL"
    )


def downgrade() -> None:
    op.drop_index("segments_untranslated_tsv_idx", table_name="segments")
