"""Finding and deleting stored interview folders that no interview owns."""

import os
import time
import uuid
from pathlib import Path

import pytest
from swayambhu_core.models import InterviewRow
from swayambhu_core.storage import LocalMediaStore

from swayambhu_worker import sweep_media
from swayambhu_worker.runner import SessionFactory

pytestmark = pytest.mark.integration

DAY = 86400


def _folder(root: Path, name: str, *, age_days: float) -> None:
    folder = root / "interviews" / name
    folder.mkdir(parents=True)
    (folder / "original.wav").write_bytes(b"x" * 2048)
    when = time.time() - age_days * DAY
    os.utime(folder / "original.wav", (when, when))
    os.utime(folder, (when, when))


def test_only_old_folders_without_an_interview_are_leftovers(
    new_session: SessionFactory, tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:  # fmt: skip
    root = tmp_path / "media"
    with new_session() as session:
        owned = InterviewRow(title="Kept")
        session.add(owned)
        session.commit()
        owned_id = owned.id
    orphan, fresh = uuid.uuid4(), uuid.uuid4()
    _folder(root, str(owned_id), age_days=5)
    _folder(root, str(orphan), age_days=5)
    _folder(root, str(fresh), age_days=0)  # maybe an upload being finished right now
    _folder(root, "notes", age_days=5)
    monkeypatch.setenv("MEDIA_ROOT", str(root))  # DATABASE_URL is already the test database

    sweep_media.main([])  # a dry run changes nothing
    out = capsys.readouterr().out
    assert f"leftover {orphan}  2.0 KiB" in out
    assert "kept     notes" in out
    assert str(owned_id) not in out and str(fresh) not in out
    assert "1 leftover folder(s), 2.0 KiB" in out
    assert (root / "interviews" / str(orphan)).is_dir()

    sweep_media.main(["--delete"])
    names = sorted(f.name for f in LocalMediaStore(root).folders("interviews"))
    assert names == sorted([str(owned_id), str(fresh), "notes"])
    assert "Deleted 1 folder(s), 2.0 KiB" in capsys.readouterr().out
