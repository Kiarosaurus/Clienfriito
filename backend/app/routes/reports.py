"""Savings report: monthly energy and cost per room against the no-system reference.

Figures come from the month-long strategy simulation (see services/profitability).
Each room reports the strategy it runs today, so switching a room to learning
shows up here. Access: admin only.
"""
from fastapi import APIRouter, Depends, HTTPException
from motor.motor_asyncio import AsyncIOMotorDatabase

from app.database import get_db
from app.dependencies import get_current_user
from app.models.admin import User
from app.services import profitability as pf
from app.services.room_controller import get_controller

router = APIRouter()


@router.get("/roi")
async def get_roi(
    db: AsyncIOMotorDatabase = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    if current_user.role != "admin":
        raise HTTPException(status_code=403, detail="Admin role required.")

    metas = await db["strategy_simulation_meta"].find({}, {"timetable": 0}).to_list(length=None)
    rooms = []
    equipment = (metas[0].get("equipment") if metas else None) or {}
    for meta in sorted(metas, key=lambda m: m["_id"]):
        energy = await pf.room_energy(db, meta)
        energy["strategy"] = (await get_controller(db, meta["_id"]))["mode"]
        rooms.append(energy)

    return {
        "tariff": {"pen_per_kwh": pf.TARIFF_PEN_PER_KWH, "label": pf.TARIFF_LABEL},
        "reference": (f"Cada clase con el equipo a plena potencia: calefactor 2 kW si el aula "
                      f"empieza bajo {pf.COLD_START_C:g} °C, si no extractor 180 W.").replace(".", ",", 1),
        "month_days": pf.MONTH_DAYS,
        "cold_start_c": pf.COLD_START_C,
        "equipment": {
            "fan_w": equipment.get("fan_max_w"),
            "fan_m3h": round(equipment["fan_max_m3s"] * 3600) if equipment.get("fan_max_m3s") else None,
            "heater_w": equipment.get("heater_w"),
        },
        "step_s": sorted({m["step_s"] for m in metas}),
        "rooms": rooms,
        "simulated": True,
    }
