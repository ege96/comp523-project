from datetime import date

import pytest

from swayambhu_api.recording_dates import recorded_date


def test_partial_dates_start_their_period() -> None:
    assert recorded_date("2019") == (date(2019, 1, 1), "year")
    assert recorded_date("2019-05") == (date(2019, 5, 1), "month")
    assert recorded_date("2019-05-17") == (date(2019, 5, 17), "day")


@pytest.mark.parametrize("value", ["0000", "0000-01-01", "2024-02-30", "2019-13"])
def test_dates_that_dont_exist_are_refused(value: str) -> None:
    with pytest.raises(ValueError, match="not a real date"):
        recorded_date(value)
