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


def test_put_can_move_instead_of_copying(tmp_path: Path) -> None:
    store = LocalMediaStore(tmp_path / "media")
    upload = tmp_path / "upload"
    upload.write_bytes(b"audio")
    store.put("a/original.wav", upload, move=True)
    assert not upload.exists()
    with store.local_copy("a/original.wav") as stored:
        assert stored.read_bytes() == b"audio"


def test_put_keeping_source_leaves_the_source_for_the_caller_to_delete(tmp_path: Path) -> None:
    upload = tmp_path / "uploads" / "abc"
    upload.parent.mkdir()
    upload.write_bytes(b"audio")
    store = LocalMediaStore(tmp_path / "media")
    store.put_keeping_source("a/original.wav", upload)
    store.put_keeping_source("a/original.wav", upload)  # a retry replaces it
    assert upload.read_bytes() == b"audio"
    with store.local_copy("a/original.wav") as path:
        assert path.read_bytes() == b"audio"
    assert [p.name for p in path.parent.iterdir()] == ["original.wav"]  # no partials left
