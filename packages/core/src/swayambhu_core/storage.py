"""Media storage interfaces and local filesystem implementation.

Keys are opaque, `/`-separated paths such as `interviews/<id>/original.mp3`. Only this
module turns a key into a location, so swapping the local disk for object storage means
adding an implementation here and changing config.
"""

import hashlib
import os
import shutil
import uuid
from collections.abc import Iterator
from contextlib import AbstractContextManager, contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol


class MediaStore(Protocol):
    def put(self, key: str, source: Path, *, move: bool = False) -> None:
        """Store `source` under `key`, replacing anything already there. With `move`, the
        source file is consumed, which avoids copying a multi-GB upload when possible."""
        ...

    def local_copy(self, key: str) -> AbstractContextManager[Path]:
        """A local file with the object's contents, valid inside the `with` block."""
        ...

    def delete(self, key: str) -> None: ...

    def delete_prefix(self, prefix: str) -> None:
        """Delete every object whose key starts with `prefix/`, such as all of one interview's
        files. Deleting what isn't there is not an error."""
        ...


class LocalMediaStore:
    """Files under one directory: a mounted volume in CloudApps, any folder in development.

    The API and worker must see the same directory, so with more than one pod it needs a
    shared (ReadWriteMany) volume.
    """

    def __init__(self, root: Path) -> None:
        self._root = root.resolve()

    def _path(self, key: str) -> Path:
        parts = key.split("/")
        if any(part in ("", ".", "..") for part in parts):
            raise ValueError(f"Invalid storage key: {key!r}")
        return self._root.joinpath(*parts)

    def put(self, key: str, source: Path, *, move: bool = False) -> None:
        target = self._path(key)
        target.parent.mkdir(parents=True, exist_ok=True)
        partial = target.with_name(target.name + ".partial")
        if move:
            shutil.move(source, partial)  # a rename when both are on the same volume
        else:
            shutil.copyfile(source, partial)
        partial.replace(target)  # atomic, so readers never see half a file

    def put_keeping_source(self, key: str, source: Path) -> None:
        """Store `source` under `key`, replacing anything already there, and leave `source`
        in place, so the caller can delete it once the new object is safely recorded.

        A hard link when both are on the same volume (no copy of a multi-GB file), otherwise
        a copy."""
        target = self._path(key)
        target.parent.mkdir(parents=True, exist_ok=True)
        # Unique per call, so two callers storing the same key don't collide.
        partial = target.with_name(f"{target.name}.{uuid.uuid4().hex}.partial")
        try:
            try:
                os.link(source, partial)
            except OSError:
                shutil.copyfile(source, partial)
            partial.replace(target)  # atomic, so readers never see half a file
        finally:
            partial.unlink(missing_ok=True)

    @contextmanager
    def local_copy(self, key: str) -> Iterator[Path]:
        """A local file with the object's contents, valid inside the `with` block.

        On local disk this is the stored file itself, so callers must not modify it.
        """
        path = self._path(key)
        if not path.is_file():
            raise FileNotFoundError(f"No stored media at {key!r}")
        yield path

    def delete(self, key: str) -> None:
        self._path(key).unlink(missing_ok=True)

    def delete_prefix(self, prefix: str) -> None:
        shutil.rmtree(self._path(prefix), ignore_errors=False, onexc=_ignore_missing)

    def folders(self, prefix: str) -> Iterator["StoredFolder"]:
        """The folders directly under `prefix` (one level of the key path), for sweeping
        leftovers. Local disk only."""
        parent = self._path(prefix)
        if not parent.is_dir():
            return
        for child in parent.iterdir():
            try:
                if not child.is_dir():
                    continue
                files = [f.stat() for f in child.rglob("*") if f.is_file()]
                changed = max([child.stat().st_mtime, *(f.st_mtime for f in files)])
            except FileNotFoundError:
                continue  # deleted meanwhile
            yield StoredFolder(child.name, changed, sum(f.st_size for f in files))


@dataclass(frozen=True)
class StoredFolder:
    name: str
    changed: float  # when anything in it last changed, as a Unix time
    size_bytes: int


def _ignore_missing(_function: object, _path: str, error: BaseException) -> None:
    """For `rmtree`: something already gone is fine, anything else is a real failure."""
    if not isinstance(error, FileNotFoundError):
        raise error


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()
