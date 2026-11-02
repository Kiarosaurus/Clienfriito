"""
UTEC dataset generator — Climate Cognitive System.

Builds a realistic ~2-month history (Mon 2026-05-18 → Sun 2026-07-05) for the UTEC
Barranco campus and loads it into the databases:

  PostgreSQL : rooms, weekly schedules, sensor_devices, a seed professor user,
               and the FUTURE reservations (after the last sample date).
  MongoDB    : sensor_readings (one document per 10-min tick during each class
               session, plus a 30-min pre-class warm-up, plus 3 idle off-hours
               ticks per room per day for empty-room coverage), each carrying
               the same cognitive_action shape the live ingest pipeline produces.

Occupancy model (mirrors backend/app/services):
  - expected_occupancy → the reservation plan (Schedule.expected_people).
  - actual_occupancy   → realized attendance. Declines linearly across the window
    from the "start" floor to the "current" floor per (room, weekday); special
    dates override it with exact counts.
  - co2_ppm is DERIVED from actual_occupancy (steady-state mass balance) so the
    plan-vs-reality gap stays physically coherent.

Climate: Lima coastal winter (May–Jul) — cool, overcast (garúa), high humidity;
rooms held near a 20 °C A/C target.

Usage (from project root, DB ports exposed on localhost):
    python ml/seed-data/generate_dataset.py            # insert into Mongo + Postgres
    python ml/seed-data/generate_dataset.py --wipe     # clear sensor_readings first
    python ml/seed-data/generate_dataset.py --dry-run  # write JSON to ml/seed-data/output/, no DB

Env overrides: MONGO_URI, POSTGRES_URI
"""
from __future__ import annotations

import argparse
import json
import random
import sys
from datetime import date, datetime, time, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]  # ml/seed-data -> raiz
sys.path.insert(0, str(ROOT / "backend"))

# Windows consoles default to cp1252 — force UTF-8 so log arrows/accents don't crash.
# reconfigure exists on TextIOWrapper but not the TextIO base type — fetch dynamically.
_reconfigure = getattr(sys.stdout, "reconfigure", None)
if callable(_reconfigure):
    try:
        _reconfigure(encoding="utf-8")
    except Exception:
        pass

# Mirror the backend occupancy/thermal constants — single source of truth.
from app.services.occupancy_service import (  # noqa: E402
    CO2_BASELINE_PPM,
    CO2_PPM_PER_PERSON,
    estimate_actual_occupancy,
    occupancy_gap,
)
from app.services.predictive_service import (  # noqa: E402
    FEEDBACK_WEIGHT,
    THERMAL_LOAD_PER_PERSON,
)
from app.services.climate_service import outdoor_temp as outdoor_temp_c  # noqa: E402

random.seed(2026)

# Dedicated seed for the per-(room,date) attendance bump — reproducible regardless
# of iteration order (each day draws from its own keyed RNG).
ATTENDANCE_SEED = 20260518

# ── Window ────────────────────────────────────────────────────────────────────
START_DATE = date(2026, 5, 18)   # first Monday after Sat 2026-05-16
END_DATE = date(2026, 7, 5)      # last sample date (Sunday)
STEP_MIN = 10                    # reading cadence during a session
WARMUP_MIN = 30                  # pre-class ticks (room still empty)

# ── Rooms ─────────────────────────────────────────────────────────────────────
# Building A: two classrooms per floor (A101 … A602). id, name, max_capacity, target_temp
_CAPACITY = {1: 40, 2: 40, 3: 36, 4: 36, 5: 46, 6: 46}
ROOMS = [(f"A{f}0{n}", f"A{f}0{n} Aula", _CAPACITY[f], 20.0) for f in range(1, 7) for n in (1, 2)]
# Location (building, floor) shown and filtered in the dashboard.
ROOM_LOCATION = {r[0]: ("A", int(r[0][1])) for r in ROOMS}
ROOM_CAP = {r[0]: r[2] for r in ROOMS}
ROOM_TARGET = {r[0]: r[3] for r in ROOMS}
# Rooms of earlier seeds: --wipe removes them with their readings, schedules and reservations.
RETIRED_ROOMS = ["M601", "M602", "M604", "M802", "M1001", "A403"]

def sensor_id(room_id: str) -> str:
    return f"s-{room_id}"

# ── Weekly schedule ───────────────────────────────────────────────────────────
# room_id, weekday(0=Mon), start_h, end_h, reservation(expected_people),
# attendance floor at window START, attendance floor at window END (current).
# Classes run Monday–Saturday between 7:00 and 22:00, last 1 or 2 hours and never
# overlap in a room; every room has at least 2 classes a day.
DAY_START, DAY_END = 7, 22
CLASSES_PER_DAY = (2, 4)


