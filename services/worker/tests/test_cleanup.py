import os
import time
from datetime import timedelta
from pathlib import Path

from swayambhu_worker.__main__ import with_upload_cleanup
from swayambhu_worker.cleanup import remove_abandoned_uploads
from swayambhu_worker.config import WorkerSettings


def test_only_untouched_uploads_are_removed_and_at_most_hourly(tmp_path: Path) -> None:
    uploads = tmp_path / "uploads"
    (uploads / ".locks").mkdir(parents=True)
    old = [uploads / "a", uploads / "a.info", uploads / ".locks" / "a.lock"]
    fresh = uploads / "b"
    for path in [*old, fresh]:
        path.write_bytes(b"x")
    four_days_ago = time.time() - 4 * 86400
    for path in old:
        os.utime(path, (four_days_ago, four_days_ago))

    calls: list[None] = []
    handle = with_upload_cleanup(
        WorkerSettings(media_root=tmp_path, upload_retention_days=3),
        lambda: bool(calls.append(None)),
    )
    assert handle() is False
    assert [p.name for p in uploads.rglob("*") if p.is_file()] == ["b"]

    fresh.touch()
    os.utime(fresh, (four_days_ago, four_days_ago))
    handle()  # within the hour: no second sweep
    assert fresh.exists() and len(calls) == 2
    assert remove_abandoned_uploads(tmp_path / "missing", timedelta(days=3)) == 0
