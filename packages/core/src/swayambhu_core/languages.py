"""Which languages an interview is filed under, for the language filter.

An interview is listed under its confirmed language (what an admin chose on upload or later)
and under every language heard in its lines, so a mixed recording matches each of them. The
detected main language (`interviews.language_detected`) comes from those lines, so it needs
no separate entry.
"""

import uuid

from sqlalchemy import delete, insert, select
from sqlalchemy.orm import Session

from swayambhu_core.models import InterviewLanguageRow, InterviewRow, SegmentRow


def sync_interview_languages(session: Session, interview_id: uuid.UUID) -> None:
    """Rewrite an interview's `interview_languages` rows from what is stored now.

    Flushes the session first, then locks the interview row, so the confirmed language read
    here is the one being committed, also when an admin changed it while a worker step ran.
    Doesn't commit.
    """
    session.flush()
    confirmed = session.scalar(
        select(InterviewRow.language_confirmed)
        .where(InterviewRow.id == interview_id)
        .with_for_update(key_share=True)
    )
    session.execute(
        delete(InterviewLanguageRow).where(InterviewLanguageRow.interview_id == interview_id)
    )
    codes: set[str] = {
        code
        for code in session.scalars(
            select(SegmentRow.language)
            .where(SegmentRow.interview_id == interview_id, SegmentRow.language.is_not(None))
            .distinct()
        )
        if code
    }
    if confirmed:
        codes.add(confirmed)
    if codes:
        session.execute(
            insert(InterviewLanguageRow).values(
                [{"interview_id": interview_id, "language_code": c} for c in sorted(codes)]
            )
        )
