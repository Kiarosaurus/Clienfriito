"""Energy per room from the month-long strategy simulation, against a reference.

Reference: what the room would use without the system, i.e. each class with the
equipment at full power for its whole length: the heater if the room starts the
class colder than COLD_START_C, otherwise the extractor. Real use is what the
simulated strategy actually drew (fan power grows with the cube of its speed).

All figures are scaled to a 30-day month so rooms simulated for slightly different
spans compare fairly.
"""
from datetime import datetime

MONTH_DAYS = 30
COLD_START_C = 23.5

# Luz del Sur, pliego tarifario 04/10/2026, Lima Sur, MT4, energía con IGV.
TARIFF_PEN_PER_KWH = 0.3644
TARIFF_LABEL = "Luz del Sur MT4, pliego oct. 2026, con IGV. Solo energía."

# (room, strategy) -> (generated_at, result). The simulation only changes when it is
# regenerated, which bumps generated_at in its meta.
_CACHE: dict[tuple[str, str], tuple[datetime, dict]] = {}


def strategy_kwh(rows: list[dict], step_s: float, fan_w: float, heat_w: float) -> float:
    """Energy drawn by a strategy: fan at fan_w·speed³, heater at heat_w·duty."""
    wh = sum(fan_w * (r.get("fan") or 0) ** 3 + heat_w * (r.get("heat") or 0) for r in rows)
    return wh * step_s / 3600 / 1000


def reference_kwh(rows: list[dict], step_s: float, fan_w: float, heat_w: float) -> tuple[float, float]:
    """(kWh, class hours) with every class at full power. Rows must be sorted by time."""
    kwh = hours = 0.0
    i, n = 0, len(rows)
    while i < n:
        if not rows[i].get("occupied"):
            i += 1
            continue
        j = i
        while j < n and rows[j].get("occupied"):
            j += 1
        h = (j - i) * step_s / 3600
        temp = rows[i].get("temperature")
        watts = heat_w if temp is not None and temp < COLD_START_C else fan_w
        kwh += h * watts / 1000
        hours += h
        i = j
    return kwh, hours


async def _room_strategy(db, meta: dict, strategy: str) -> dict:
    room = meta["_id"]
    key = (room, strategy)
    hit = _CACHE.get(key)
    if hit and hit[0] == meta.get("generated_at"):
        return hit[1]
    eq = meta.get("equipment") or {}
    fan_w, heat_w, step = float(eq.get("fan_max_w", 0)), float(eq.get("heater_w", 0)), float(meta["step_s"])
    rows = await (
        db["strategy_simulation"]
        .find({"room_id": room, "strategy": strategy},
              {"_id": 0, "fan": 1, "heat": 1, "occupied": 1, "temperature": 1})
        .sort("ts", 1)
        .to_list(length=None)
    )
    ref, hours = reference_kwh(rows, step, fan_w, heat_w)
    result = {"kwh": strategy_kwh(rows, step, fan_w, heat_w), "reference_kwh": ref, "class_hours": hours}
    _CACHE[key] = (meta.get("generated_at"), result)
    return result


async def room_energy(db, meta: dict) -> dict:
    """Monthly kWh for one simulated room: reference, rules and learning."""
    days = max((meta["end"] - meta["start"]).total_seconds() / 86400, 1)
    scale = MONTH_DAYS / days
    rules = await _room_strategy(db, meta, "rules")
    learning = await _room_strategy(db, meta, "learning")
    return {
        "room_id": meta["_id"],
        "copied_from": meta.get("copied_from"),
        "days": round(days, 1),
        "class_hours": round(rules["class_hours"] * scale, 1),
        "reference_kwh": round(rules["reference_kwh"] * scale, 1),
        "rules_kwh": round(rules["kwh"] * scale, 1),
        "learning_kwh": round(learning["kwh"] * scale, 1),
    }
