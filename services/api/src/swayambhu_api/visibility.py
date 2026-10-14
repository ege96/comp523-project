"""Who can see which interviews: the one place that decides (Proposal P-017).

Visibility is Public or Private and is enforced here, on the server. Admins see everything
(D-005); anonymous visitors see Public interviews whatever their status (D-008). Every query
that returns interviews, segments, search hits or media joins `interviews` and filters with
`visible_to`, so no route writes its own visibility check.
"""

from sqlalchemy import ColumnElement, true
from swayambhu_core.models import InterviewRow

from swayambhu_api.admins import Admin


def visible_to(viewer: Admin | None) -> ColumnElement[bool]:
    """A WHERE clause on `interviews` for what `viewer` (None = anonymous) may see."""
    if viewer is not None:
        return true()
    return InterviewRow.visibility == "public"