def _room_week(room_id: str, cap: int) -> list[tuple]:
    """A reproducible week of classes for one room."""
    r = random.Random(f"schedule:{room_id}:{ATTENDANCE_SEED}")
    out = []
    for day in range(6):
        wanted = r.randint(*CLASSES_PER_DAY)
        taken: list[tuple[int, int]] = []
        tries = 0
        while len(taken) < wanted and tries < 200:
            tries += 1
            length = r.choice([1, 2, 2])
            start = r.randint(DAY_START, DAY_END - length)
            if any(start < b and a < start + length for a, b in taken):
                continue
            taken.append((start, start + length))
        for a, b in sorted(taken):
            expected = r.randint(int(cap * 0.5), cap)
            f_start = r.randint(int(expected * 0.5), int(expected * 0.85))
            f_end = max(3, f_start - r.randint(2, 8))
            out.append((room_id, day, a, b, expected, f_start, f_end))
    return out


SCHEDULES = [row for rid, _, cap, _ in ROOMS for row in _room_week(rid, cap)]
assert all(len([s for s in SCHEDULES if s[0] == rid and s[1] == d]) >= 2
           for rid, *_ in ROOMS for d in range(6))

# ── Special high-attendance dates: (room_id, "YYYY-MM-DD") → exact people ──────
SPECIAL: dict[tuple[str, str], int] = {}

# ── Upcoming reservations: room_id, date, start_h, end_h, expected ─────────────
# A few one-off bookings in the week shown by the dashboard, in free slots.
FUTURE_RESERVATIONS = [
    ("A101", "2026-11-03", 20, 22, 25),
    ("A302", "2026-11-04", 18, 20, 30),
    ("A501", "2026-11-06", 12, 14, 40),
    ("A602", "2026-11-07", 15, 17, 20),
]


def attendance_floor(sch, d: date) -> int:
    """Linear decline from the START floor to the END (current) floor."""
    _, _, _, _, _, f_start, f_end = sch
    span = (END_DATE - START_DATE).days or 1
    progress = (d - START_DATE).days / span
    progress = min(1.0, max(0.0, progress))
    return round(f_start + (f_end - f_start) * progress)


def realized_people(sch, d: date) -> int:
    room_id = sch[0]
    key = (room_id, d.isoformat())
    if key in SPECIAL:
        return min(SPECIAL[key], ROOM_CAP[room_id])
    floor = attendance_floor(sch, d)
    reservation = sch[4]
    # Decline is linear BUT not monotonic: a reproducible per-(room,date) draw
    # bumps attendance up by 1 or 2 on some days, so the curve wobbles upward.
    r = random.Random(f"{room_id}:{d.isoformat()}:{ATTENDANCE_SEED}")
    bump = r.choice([0, 1, 2])                        # random upward factor (+1 / +2)
    people = floor + bump                             # "al menos <floor>"
    return max(floor, min(people, reservation, ROOM_CAP[room_id]))


def synth_reading(room_id: str, people: int, ts: datetime, expected: int) -> dict:
    """Build one Mongo sensor_readings document + its cognitive_action.

    `expected` is the session's own reservation (0 for idle off-hours ticks,
    mirroring what the live pipeline yields when no schedule matches).
    """
    # CO2 derived from realized occupancy (forward mass balance) + sensor jitter.
    co2 = round(max(400.0, CO2_BASELINE_PPM + people * CO2_PPM_PER_PERSON + random.gauss(0, 15)), 2)
    # Exogenous outdoor temp (Lima seasonal/diurnal model) — stored so extract_data
    # reads the real value instead of re-deriving it.
    outdoor = outdoor_temp_c(ts)
    # Indoor temp with A/C: near target + occupancy rise + partial outdoor leakage
    # through the envelope. Couples indoor to the exogenous driver realistically.
    temp = round(20.0 + people * 0.04 + max(0.0, outdoor - 20.0) * 0.12 + random.gauss(0, 0.3), 2)
    humidity = round(min(85.0, max(55.0, 68.0 + people * 0.1 + random.gauss(0, 3))), 1)
    # Ambient MQ-7 baseline ~1.5 ppm (a real sensor never reads a hard 0 in air).
    # Deliberately NO CO emergencies in the seed: these docs carry
    # is_simulated=False, so a seeded spike would surface as a REAL alert.
    co_ppm = round(max(0.0, random.gauss(1.5, 0.6)), 2)

    # cognitive_action — mirror predictive_service (heuristic path).
    actual = estimate_actual_occupancy(co2, ROOM_CAP[room_id])
    effective = expected if actual is None else (1 - FEEDBACK_WEIGHT) * expected + FEEDBACK_WEIGHT * actual
    thermal = round(effective * THERMAL_LOAD_PER_PERSON, 3)
    target_adj = round(ROOM_TARGET[room_id] - thermal, 2)
    ac_on = temp > target_adj
    cognitive = {
        "ac_status": "ON" if ac_on else "STANDBY",
        "cooling_mode": "PRE-COOLING" if ac_on else None,
        "target": target_adj,
        "thermal_load_offset": thermal,
        "model": "heuristic",
        "expected_occupancy": expected,
        "actual_occupancy": actual,
        "effective_occupancy": round(effective, 2),
        "occupancy_gap": occupancy_gap(expected, actual),
    }
    return {
        "sensor_id": sensor_id(room_id),
        "temperature": temp,
        "humidity": humidity,
        "co2_ppm": co2,
        "co_ppm": co_ppm,
        "outdoor_temp": outdoor,
        "is_simulated": False,
        "timestamp": ts.strftime("%Y-%m-%dT%H:%M:%S.%f"),
        "cognitive_action": cognitive,
    }


