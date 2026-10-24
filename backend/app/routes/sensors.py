import logging
from datetime import datetime, timezone, timedelta
# CAMBIO: antes era "from typing import Optional" — se agregó "List" porque
# ahora usamos response_model=List[...] en list_readings.
from typing import List, Optional
from fastapi import APIRouter, Depends, HTTPException, Query
from pymongo.errors import PyMongoError
from motor.motor_asyncio import AsyncIOMotorDatabase
from pydantic import BaseModel
from sqlalchemy.orm import Session
from sqlalchemy.exc import SQLAlchemyError
from starlette.concurrency import run_in_threadpool

from app.core.timeutils import local_now
from app.models.sensor import SensorReading
from app.models.admin import SensorDevice, Reservation, User, Room
# LÍNEA NUEVA — antes este import no existía. Trae el modelo de error compartido.
from app.models.common import ErrorDetail
from app.services.data_service import process_reading
from app.database import get_db
from app.database_sql import get_db_sql
from app.dependencies import get_current_user

logger = logging.getLogger(__name__)
router = APIRouter()


# ============================================================================
# BLOQUE NUEVO — todas estas clases (CognitiveActionOut, SensorReadingOut,
# EmergencyEntryOut, EmergenciesOut, SensorControlOut) no existían antes.
# Antes cada endpoint solo hacía "return {...}" o "return docs" sin declarar
# la forma de la respuesta, por eso en Watson el panel "Response" salía vacío.
# ============================================================================
# Declared so Watson's extension "Response" panel can expose these fields as
# insertable variables — FastAPI otherwise emits an empty schema for plain
# dict/list returns, leaving Watson with nothing to map.

class CognitiveActionOut(BaseModel):
    ac_status: str
    cooling_mode: Optional[str] = None
    target: Optional[float] = None
    thermal_load_offset: Optional[float] = None
    model: str
    expected_occupancy: Optional[float] = None
    actual_occupancy: Optional[float] = None
    effective_occupancy: Optional[float] = None
    occupancy_gap: Optional[float] = None


class SensorReadingOut(BaseModel):
    sensor_id: str
    temperature: float
    humidity: float
    co2_ppm: Optional[float] = None
    co_ppm: float = 0.0
    camera_occupancy: Optional[int] = None
    is_simulated: bool = False
    timestamp: str
    cognitive_action: Optional[CognitiveActionOut] = None


class EmergencyEntryOut(BaseModel):
    room_id: str
    room_name: str
    sensor_id: str
    co_ppm: float
    timestamp: Optional[str] = None
    is_simulated: bool


class EmergenciesOut(BaseModel):
    real: List[EmergencyEntryOut]
    simulated: List[EmergencyEntryOut]


class SensorControlOut(BaseModel):
    sensor_id: str
    room_id: Optional[str] = None
    is_active: bool
    control_enabled: bool


@router.post("/", status_code=201)
async def ingest_reading(
    reading: SensorReading,
    db: AsyncIOMotorDatabase = Depends(get_db),
    db_sql: Session = Depends(get_db_sql),
):
    try:
        result = await process_reading(db, reading, db_sql=db_sql)
    except PyMongoError as exc:
        logger.error("MongoDB unavailable: %s", exc)
        raise HTTPException(status_code=503, detail="Database unavailable") from exc
    return result


# ANTES: @router.get("/")
# AHORA: se agrega response_model=List[SensorReadingOut] — es el endpoint de
# la Action 1 (Estado del aula) de la guía de Watson.
@router.get("/", response_model=List[SensorReadingOut])
async def list_readings(
    room_id: Optional[str] = None,
    sensor_id: Optional[str] = None,
    limit: int = Query(40, ge=1, le=200),
    db: AsyncIOMotorDatabase = Depends(get_db),
    db_sql: Session = Depends(get_db_sql),
):
    mongo_filter: dict = {}

    if room_id is not None:
        ids = await run_in_threadpool(
            lambda: [d.id for d in db_sql.query(SensorDevice).filter(SensorDevice.room_id == room_id).all()]
        )
        if not ids:
            return []
        mongo_filter["sensor_id"] = {"$in": ids}
    elif sensor_id is not None:
        mongo_filter["sensor_id"] = sensor_id

    cursor = db["sensor_readings"].find(mongo_filter).sort("timestamp", -1).limit(limit)
    docs = await cursor.to_list(length=limit)
    for d in docs:
        d.pop("_id", None)
    return docs


