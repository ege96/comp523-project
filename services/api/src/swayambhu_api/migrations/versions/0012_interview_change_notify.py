"""Tell listeners when an interview or one of its jobs changes, for live admin pages.

Triggers on `interviews` and `jobs` call `pg_notify('interview_changes', <interview id>)`.
Postgres delivers a notification only when the writing transaction commits, and folds
identical ones from the same transaction into one, so a step that touches several rows still
sends a single message. The payload is only the id (well under the 8000-byte limit); readers
fetch the current state through the normal, access-checked routes.

Job heartbeats don't notify: only a change an admin can see (state, attempts, error) does.
Triggers rather than calls in application code, so every writer (worker, API, CLIs, manual
SQL) is covered.

Revision ID: 0012
Revises: 0011
Create Date: 2026-11-22
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0012"
down_revision: str | None = "0011"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# Keep in sync with swayambhu_api.live.CHANNEL.
CHANNEL = "interview_changes"


def upgrade() -> None:
    op.execute(f"""
        CREATE FUNCTION notify_interview_change() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
            IF TG_TABLE_NAME = 'interviews' THEN
                PERFORM pg_notify('{CHANNEL}', COALESCE(NEW.id, OLD.id)::text);
            ELSE
                PERFORM pg_notify('{CHANNEL}', COALESCE(NEW.interview_id, OLD.interview_id)::text);
            END IF;
            RETURN NULL;
        END
        $$
    """)
    op.execute("""
        CREATE TRIGGER interviews_notify_change
        AFTER INSERT OR UPDATE OR DELETE ON interviews
        FOR EACH ROW EXECUTE FUNCTION notify_interview_change()
    """)
    op.execute("""
        CREATE TRIGGER jobs_notify_insert_delete
        AFTER INSERT OR DELETE ON jobs
        FOR EACH ROW EXECUTE FUNCTION notify_interview_change()
    """)
    op.execute("""
        CREATE TRIGGER jobs_notify_update
        AFTER UPDATE ON jobs
        FOR EACH ROW
        WHEN ((OLD.state, OLD.attempts, OLD.last_error)
              IS DISTINCT FROM (NEW.state, NEW.attempts, NEW.last_error))
        EXECUTE FUNCTION notify_interview_change()
    """)


def downgrade() -> None:
    op.execute("DROP TRIGGER jobs_notify_update ON jobs")
    op.execute("DROP TRIGGER jobs_notify_insert_delete ON jobs")
    op.execute("DROP TRIGGER interviews_notify_change ON interviews")
    op.execute("DROP FUNCTION notify_interview_change()")
