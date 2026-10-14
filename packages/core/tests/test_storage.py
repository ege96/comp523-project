from pathlib import Path

import pytest

from swayambhu_core.db import sqlalchemy_url
from swayambhu_core.storage import LocalMediaStore, file_sha256


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


def test_file_sha256(tmp_path: Path) -> None:
    path = tmp_path / "f"
    path.write_bytes(b"abc")
    assert file_sha256(path) == "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"


def test_writer_stores_only_a_completed_write(tmp_path: Path) -> None:
    store = LocalMediaStore(tmp_path)
    with store.writer("a/upload.wav") as f:
        f.write(b"part one, ")
        f.write(b"part two")
    with store.local_copy("a/upload.wav") as copy:
        assert copy.read_bytes() == b"part one, part two"

    with pytest.raises(ConnectionError), store.writer("a/broken.wav") as f:
        f.write(b"half")
        raise ConnectionError
    assert sorted(p.name for p in (tmp_path / "a").iterdir()) == ["upload.wav"]
