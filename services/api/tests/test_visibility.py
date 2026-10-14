from sqlalchemy import select
from sqlalchemy.dialects import postgresql

from swayambhu_api.admins import Admin
from swayambhu_api.models import InterviewRow
from swayambhu_api.visibility import visible_to


def where_sql(viewer: Admin | None) -> str:
    stmt = select(InterviewRow.id).where(visible_to(viewer))
    compiled = stmt.compile(dialect=postgresql.dialect(), compile_kwargs={"literal_binds": True})
    return str(compiled).split("WHERE", 1)[1].strip()


def test_anonymous_is_limited_to_public() -> None:
    assert where_sql(None) == "interviews.visibility = 'public'"


def test_admin_is_not_limited() -> None:
    assert where_sql(Admin(id=1, email="a@example.org")) == "true"