# Hours a room is busy per weekday (session span + warm-up hour) — used to keep
# idle ticks from colliding with class time.
_BUSY: dict[tuple[str, int], set[int]] = {}
for _sch in SCHEDULES:
    _BUSY.setdefault((_sch[0], _sch[1]), set()).update(range(_sch[2] - 1, _sch[3] + 1))


def idle_readings(d: date) -> list[dict]:
    """Sparse empty-room ticks outside class hours (3 per room per day).

    Gives the model real off-hours / weekend coverage — nights, weekends and
    idle rooms in STANDBY with people=0 — instead of relying solely on the
    synthetic bootstrap for that region. Seeded per (room, date): reproducible
    and order-independent.
    """
    docs: list[dict] = []
    for rid, *_ in ROOMS:
        busy = _BUSY.get((rid, d.weekday()), set())
        free = [h for h in range(24) if h not in busy]
        r = random.Random(f"idle:{rid}:{d.isoformat()}:{ATTENDANCE_SEED}")
        for hh in sorted(r.sample(free, 3)):
            ts = datetime.combine(d, time(hh, r.choice([0, 10, 20, 30, 40, 50])))
            docs.append(synth_reading(rid, 0, ts, expected=0))
    return docs


def generate_readings() -> list[dict]:
    docs: list[dict] = []
    d = START_DATE
    while d <= END_DATE:
        for sch in SCHEDULES:
            if sch[1] != d.weekday():
                continue
            people = realized_people(sch, d)
            class_start = datetime.combine(d, time(sch[2], 0))
            class_end = datetime.combine(d, time(sch[3], 0))
            t = class_start - timedelta(minutes=WARMUP_MIN)
            while t <= class_end:
                present = 0 if t < class_start else people
                docs.append(synth_reading(sch[0], present, t, expected=sch[4]))
                t += timedelta(minutes=STEP_MIN)
        docs.extend(idle_readings(d))
        d += timedelta(days=1)
    return docs


# ── Persistence ───────────────────────────────────────────────────────────────

def insert_mongo(docs: list[dict], wipe: bool) -> None:
    import os
    from pymongo import MongoClient

    uri = os.getenv("MONGO_URI", "mongodb://localhost:27017")
    client = MongoClient(uri, serverSelectionTimeoutMS=5000)
    col = client["climate_db"]["sensor_readings"]
    seed_ids = [sensor_id(r[0]) for r in ROOMS]
    if wipe:
        # Seed readings only (plus retired rooms): the month-long strategy simulation
        # (demo_seed rows from ml/simulation) stays.
        retired = col.delete_many({"sensor_id": {"$in": [sensor_id(r) for r in RETIRED_ROOMS]}}).deleted_count
        deleted = col.delete_many({"sensor_id": {"$in": seed_ids}, "demo_seed": {"$ne": True}}).deleted_count
        print(f"  Mongo: wiped {deleted} seed readings and {retired} of retired rooms.")
    else:
        # Idempotency guard: a second run without --wipe would silently duplicate
        # every reading, corrupting telemetry and the ROI report.
        existing = col.count_documents({"sensor_id": {"$in": seed_ids}, "demo_seed": {"$ne": True}})
        if existing:
            print(
                f"  Mongo: {existing} seed readings already present — "
                "re-run with --wipe to regenerate. Skipping insert."
            )
            return
    col.insert_many(docs)
    print(f"  Mongo: inserted {len(docs)} sensor_readings.")


