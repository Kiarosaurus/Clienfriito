"""
Reports — consumo del propio nodo + indicadores de funcionamiento (CS5055).

GET /reports/roi (ruta conservada; vista "Consumo del nodo"):
  - Lecturas de los últimos 7 días (opcional ?room_id=).
  - Potencia por lectura = rama actuador (INA219 `power_w`, medido; si falta,
    ventilador nominal × PWM) + electrónica nominal / η buck ("estimado").
    Con INA219_SCOPE=node el shunt mide el total.
  - kWh y costo por día / mes / año = potencia media ponderada por tiempo × 24 h
    (el nodo queda energizado todo el día); con varias aulas, promedio por nodo.
    Tarifa y moneda configurables (app.config).
  - ?origin=all|node|simulado|desconocido filtra por procedencia declarada.
  - Comparación permitida: energía heurística vs ML en sombra (misma ventana).
  - Sin baseline de aire acondicionado: la spec lo prohíbe (docs/hardware-spec.md).
  - Siempre incluye una "cota máxima" (ventilador al 100 % las 24 h) calculada
    con los parámetros nominales, para el caso sin lecturas.

GET /reports/node-metrics?room_id=&hours=24&origin=all:
  - Indicadores derivados: disponibilidad (huecos > 3× periodo nominal entre
    lecturas consecutivas, informe OE2; + caídas LWT persistidas), % lecturas válidas,
    latencia p50/p95 vs 3 s, % en banda de confort, coincidencia heurística/ML,
    error de ocupación CO2 vs cámara, alarmas CO, ciclos del ventilador, energía.

Access: /roi admin; /node-metrics cualquier usuario autenticado.
"""
import logging
from datetime import datetime, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from motor.motor_asyncio import AsyncIOMotorDatabase
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool

from app.core.timeutils import to_local
from app.database import get_db
from app.database_sql import get_db_sql
from app.dependencies import get_current_user
from app.models.admin import Room, SensorDevice, User
from app.services.node_metrics import (
    compute_node_energy, compute_node_metrics, filter_by_origin, origin_counts,
)

logger = logging.getLogger(__name__)
router = APIRouter()

ROI_WINDOW_DAYS = 7
_PROJECTION = {"_id": 0}


async def _sensor_ids_for_room(db_sql: Session, room_id: Optional[str]) -> Optional[list[str]]:
    """None → todas las aulas; [] → aula sin nodos."""
    if room_id is None:
        return None
    return await run_in_threadpool(
        lambda: [d.id for d in db_sql.query(SensorDevice).filter(SensorDevice.room_id == room_id).all()]
    )


async def _configured_targets(db_sql: Session, sensor_ids: Optional[list[str]]) -> dict[str, float]:
    """{sensor_id: objetivo configurado del aula} — referencia de la banda de confort."""
    def _load() -> dict[str, float]:
        q = db_sql.query(SensorDevice)
        if sensor_ids is not None:
            q = q.filter(SensorDevice.id.in_(sensor_ids))
        devices = q.all()
        room_ids = list({d.room_id for d in devices if d.room_id})
        if not room_ids:
            return {}
        rooms = {r.id: r.target_temp for r in db_sql.query(Room).filter(Room.id.in_(room_ids)).all()}
        return {d.id: rooms[d.room_id] for d in devices if d.room_id in rooms}
    try:
        return await run_in_threadpool(_load)
    except Exception as exc:  # SQL caído → sin banda (el KPI queda "sin dato")
        logger.warning("No se pudieron cargar objetivos configurados: %s", exc)
        return {}


OriginParam = Query("all", pattern="^(all|node|simulado|desconocido)$",
                    description="Procedencia: all | node (marca explícita) | simulado | desconocido")


async def _fetch_window(db, sensor_ids: Optional[list[str]], since: datetime, until: datetime,
                        limit: int = 50_000) -> list[dict]:
    mongo_filter: dict = {
        "timestamp": {
            "$gte": since.strftime("%Y-%m-%dT%H:%M:%S.%f"),
            "$lte": until.strftime("%Y-%m-%dT%H:%M:%S.%f"),
        }
    }
    if sensor_ids is not None:
        mongo_filter["sensor_id"] = {"$in": sensor_ids}
    cursor = db["sensor_readings"].find(mongo_filter, _PROJECTION).sort("timestamp", 1)
    return await cursor.to_list(length=limit)


# ── Consumo del nodo ──────────────────────────────────────────────────────────

