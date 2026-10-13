import pytest

from swayambhu_api.config import Settings
from swayambhu_api.db import check_database


@pytest.mark.integration
def test_real_database_has_pgvector() -> None:
    status = check_database(Settings())
    assert status.reachable
    assert status.pgvector_version is not None
