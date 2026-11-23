"""Find, and optionally delete, stored interview folders that no interview owns any more.

Deleting an interview removes its folder right after the database commit, so leftovers are
rare: a delete whose file removal failed, or a database restored or reset without the media
volume. Run it where the worker runs, with the same settings:

    python -m swayambhu_worker.sweep_media            # list leftovers, change nothing
    python -m swayambhu_worker.sweep_media --delete   # delete them; there is no undo

Only folders untouched for `--min-age-hours` (default 24) count, so an upload being finished
right now (its file is stored a moment before its interview is committed) is never touched.
Folders whose name isn't an interview id are listed but never deleted.
"""

import argparse
import time
import uuid
from collections.abc import Iterable
from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.orm import Session
from swayambhu_core.models import InterviewRow
from swayambhu_core.recordings import INTERVIEWS_PREFIX, interview_prefix
from swayambhu_core.storage import LocalMediaStore, StoredFolder

from swayambhu_worker.config import WorkerSettings
from swayambhu_worker.db import session_factory


@dataclass(frozen=True)
class Leftover:
    folder: StoredFolder
    interview_id: uuid.UUID | None  # None: the name isn't an interview id, so it's kept


def find_leftovers(
    session: Session, folders: Iterable[StoredFolder], *, older_than: float
) -> list[Leftover]:
    """Folders changed before `older_than` (a Unix time) that no interview row owns."""
    old = [f for f in folders if f.changed < older_than]
    ids: dict[str, uuid.UUID | None] = {}
    for folder in old:
        try:
            ids[folder.name] = uuid.UUID(folder.name)
        except ValueError:
            ids[folder.name] = None
    candidates = [i for i in ids.values() if i is not None]
    owned = (
        set(session.scalars(select(InterviewRow.id).where(InterviewRow.id.in_(candidates))))
        if candidates
        else set()
    )
    return sorted(
        (Leftover(f, ids[f.name]) for f in old if ids[f.name] not in owned),
        key=lambda leftover: leftover.folder.name,
    )


def _size(n: int) -> str:
    if n < 1024:
        return f"{n} B"
    value = float(n)
    for unit in ("KiB", "MiB", "GiB"):
        value /= 1024
        if value < 1024 or unit == "GiB":
            break
    return f"{value:.1f} {unit}"


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--delete", action="store_true", help="delete them (default: list)")
    parser.add_argument(
        "--min-age-hours", type=float, default=24.0, help="skip folders changed more recently"
    )
    args = parser.parse_args(argv)

    settings = WorkerSettings()
    store = LocalMediaStore(settings.media_root)
    with session_factory(settings)() as session:
        leftovers = find_leftovers(
            session,
            store.folders(INTERVIEWS_PREFIX),
            older_than=time.time() - args.min_age_hours * 3600,
        )
    freed = 0
    for leftover in leftovers:
        folder = leftover.folder
        changed = time.strftime("%Y-%m-%d", time.gmtime(folder.changed))
        if leftover.interview_id is None:
            print(f"kept     {folder.name}  {_size(folder.size_bytes)}  (not an interview id)")
            continue
        if args.delete:
            store.delete_prefix(interview_prefix(leftover.interview_id))
            freed += folder.size_bytes
        verb = "deleted" if args.delete else "leftover"
        print(f"{verb:8} {folder.name}  {_size(folder.size_bytes)}  last changed {changed}")
    removable = [x for x in leftovers if x.interview_id is not None]
    total = sum(x.folder.size_bytes for x in removable)
    if args.delete:
        print(f"Deleted {len(removable)} folder(s), {_size(freed)}")
    else:
        print(f"{len(removable)} leftover folder(s), {_size(total)}. Run with --delete to remove.")


if __name__ == "__main__":
    main()