@router.get("/roi")
async def get_roi(
    room_id: Optional[str] = None,
    origin: str = OriginParam,
    db: AsyncIOMotorDatabase = Depends(get_db),
    db_sql: Session = Depends(get_db_sql),
    current_user: User = Depends(get_current_user),
):
    if current_user.role != "admin":
        raise HTTPException(status_code=403, detail="Admin role required.")

    # Upper bound matters: the seeded dataset may extend past today.
    now_utc = datetime.utcnow()
    since = now_utc - timedelta(days=ROI_WINDOW_DAYS)
    sensor_ids = await _sensor_ids_for_room(db_sql, room_id)
    all_docs = [] if sensor_ids == [] else await _fetch_window(db, sensor_ids, since, now_utc)
    docs = filter_by_origin(all_docs, origin)

    result = compute_node_energy(
        docs, ROI_WINDOW_DAYS, day_key=lambda t: to_local(t).date().isoformat()
    )
    result["room_id"] = room_id
    result["origin_filter"] = origin
    result["origin_counts_all"] = origin_counts(all_docs)
    # Sin lecturas → solo la cota máxima nominal; el frontend muestra el aviso.
    result["simulated"] = result["total_readings"] == 0
    logger.info(
        "Node consumption: room=%s readings=%d source=%s",
        room_id, result["total_readings"], result["power_source"],
    )
    return result


# ── Indicadores de funcionamiento ─────────────────────────────────────────────

async def _rooms_for_sensors(db_sql: Session, sensor_ids: list[str]) -> list[str]:
    def _load() -> list[str]:
        q = db_sql.query(SensorDevice).filter(SensorDevice.id.in_(sensor_ids))
        return sorted({d.room_id for d in q.all() if d.room_id})
    try:
        return await run_in_threadpool(_load)
    except Exception as exc:
        logger.warning("No se pudo resolver el aula de los nodos: %s", exc)
        return []


async def _fetch_status_events(db, room_ids: Optional[list[str]], since: datetime,
                               until: datetime) -> list[dict]:
    """Transiciones LWT persistidas por el puente MQTT (colección node_status_events).

    Sin puente o sin colección → []: la disponibilidad queda solo por huecos.
    """
    flt: dict = {"ts": {"$gte": since.strftime("%Y-%m-%dT%H:%M:%S.%f"),
                        "$lte": until.strftime("%Y-%m-%dT%H:%M:%S.%f")}}
    if room_ids is not None:
        if not room_ids:
            return []
        flt["room_id"] = {"$in": room_ids}
    try:
        cursor = db["node_status_events"].find(flt, _PROJECTION).sort("ts", 1)
        return await cursor.to_list(length=5_000)
    except Exception as exc:  # colección inexistente / Mongo caído → sin LWT
        logger.warning("No se pudieron leer eventos LWT: %s", exc)
        return []


@router.get("/node-metrics")
async def get_node_metrics(
    room_id: Optional[str] = None,
    sensor_id: Optional[str] = None,
    hours: int = Query(24, ge=1, le=24 * 30),
    origin: str = OriginParam,
    db: AsyncIOMotorDatabase = Depends(get_db),
    db_sql: Session = Depends(get_db_sql),
    current_user: User = Depends(get_current_user),
):
    now_utc = datetime.utcnow()
    since = now_utc - timedelta(hours=hours)
    if sensor_id is not None:
        sensor_ids: Optional[list[str]] = [sensor_id]
    else:
        sensor_ids = await _sensor_ids_for_room(db_sql, room_id)
    all_docs = [] if sensor_ids == [] else await _fetch_window(db, sensor_ids, since, now_utc, limit=20_000)
    docs = filter_by_origin(all_docs, origin)
    targets = await _configured_targets(db_sql, sensor_ids)
    if room_id is not None:
        room_ids: Optional[list[str]] = [room_id]
    elif sensor_ids is not None:
        room_ids = await _rooms_for_sensors(db_sql, sensor_ids)
    else:
        room_ids = None
    events = await _fetch_status_events(db, room_ids, since, now_utc)
    metrics = compute_node_metrics(docs, window_hours=hours, configured_targets=targets,
                                   status_events=events, window_end=now_utc)
    metrics["room_id"] = room_id
    metrics["origin_filter"] = origin
    metrics["origin_counts_all"] = origin_counts(all_docs)
    metrics["sensor_ids"] = sensor_ids
    return metrics
