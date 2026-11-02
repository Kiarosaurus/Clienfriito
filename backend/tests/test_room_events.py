from datetime import datetime

from app.services.room_events import detect_events

NOW = datetime(2026, 11, 1, 18, 0)


def r(minute, co2=500, co=1.0):
    return {"timestamp": f"2026-11-01T17:{minute:02d}:00", "co2_ppm": co2, "co_ppm": co}


def test_quiet_room_has_no_events():
    assert detect_events("A101", [r(50), r(55), r(59)], NOW) == []


def test_co2_going_up_and_back_gives_two_events():
    ev = detect_events("A101", [r(50), r(52, co2=1600), r(54, co2=1700), r(56, co2=900), r(59)], NOW)
    assert [e["kind"] for e in ev] == ["co2_ppm_high", "co2_ppm_ok"]
    assert ev[0]["timestamp"].endswith("17:52:00") and ev[0]["tone"] == "alert"


def test_co_alarm_is_reported():
    ev = detect_events("A101", [r(57, co=80), r(59, co=85)], NOW)
    assert [e["text"] for e in ev] == ["Alarma de CO"]


def test_sensor_that_stopped_reporting():
    ev = detect_events("A101", [r(10), r(20)], NOW)
    assert ev[-1]["kind"] == "stale" and ev[-1]["timestamp"].endswith("17:20:00")


def test_no_readings_no_events():
    assert detect_events("A101", [], NOW) == []
