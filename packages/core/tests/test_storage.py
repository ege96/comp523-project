from pathlib import Path

import pytest

from swayambhu_core.db import sqlalchemy_url
from swayambhu_core.storage import LocalMediaStore


def test_put_then_read_back_then_delete(tmp_path: Path) -> None:
    store = LocalMediaStore(tmp_path / "media")
    source = tmp_path / "talk.mp3"
    source.write_bytes(b"audio")

    store.put("interviews/abc/original.mp3", source)
    with store.local_copy("interviews/abc/original.mp3") as copy:
        assert copy.read_bytes() == b"audio"
    assert not list((tmp_path / "media").rglob("*.partial"))

    store.delete("interviews/abc/original.mp3")
    store.delete("interviews/abc/original.mp3")  # already gone is fine
    with pytest.raises(FileNotFoundError), store.local_copy("interviews/abc/original.mp3"):
        pass


@pytest.mark.parametrize("key", ["", "/etc/passwd", "../outside", "a/../../b", "a//b", "./a"])
def test_keys_cannot_escape_the_media_directory(tmp_path: Path, key: str) -> None:
    with pytest.raises(ValueError, match="Invalid storage key"):
        LocalMediaStore(tmp_path).delete(key)


def test_database_url_uses_psycopg_3() -> None:
    url = sqlalchemy_url("postgresql://u@db:5432/archive")
    assert (url.drivername, url.host, url.database) == ("postgresql+psycopg", "db", "archive")
