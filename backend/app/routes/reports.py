"""
ROI Report endpoint — Energy savings calculator.

Methodology:
  - Fetches last 7 days of sensor readings from MongoDB.
  - Groups readings by calendar date.
  - Estimates the time interval between readings from the actual data span.
  - Traditional consumption: assumes AC ON for 100% of operational time.
  - Cognitive consumption: counts only readings where cognitive_action.ac_status == 'ON'.
  - Savings = (traditional_kwh − cognitive_kwh) expressed in kWh and USD.
  - If fewer than 2 real readings exist, returns a clearly-flagged synthetic simulation
    based on standard classroom assumptions (8 h/day, 60% standby rate).

Access: admin role only (RBAC enforced inside the endpoint).
"""
import logging
from collections import defaultdict
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException
from motor.motor_asyncio import AsyncIOMotorDatabase

from app.core.timeutils import local_now, to_local
from app.database import get_db
from app.dependencies import get_current_user
from app.models.admin import User

logger = logging.getLogger(__name__)
router = APIRouter()

# ── Constants ─────────────────────────────────────────────────────────────────
AC_POWER_KW        = 2.5    # assumed power draw of one AC unit (kW)
COST_PER_KWH       = 0.15   # energy tariff (USD per kWh)
DEFAULT_INTERVAL_H = 5 / 60 # fallback interval when span cannot be estimated


# ── Helpers ───────────────────────────────────────────────────────────────────

def _parse_ts(ts: str) -> datetime | None:
    """Parse ISO timestamp string — strips tzinfo for uniform naive comparison.

    Returns None for malformed values so the caller can DISCARD the document;
    silently mapping garbage to "now" would inflate today's bucket.
    """
    ts = ts.replace("Z", "+00:00")
    try:
        dt = datetime.fromisoformat(ts)
    except ValueError:
        return None
    return dt.replace(tzinfo=None) if dt.tzinfo else dt


def _simulate_roi() -> dict:
    """Return synthetic ROI projection for demo / early-deployment environments.

    Assumes standard classroom profile: 8 operational hours per day, with the
    cognitive system keeping the AC in STANDBY 60% of that time.
    Response includes 'simulated: true' so the frontend renders the amber banner.
    """
    today = local_now().date()
    trend_data = []
    total_traditional = total_cognitive = 0.0

    for i in range(6, -1, -1):
        day = today - timedelta(days=i)
        operational_h = 8.0
        standby_h     = operational_h * 0.60   # cognitive keeps 60% in standby
        on_h          = operational_h - standby_h

        trad = operational_h * AC_POWER_KW
        cog  = on_h          * AC_POWER_KW
        sav  = standby_h     * AC_POWER_KW

        total_traditional += trad
        total_cognitive   += cog

        trend_data.append({
            "date":             str(day),
            "traditional_kwh":  round(trad, 3),
            "cognitive_kwh":    round(cog, 3),
            "savings_kwh":      round(sav, 3),
        })

    energy_saved = total_traditional - total_cognitive
    return {
        "total_hours_analyzed":   56.0,
        "total_readings":         0,
        "traditional_kwh":        round(total_traditional, 3),
        "cognitive_kwh":          round(total_cognitive, 3),
        "energy_saved_kwh":       round(energy_saved, 3),
        "standby_hours":          round(energy_saved / AC_POWER_KW, 2),
        "total_savings_currency": round(energy_saved * COST_PER_KWH, 2),
        "currency":               "USD",
        "assumptions":            {"ac_power_kw": AC_POWER_KW, "cost_per_kwh": COST_PER_KWH,
                                   "estimated_interval_minutes": 5.0},
        "trend_data":             trend_data,
        "simulated":              True,
    }


# ── Endpoint ──────────────────────────────────────────────────────────────────

