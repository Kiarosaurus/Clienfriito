"""Unit tests for the deterministic Lima outdoor-temperature model."""
from datetime import datetime

from app.services.climate_service import (
    _DIURNAL_AMPLITUDE_C,
    _MONTHLY_MEAN_C,
    outdoor_temp,
)


def test_deterministic_same_timestamp_same_temp():
    ts = datetime(2026, 7, 2, 15, 30)
    assert outdoor_temp(ts) == outdoor_temp(ts)


def test_peak_hour_equals_monthly_mean_plus_amplitude():
    # At the diurnal peak (14:00) the cosine term is exactly +amplitude.
    ts = datetime(2026, 7, 1, 14, 0)
    assert outdoor_temp(ts) == round(_MONTHLY_MEAN_C[7] + _DIURNAL_AMPLITUDE_C, 2)


def test_trough_is_amplitude_below_mean():
    # 12 hours after the peak (02:00) the cosine term is exactly -amplitude.
    ts = datetime(2026, 7, 1, 2, 0)
    assert outdoor_temp(ts) == round(_MONTHLY_MEAN_C[7] - _DIURNAL_AMPLITUDE_C, 2)


def test_winter_colder_than_summer():
    # Lima: July (garúa winter) must be colder than February (summer) at the same hour.
    winter = outdoor_temp(datetime(2026, 7, 1, 12, 0))
    summer = outdoor_temp(datetime(2026, 2, 1, 12, 0))
    assert winter < summer


def test_minutes_vary_smoothly_not_in_hour_steps():
    # Fractional hour: 14:00 and 14:30 must differ (smooth diurnal curve).
    t0 = outdoor_temp(datetime(2026, 7, 1, 14, 0))
    t30 = outdoor_temp(datetime(2026, 7, 1, 14, 30))
    assert t0 != t30


def test_bounded_by_physical_range():
    # Every hour of every month stays within a sane Lima range.
    for month in range(1, 13):
        for hour in range(24):
            t = outdoor_temp(datetime(2026, month, 15, hour, 0))
            assert 10.0 < t < 30.0