def insert_postgres() -> None:
    import os
    from app.database_sql import Base
    from app.models.admin import Room, Schedule, SensorDevice, Reservation, User
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    uri = os.getenv(
        "POSTGRES_URI",
        "postgresql://postgres:postgres@localhost:5432/climate_db",
    )
    engine = create_engine(uri)
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine)
    s = Session()
    try:
        # Seed professor user for reservations (idempotent by username)
        prof = s.query(User).filter(User.username == "profesor_utec").first()
        if not prof:
            # Fail loud if the hasher is unavailable — a silent fallback would
            # store an unusable sentinel and break the seed user's login.
            from app.core.security import hash_password
            prof = User(username="profesor_utec",
                        hashed_password=hash_password("profesor_utec"),
                        role="collaborator", status="active")
            s.add(prof)
            s.flush()

        for rid, name, cap, target in ROOMS:
            building, floor = ROOM_LOCATION[rid]
            s.merge(Room(id=rid, name=name, max_capacity=cap, target_temp=target,
                         control_policy="auto", building=building, floor=floor))
            s.merge(SensorDevice(id=sensor_id(rid), room_id=rid,
                                 is_active=True, control_enabled=True))

        # Rooms from earlier seeds: out, with everything that hangs from them.
        s.query(Schedule).filter(Schedule.room_id.in_(RETIRED_ROOMS)).delete(synchronize_session=False)
        s.query(Reservation).filter(Reservation.room_id.in_(RETIRED_ROOMS)).delete(synchronize_session=False)
        s.query(SensorDevice).filter(SensorDevice.room_id.in_(RETIRED_ROOMS)).delete(synchronize_session=False)
        s.query(Room).filter(Room.id.in_(RETIRED_ROOMS)).delete(synchronize_session=False)

        # Weekly schedules — clear this window's rooms first to stay idempotent
        room_ids = [r[0] for r in ROOMS]
        s.query(Schedule).filter(Schedule.room_id.in_(room_ids)).delete(synchronize_session=False)
        for rid, wd, sh, eh, resv, *_ in SCHEDULES:
            s.add(Schedule(room_id=rid, day_of_week=wd,
                           start_time=time(sh, 0), end_time=time(eh, 0),
                           expected_people=resv))

        # Future reservations
        for rid, dstr, sh, eh, exp in FUTURE_RESERVATIONS:
            y, m, dd = map(int, dstr.split("-"))
            st = datetime(y, m, dd, sh, 0)
            en = datetime(y, m, dd, eh, 0)
            exists = s.query(Reservation).filter(
                Reservation.room_id == rid,
                Reservation.start_time == st,
            ).first()
            if not exists:
                s.add(Reservation(room_id=rid, user_id=prof.id,
                                  start_time=st, end_time=en, expected_occupancy=exp))
        s.commit()
        print(f"  Postgres: {len(ROOMS)} rooms, {len(SCHEDULES)} schedules, "
              f"{len(FUTURE_RESERVATIONS)} future reservations upserted.")
    except Exception:
        s.rollback()
        raise
    finally:
        s.close()


def dump_json(docs: list[dict]) -> None:
    out = Path(__file__).parent / "output"
    out.mkdir(exist_ok=True)
    (out / "sensor_readings.json").write_text(
        json.dumps(docs, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    meta = {
        "rooms": [{"id": r[0], "name": r[1], "max_capacity": r[2],
                   "target_temp": r[3], "sensor_id": sensor_id(r[0])} for r in ROOMS],
        "schedules": [{"room_id": s[0], "day_of_week": s[1], "start_h": s[2],
                       "end_h": s[3], "reservation": s[4],
                       "floor_start": s[5], "floor_end": s[6]} for s in SCHEDULES],
        "future_reservations": [{"room_id": r[0], "date": r[1], "start_h": r[2],
                                 "end_h": r[3], "expected_occupancy": r[4]}
                                for r in FUTURE_RESERVATIONS],
    }
    (out / "catalog.json").write_text(
        json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(f"  Dry run: wrote {len(docs)} readings + catalog to {out}")


def main() -> None:
    ap = argparse.ArgumentParser(description="Generate UTEC seed dataset.")
    ap.add_argument("--wipe", action="store_true", help="clear sensor_readings before insert")
    ap.add_argument("--dry-run", action="store_true", help="write JSON only, no DB")
    args = ap.parse_args()

    print(f"Generating readings {START_DATE} → {END_DATE} "
          f"(every {STEP_MIN} min, {WARMUP_MIN} min warm-up)...")
    docs = generate_readings()
    print(f"Generated {len(docs)} readings across {len(ROOMS)} rooms.")

    if args.dry_run:
        dump_json(docs)
        return

    print("Loading databases...")
    insert_postgres()
    insert_mongo(docs, wipe=args.wipe)
    print("Done.")


if __name__ == "__main__":
    main()
