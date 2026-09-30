"""Unit tests for the per-room physical metadata (Tier 3)."""
from app.services.room_profile import (
    _DEFAULT_FACTOR,
    _DEFAULT_META,
    METADATA_FEATURES,
    get_metadata,
    thermal_factor,
)


def test_known_room_returns_its_profile():
    meta = get_metadata("A403")
    assert meta["floor"] == 4
    assert set(METADATA_FEATURES) <= set(meta.keys())


def test_unknown_room_returns_neutral_default():
    assert get_metadata("Z999") == _DEFAULT_META
    assert thermal_factor("Z999") == _DEFAULT_FACTOR


def test_room_id_coerced_to_string():
    # Callers may pass non-string ids (e.g. ints from SQL) — must not crash.
    assert get_metadata(12345) == _DEFAULT_META


def test_higher_floor_higher_thermal_factor():
    # M1001 (floor 10) must demand more cooling than M602 (floor 6, smallest room).
    assert thermal_factor("M1001") > thermal_factor("M602")
