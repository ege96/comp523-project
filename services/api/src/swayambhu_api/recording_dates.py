"""Recording dates known to a year, a month or a day, as uploads and admin edits send them."""

from datetime import date
from typing import Literal

Precision = Literal["year", "month", "day"]

# YYYY, YYYY-MM or YYYY-MM-DD, as much of the date as is known.
DATE_PATTERN = r"^\d{4}(-\d{2}(-\d{2})?)?$"


def recorded_date(value: str) -> tuple[date, Precision]:
    """'2019' -> (2019-01-01, 'year'): the first day of the period, and how much is real.

    Raises ValueError for a date that doesn't exist, such as 2024-02-30 or year 0000."""
    parts = [int(p) for p in value.split("-")]
    precision: Precision = ("year", "month", "day")[len(parts) - 1]
    try:
        return date(*parts, *[1] * (3 - len(parts))), precision
    except ValueError:
        raise ValueError(f"{value} is not a real date") from None