@router.delete("/simulated", status_code=200, responses={403: {"model": ErrorDetail}})
async def purge_simulated_readings(
    db: AsyncIOMotorDatabase = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Delete ALL simulated readings immediately.

    Called by the dashboard when leaving simulation mode (switch to real data
    or navigating away) so synthetic CO spikes stop feeding /emergencies at
    once, instead of waiting for the 15-second purge window.
    """
    if current_user.role not in ("admin", "collaborator"):
        raise HTTPException(status_code=403, detail="Admin or collaborator role required.")
    try:
        result = await db["sensor_readings"].delete_many({"is_simulated": True})
    except PyMongoError as exc:
        logger.error("MongoDB unavailable purging simulated readings: %s", exc)
        raise HTTPException(status_code=503, detail="Database unavailable") from exc
    if result.deleted_count:
        logger.info("Purged %d simulated readings ('%s').", result.deleted_count, current_user.username)
    return {"deleted": result.deleted_count}


# ── Emergency monitor ────────────────────────────────────────────────────────

_SIM_KEYWORDS = ("SIM", "TEST")


def _looks_synthetic(sensor_id: str, room_id: str | None) -> bool:
    """True when the sensor or room ID contains a known simulation keyword."""
    haystack = ((sensor_id or "") + (room_id or "")).upper()
    return any(kw in haystack for kw in _SIM_KEYWORDS)


# ANTES: @router.get("/emergencies")
# AHORA: se agregan response_model=EmergenciesOut y responses={403:...} — es
# el endpoint de la Action 7 (Emergencias de CO) de la guía de Watson.
@router.get("/emergencies", response_model=EmergenciesOut, responses={403: {"model": ErrorDetail}})
async def get_co_emergencies(
    db: AsyncIOMotorDatabase = Depends(get_db),
    db_sql: Session = Depends(get_db_sql),
    current_user: User = Depends(get_current_user),
):
    """Return CO > 50 ppm alerts from the last 15 seconds, split into real vs simulated.

    Hard-fallback rules (any one forces simulated):
      1. is_simulated flag is True in the stored reading
      2. sensor_id or resolved room_id contains 'SIM' or 'TEST'
      3. Sensor not registered in SQL (room_id cannot be resolved)
      4. room_id does not exist in the rooms table

    Only real if is_simulated is strictly False AND the room resolves to a known SQL room.
    """
    if current_user.role not in ("admin", "collaborator"):
        raise HTTPException(status_code=403, detail="Admin or collaborator role required.")

    now = datetime.now(timezone.utc)

    # Purge simulated readings older than 15 seconds — if the simulator stops sending,
    # the DB is clean within one polling cycle and the frontend receives nothing.
    fifteen_sec_ago = (now - timedelta(seconds=15)).strftime("%Y-%m-%dT%H:%M:%S.%f")
    purge = await db["sensor_readings"].delete_many(
        {"is_simulated": True, "timestamp": {"$lt": fifteen_sec_ago}}
    )
    if purge.deleted_count:
        print(f"Purging old simulation data...")

    cursor = db["sensor_readings"].find(
        {"co_ppm": {"$gt": 50}, "timestamp": {"$gte": fifteen_sec_ago}}
    ).sort("co_ppm", -1)

    docs = await cursor.to_list(length=200)

    if not docs:
        return {"real": [], "simulated": []}

    # Deduplicate — one entry per sensor_id, highest co_ppm wins (already sorted desc)
    seen: dict[str, dict] = {}
    for doc in docs:
        sid = doc["sensor_id"]
        if sid not in seen:
            seen[sid] = doc

    # Enrich with room names from SQL — one threadpool hop for both queries:
    # this endpoint is polled every 5 s per client.
    sensor_ids = list(seen.keys())

    def _load_sql_context() -> tuple[dict[str, str], dict[str, str]]:
        devices = db_sql.query(SensorDevice).filter(SensorDevice.id.in_(sensor_ids)).all()
        room_ids = list({d.room_id for d in devices})
        rooms = db_sql.query(Room).filter(Room.id.in_(room_ids)).all()
        return {d.id: d.room_id for d in devices}, {r.id: r.name for r in rooms}

    device_to_room, room_name_map = await run_in_threadpool(_load_sql_context)

    real: list[dict] = []
    simulated: list[dict] = []

    for sid, doc in seen.items():
        rid = device_to_room.get(sid)                 # None → sensor not in SQL
        resolved_name = room_name_map.get(rid) if rid else None  # None → room not in SQL

        is_sim_flag   = bool(doc.get("is_simulated", False))
        id_synthetic  = _looks_synthetic(sid, rid)
        room_unknown  = resolved_name is None         # any gap in SQL chain → synthetic

        # DEBUG: show exactly why each entry was bucketed real vs simulated
        print(
            f"[EMERGENCY] sid={sid} rid={rid} resolved={resolved_name!r} "
            f"is_sim_flag={is_sim_flag} id_synthetic={id_synthetic} room_unknown={room_unknown} "
            f"co_ppm={doc.get('co_ppm')} ts={doc.get('timestamp')}"
        )

        entry = {
            "room_id":    rid or sid,
            "room_name":  resolved_name or "Simulación",
            "sensor_id":  sid,
            "co_ppm":     doc.get("co_ppm", 0),
            "timestamp":  doc.get("timestamp"),
        }

        if is_sim_flag or id_synthetic or room_unknown:
            simulated.append({**entry, "is_simulated": True})
        else:
            real.append({**entry, "is_simulated": False})

    if real:
        logger.warning(
            "CO REAL EMERGENCY — '%s' polling: %d sensor(s) — rooms: %s",
            current_user.username, len(real), [r["room_name"] for r in real],
        )
    if simulated:
        logger.info(
            "CO simulated alert — '%s' polling: %d sensor(s) (hard-fallback applied)",
            current_user.username, len(simulated),
        )

    return {"real": real, "simulated": simulated}


# ── Sensor control ────────────────────────────────────────────────────────────

class SensorControlIn(BaseModel):
    is_active: bool
    control_enabled: bool


# ANTES: @router.put("/{sensor_id}/control")
# AHORA: se agregan response_model=SensorControlOut y responses={401,403,404}
# — es el endpoint de la Action 12 (Encender/apagar sensor) de la guía.
@router.put(
    "/{sensor_id}/control",
    response_model=SensorControlOut,
    responses={401: {"model": ErrorDetail}, 403: {"model": ErrorDetail}, 404: {"model": ErrorDetail}},
)
def control_sensor(
    sensor_id: str,
    payload: SensorControlIn,
    db_sql: Session = Depends(get_db_sql),
    current_user: User = Depends(get_current_user),
):
    # guests never allowed
    if current_user.role == "guest":
        raise HTTPException(status_code=403, detail="Guests cannot control sensors.")

    device = db_sql.query(SensorDevice).filter(SensorDevice.id == sensor_id).first()
    if not device:
        raise HTTPException(status_code=404, detail=f"Sensor '{sensor_id}' not registered.")

    # collaborators need an active reservation on this room
    if current_user.role == "collaborator":
        # Reservations are stored in LOCAL wall-clock time (same convention as
        # schedules) — see app.core.timeutils.
        now = local_now()
        active = db_sql.query(Reservation).filter(
            Reservation.user_id == current_user.id,
            Reservation.room_id == device.room_id,
            Reservation.start_time <= now,
            Reservation.end_time >= now,
        ).first()
        if not active:
            raise HTTPException(
                status_code=403,
                detail="No active reservation for this room. Control denied.",
            )

    device.is_active = payload.is_active
    device.control_enabled = payload.control_enabled
    try:
        db_sql.commit()
        db_sql.refresh(device)
    except SQLAlchemyError as exc:
        db_sql.rollback()
        logger.error("DB error on sensor control: %s", exc)
        raise HTTPException(status_code=503, detail="Database unavailable") from exc

    logger.info(
        "Sensor '%s' updated by '%s' (role=%s): is_active=%s control_enabled=%s",
        sensor_id, current_user.username, current_user.role,
        device.is_active, device.control_enabled,
    )
    return {
        "sensor_id": device.id,
        "room_id": device.room_id,
        "is_active": device.is_active,
        "control_enabled": device.control_enabled,
    }
