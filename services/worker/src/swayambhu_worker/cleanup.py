"""Deletes resumable uploads that were abandoned part-way (see the API's `uploads` module).

A finished upload is moved out of the uploads directory at once, so anything still there is
unfinished. Each chunk touches the upload's files, so a file untouched for the retention
period belongs to an upload nobody is resuming.
"""

import logging
import time
from datetime import timedelta
from pathlib import Path

log = logging.getLogger("swayambhu_worker")


def remove_abandoned_uploads(directory: Path, older_than: timedelta) -> int:
    """Delete files under `directory` not modified for `older_than`. Returns how many."""
    cutoff = time.time() - older_than.total_seconds()
    removed = 0
    for path in directory.rglob("*"):
        try:
            if path.is_file() and path.stat().st_mtime < cutoff:
                path.unlink()
                removed += 1
        except FileNotFoundError:
            continue  # resumed and finished, or removed by another worker, meanwhile
    if removed:
        log.info("removed %s files of abandoned uploads", removed)
    return removed
