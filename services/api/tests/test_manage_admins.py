import io

from swayambhu_api.manage_admins import run
from tests.fakes import FakeAdminStore


def call(store: FakeAdminStore, *argv: str) -> tuple[int, str]:
    out = io.StringIO()
    return run(argv, store, out), out.getvalue()


def test_add_list_remove() -> None:
    store = FakeAdminStore()
    assert call(store, "add", " lead@example.org ")[0] == 0
    assert call(store, "list") == (0, "lead@example.org\n")
    assert call(store, "remove", "lead@example.org")[0] == 0
    assert call(store, "list") == (0, "")


def test_add_twice_is_reported() -> None:
    store = FakeAdminStore()
    call(store, "add", "lead@example.org")
    code, out = call(store, "add", "LEAD@example.org")
    assert code == 1
    assert "already an admin" in out


def test_add_rejects_non_email() -> None:
    code, _ = call(FakeAdminStore(), "add", "lead")
    assert code == 2


def test_remove_unknown() -> None:
    assert call(FakeAdminStore(), "remove", "nobody@example.org")[0] == 1