@router.get("/roi")
async def get_roi(
    db: AsyncIOMotorDatabase = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    if current_user.role != "admin":
        raise HTTPException(status_code=403, detail="Admin role required.")

    # ── Fetch last 7 days from MongoDB ────────────────────────────────────────
    # Upper bound matters: the seeded dataset extends past today, and without it
    # future-dated readings would inflate the "last 7 days" report.
    now_utc = datetime.utcnow()
    since_iso = (now_utc - timedelta(days=7)).isoformat()
    now_iso = now_utc.isoformat()

    cursor = (
        db["sensor_readings"]
        .find(
            {"timestamp": {"$gte": since_iso, "$lte": now_iso}},
            {"timestamp": 1, "cognitive_action": 1, "_id": 0},
        )
        .sort("timestamp", 1)
    )
    docs = await cursor.to_list(length=50_000)

    # Discard documents whose timestamp cannot be parsed (see _parse_ts).
    valid_docs = [d for d in docs if _parse_ts(d.get("timestamp", "")) is not None]
    if len(valid_docs) != len(docs):
        logger.warning("ROI: discarded %d readings with malformed timestamps.", len(docs) - len(valid_docs))
    docs = valid_docs

    if len(docs) < 2:
        logger.info("ROI: insufficient data (%d readings) — returning simulation.", len(docs))
        return _simulate_roi()

    # ── Estimate per-reading interval ─────────────────────────────────────────
    ts_first  = _parse_ts(docs[0]["timestamp"])
    ts_last   = _parse_ts(docs[-1]["timestamp"])
    # Both are non-None here (docs were filtered above); guard for the type checker.
    span_h    = (
        max((ts_last - ts_first).total_seconds() / 3600, 0.0)
        if ts_first is not None and ts_last is not None else 0.0
    )
    n         = len(docs)
    interval_h = (span_h / (n - 1)) if span_h > 0 else DEFAULT_INTERVAL_H

    # ── Group by LOCAL calendar date ──────────────────────────────────────────
    # Timestamps are stored naive UTC; slicing the raw string would split days
    # at 19:00 Lima. Shift to local wall-clock before taking the date.
    by_day: dict[str, list] = defaultdict(list)
    for doc in docs:
        ts = _parse_ts(doc.get("timestamp", ""))
        if ts is None:  # already filtered above; guard for the type checker
            continue
        by_day[to_local(ts).date().isoformat()].append(doc)

    # ── Compute per-day and aggregate totals ──────────────────────────────────
    trend_data: list[dict] = []
    total_traditional = total_cognitive = total_standby_h = 0.0

    for date in sorted(by_day.keys()):
        day_docs  = by_day[date]
        n_day     = len(day_docs)

        standby_n = sum(
            1 for d in day_docs
            if (d.get("cognitive_action") or {}).get("ac_status") == "STANDBY"
        )
        on_n      = sum(
            1 for d in day_docs
            if (d.get("cognitive_action") or {}).get("ac_status") == "ON"
        )

        day_trad  = n_day    * interval_h * AC_POWER_KW
        day_cog   = on_n     * interval_h * AC_POWER_KW
        day_sav   = standby_n * interval_h * AC_POWER_KW
        day_std_h = standby_n * interval_h

        total_traditional += day_trad
        total_cognitive   += day_cog
        total_standby_h   += day_std_h

        trend_data.append({
            "date":             date,
            "traditional_kwh":  round(day_trad, 3),
            "cognitive_kwh":    round(day_cog, 3),
            "savings_kwh":      round(day_sav, 3),
        })

    energy_saved = total_traditional - total_cognitive

    logger.info(
        "ROI computed: %d readings, %.2f h span, %.3f kWh saved, $%.2f",
        n, span_h, energy_saved, energy_saved * COST_PER_KWH,
    )

    return {
        "total_hours_analyzed":   round(span_h, 2),
        "total_readings":         n,
        "traditional_kwh":        round(total_traditional, 3),
        "cognitive_kwh":          round(total_cognitive, 3),
        "energy_saved_kwh":       round(energy_saved, 3),
        "standby_hours":          round(total_standby_h, 2),
        "total_savings_currency": round(energy_saved * COST_PER_KWH, 2),
        "currency":               "USD",
        "assumptions": {
            "ac_power_kw":                  AC_POWER_KW,
            "cost_per_kwh":                 COST_PER_KWH,
            "estimated_interval_minutes":   round(interval_h * 60, 1),
        },
        "trend_data":  trend_data,
        "simulated":   False,
    }
