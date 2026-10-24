"""
Time helpers — single home for the project's timezone convention.

Convention: PostgreSQL Time/DateTime columns (schedules, reservations) and the
seed dataset store naive LOCAL wall-clock times (America/Lima by default),
while the API stamps incoming readings with naive UTC (datetime.utcnow).
Every schedule/reservation comparison and every time-derived model feature
must therefore shift UTC into local first — through THESE helpers, so the
rule lives in exactly one place. LOCAL_UTC_OFFSET_HOURS is a whole-hour,
env-configurable offset (Peru has no DST).
"""
from datetime import datetime, timedelta, timezone

from app.config import LOCAL_UTC_OFFSET_HOURS


def to_local(dt: datetime) -> datetime:
    """Naive-UTC (or tz-aware) datetime → naive LOCAL wall-clock datetime.

    Shifts the FULL datetime: the weekday can change too
    (Tue 20:00 Lima == Wed 01:00 UTC).
    """
    if dt.tzinfo:
        dt = dt.replace(tzinfo=None)
    return dt + timedelta(hours=LOCAL_UTC_OFFSET_HOURS)


def local_now() -> datetime:
    """Current naive LOCAL wall-clock time."""
    return to_local(datetime.now(timezone.utc))


def ensure_local(dt: datetime) -> datetime:
    """Incoming API datetime → naive LOCAL wall-clock datetime.

    Naive input is trusted as already-local wall-clock and returned as-is.
    tz-aware input (e.g. an ISO string ending in 'Z' or '+00:00') is first
    normalized to UTC and then shifted into local — a bare
    .replace(tzinfo=None) would mislabel the UTC wall-clock as local and
    store reservations |offset| hours in the future.
    """
    if dt.tzinfo is None:
        return dt
    return to_local(dt.astimezone(timezone.utc))
