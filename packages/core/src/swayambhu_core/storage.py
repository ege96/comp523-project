"""Media storage behind an interface (D-007). The provider is still undecided (Q-01).

Keys are opaque, `/`-separated paths such as `interviews/<id>/original.mp3`. Only this
module turns a key into a location, so swapping the local disk for object storage means
adding an implementation here and changing config.
"""

import shutil
from collections.abc import Iterator
from contextlib import AbstractContextManager, contextmanager
from pathlib import Path
from typing import Protocol


class MediaStore(Protocol):
    def put(self, key: str, source: Path) -> None:
        """Store a copy of `source` under `key`, replacing anything already there."""
        ...

    def local_copy(self, key: str) -> AbstractContextManager[Path]:
        """A local file with the object's contents, valid inside the `with` block."""
        ...

    def delete(self, key: str) -> None: ...


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

    def put(self, key: str, source: Path) -> None:
        target = self._path(key)
        target.parent.mkdir(parents=True, exist_ok=True)
        partial = target.with_name(target.name + ".partial")
        shutil.copyfile(source, partial)
        partial.replace(target)  # atomic, so readers never see half a file

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
