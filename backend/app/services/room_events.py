"""Recent events of a room, derived from its readings (no separate event log).

An event is a change of state worth telling: CO₂ or CO crossing into the alert range
(and back), and a sensor that stopped reporting. Thresholds match the dashboard's
alert levels (frontend/src/utils/sensorColors.ts).
"""
from datetime import datetime

CO2_ALERT_PPM = 1500
CO_ALERT_PPM = 50
STALE_MIN = 15

# (field, threshold, text when it goes up, text when it comes back)
_CHECKS = (
    ("co_ppm", CO_ALERT_PPM, "Alarma de CO", "Alarma de CO resuelta"),
    ("co2_ppm", CO2_ALERT_PPM, f"CO₂ sobre {CO2_ALERT_PPM} ppm", "CO₂ volvió a la normalidad"),
)


def _parse(ts: str) -> datetime | None:
    try:
        return datetime.fromisoformat(ts.replace("Z", ""))
    except (ValueError, AttributeError):
        return None


def detect_events(room_id: str, readings: list[dict], now: datetime) -> list[dict]:
    """Events in time order. `readings` sorted by timestamp, oldest first; `now` naive UTC."""
    events: list[dict] = []
    high = {field: False for field, *_ in _CHECKS}
    for r in readings:
        for field, limit, up, down in _CHECKS:
            value = r.get(field)
            if value is None:
                continue
            is_high = value > limit
            if is_high != high[field]:
                events.append({
                    "room_id": room_id, "timestamp": r["timestamp"],
                    "kind": f"{field}_{'high' if is_high else 'ok'}",
                    "text": up if is_high else down, "tone": "alert" if is_high else "ok",
                })
                high[field] = is_high
    if readings:
        last = _parse(readings[-1]["timestamp"])
        if last and (now - last).total_seconds() > STALE_MIN * 60:
            events.append({"room_id": room_id, "timestamp": readings[-1]["timestamp"],
                           "kind": "stale", "text": "Dejó de reportar", "tone": "muted"})
    return events
