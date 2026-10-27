"""
Predictive service — dual-mode thermal load engine.

Occupancy model (feed-forward + feedback):
  - expected_occupancy → PLANNED headcount from Schedule/Reservation. Feed-forward
    signal: drives anticipatory pre-cooling, the only value known before arrival.
  - actual_occupancy   → REALIZED headcount inferred from CO2 (occupancy_service).
    Feedback signal: trims the demand once the room actually fills (or doesn't).
  The engine blends both into an effective_occupancy via FEEDBACK_WEIGHT.

Operates in two modes:
  - ML mode: loads a scikit-learn BUNDLE (model + feature contract + room_id map +
    metadata). Feature values are assembled by name from bundle["features"], so the
    row always matches the trained order. Available: temperature, hour_of_day,
    expected_occupancy, actual_occupancy, outdoor_temp (climate_service, Tier 2),
    floor/volume_m3/ac_btu (room_profile, Tier 3), plus room_code for legacy bundles.
    outdoor temp and room metadata need no hardware.
  - Heuristic mode (fallback): estimates thermal load as
    effective_occupancy × THERMAL_LOAD_PER_PERSON when no model.joblib is present.

The output drives the AC cognitive action: if the current temperature exceeds
the occupancy-adjusted target, the system emits ac_status=ON (PRE-COOLING);
otherwise it emits STANDBY, avoiding unnecessary energy consumption.
"""
import logging
from datetime import datetime
from pathlib import Path

import numpy as np

from app.core.timeutils import to_local
from app.services.occupancy_service import estimate_actual_occupancy, occupancy_gap
from app.services.climate_service import outdoor_temp as _outdoor_temp
from app.services.room_profile import get_metadata as _room_metadata

logger = logging.getLogger(__name__)

_MODEL_PATH = Path(__file__).resolve().parent.parent / "ml" / "model.joblib"
_model = None
# Feature ORDER contract + room_id→code map, populated from the trained bundle.
_features: list[str] = ["temperature", "hour_of_day", "expected_occupancy", "actual_occupancy"]
_room_map: dict = {}
_metadata: dict = {}

# Degrees Celsius of thermal load added per person present (heuristic bootstrap)
THERMAL_LOAD_PER_PERSON = 0.05

# Weight of the FEEDBACK (CO2-measured actual) signal vs the FEED-FORWARD
# (reservation-planned expected) signal when both are available. 0 → trust the
# plan only; 1 → trust the live sensor only. 0.6 leans on measured reality while
# retaining anticipation for the ramp-up at the start of an occupancy window.
FEEDBACK_WEIGHT = 0.6


def load_model() -> None:
    """Load the trained scikit-learn model from disk at application startup.

    If the model file does not exist, the service degrades gracefully to the
    heuristic fallback. No exception is raised so the rest of the API stays live.
    Train with: ml_pipeline/extract_data.py → ml_pipeline/train_model.py
    """
    global _model, _features, _room_map, _metadata
    try:
        import joblib
        if not _MODEL_PATH.exists():
            logger.warning(
                "model.joblib not found at %s — heuristic fallback active. "
                "Run ml_pipeline/extract_data.py then ml_pipeline/train_model.py.",
                _MODEL_PATH,
            )
            return

        loaded = joblib.load(_MODEL_PATH)
        if isinstance(loaded, dict) and "model" in loaded:
            # Serve-side gate (D4): a bundle that failed to beat its own baselines
            # is never served — the transparent heuristic is better-justified.
            metrics = (loaded.get("metadata") or {}).get("metrics") or {}
            if metrics.get("beats_baselines") is False:
                logger.warning(
                    "ML bundle at %s lost to its baselines (beats_baselines=false) — "
                    "refusing to serve it; heuristic fallback active. Retrain with "
                    "better features before shipping.",
                    _MODEL_PATH,
                )
                return
            # New bundle format: model + feature contract + room map + metadata.
            _model = loaded["model"]
            _features = loaded.get("features", _features)
            _room_map = loaded.get("room_id_map", {})
            _metadata = loaded.get("metadata", {})
            logger.info(
                "ML bundle loaded from %s (features=%s, rooms=%d, trained_at=%s)",
                _MODEL_PATH, _features, len(_room_map), _metadata.get("trained_at"),
            )
        else:
            # Legacy bare estimator — keep default feature order, no room map.
            _model = loaded
            logger.info("ML model (legacy bare estimator) loaded from %s", _MODEL_PATH)
    except Exception as exc:
        logger.error("Failed to load ML model: %s — heuristic fallback active.", exc)


def active_engine() -> str:
    """Return the engine currently driving cognitive actions.

    'ml' when a trained model is loaded in memory, otherwise 'heuristic'. This is
    global, startup-bound server state — independent of any single reading.
    """
    return "ml" if _model is not None else "heuristic"


def ml_loaded() -> bool:
    """True when a trained bundle is in memory (it may still run only in shadow)."""
    return _model is not None


def controller_mode() -> dict:
    """Describe who drives the actuator under the 'auto' policy (for /health and UI)."""
    from app.config import ML_SHADOW_MODE
    return {
        "active_controller": "heuristic" if (ML_SHADOW_MODE or _model is None) else "ml",
        "ml_shadow": bool(ML_SHADOW_MODE),
        "ml_loaded": _model is not None,
    }


# ── Fan command (heuristic → ccs/<room>/cmd.fan_pwm) ─────────────────────────
# Proportional law on the error above the adjusted target, with a floor so the
# DC fan actually spins (below ~40 % many 12 V fans stall). [CONFIRMAR con firmware]
FAN_MIN_PWM = 40.0
FAN_GAIN_PWM_PER_C = 40.0


def _decide(current_temp: float, target_temp: float, thermal_load: float,
            expected_people: float, actual_people: float | None, engine_label: str) -> dict:
    """Turn a thermal-load estimate into a decision state + fan command + reason."""
    adjusted = round(target_temp - thermal_load, 2)
    error = current_temp - adjusted
    if error > 0:
        # PRE-COOLING = a class is planned (feed-forward) but CO2 says the room is
        # still empty: anticipatory ventilation. Otherwise the room is occupied/hot -> ON.
        pre = expected_people > 0 and actual_people is not None and actual_people < 1
        state = "PRE-COOLING" if pre else "ON"
        pwm = round(min(100.0, max(FAN_MIN_PWM, FAN_MIN_PWM + FAN_GAIN_PWM_PER_C * error)), 1)
        why = (
            f"{engine_label}: T {current_temp:.1f} °C > objetivo ajustado {adjusted:.1f} °C "
            f"(carga {thermal_load:.2f} °C)"
            + (" · reserva próxima con aula vacía" if pre else "")
        )
        return {"ac_status": "ON", "action": state, "target": adjusted, "fan_pwm": pwm, "reason": why}
    why = f"{engine_label}: T {current_temp:.1f} °C ≤ objetivo ajustado {adjusted:.1f} °C"
    return {"ac_status": "STANDBY", "action": "STANDBY", "target": adjusted, "fan_pwm": 0.0, "reason": why}


async def calculate_cooling_demand(
    current_temp: float,
    room_context: dict,
    reading_timestamp: datetime,
    co2_ppm: float | None = None,
) -> dict:
    """Compute the cognitive action for an incoming sensor reading.

    Args:
        current_temp: Measured temperature in °C from the sensor.
        room_context: Dict with room metadata (target_temp, expected_people,
                      max_capacity, etc.) or None/empty when the sensor has no
                      registered room or control is disabled.
        reading_timestamp: UTC datetime of the reading; used to extract hour_of_day
                           as a feature for the ML model.
        co2_ppm: Measured CO2 in ppm, used to infer actual (realized) occupancy for
                 the feedback correction. None → feed-forward on expected only.

    Returns:
        Dict with keys: ac_status ('ON' | 'STANDBY', legacy alias), cooling_mode,
        target, thermal_load_offset, model ('ml' | 'heuristic' | 'manual' | 'none'),
        the occupancy telemetry (expected/actual/effective_occupancy, occupancy_gap)
        and — CS5055, additive — action (ON | PRE-COOLING | STANDBY), fan_pwm,
        active_controller, heuristic_action/_reason/_target/_fan_pwm and the ML
        shadow counterparts ml_action/_reason/_target/_fan_pwm (None when no model).
    """
    from app.config import ML_SHADOW_MODE

    raw_expected = (room_context or {}).get("expected_people")
    expected_people = raw_expected or 0
    target_temp = (room_context or {}).get("target_temp")
    policy = (room_context or {}).get("control_policy") or "auto"
    max_capacity = (room_context or {}).get("max_capacity")

    if not room_context or target_temp is None:
        return {
            "ac_status": "STANDBY", "cooling_mode": None, "target": target_temp, "model": "none",
            "action": "STANDBY", "active_controller": "none",
            "heuristic_reason": "Sin aula/objetivo registrado: sin decisión cognitiva",
        }

    # Feedback signal: infer realized occupancy from CO2 (None when no CO2 channel).
    actual_people = estimate_actual_occupancy(co2_ppm, max_capacity)

    # Effective occupancy = feed-forward (plan) blended with feedback (measured).
    # No CO2 signal → pure feed-forward on the reservation/schedule expectation.
    if actual_people is None:
        effective_people = float(expected_people)
    else:
        effective_people = (
            (1 - FEEDBACK_WEIGHT) * expected_people + FEEDBACK_WEIGHT * actual_people
        )

    # Time features were trained on naive LOCAL timestamps (the seed data writes
    # Lima wall-clock times), while the API stamps live readings with naive UTC.
    # Shift before deriving hour_of_day / outdoor_temp (see app.core.timeutils) —
    # otherwise both features carry a 5 h phase error.
    ts = to_local(reading_timestamp)
    hour = ts.hour

    # Heuristic estimate — always computed (it is the ACTIVE controller per spec).
    heuristic_load = round(effective_people * THERMAL_LOAD_PER_PERSON, 3)

    # ML estimate — computed whenever a bundle is loaded (shadow or active).
    ml_load: float | None = None
    if _model is not None:
        # actual_people may be None (no CO2) — fall back to expected for that slot
        actual_feature = actual_people if actual_people is not None else expected_people
        # Physical room metadata (Tier 3) — floor, volume_m3, ac_btu.
        meta = _room_metadata(room_context.get("room_id"))
        # Build the row in the exact order the bundle was trained on (_features).
        feat_values = {
            "temperature": current_temp,
            "hour_of_day": hour,
            # Missing plan is NaN (HGBR-native missing), matching training's
            # convention — 0 would mean "a plan for zero people", a different thing.
            "expected_occupancy": float("nan") if raw_expected is None else expected_people,
            "actual_occupancy": actual_feature,
            "room_code": _room_map.get(str(room_context.get("room_id")), -1),  # legacy bundles
            "outdoor_temp": _outdoor_temp(ts),   # exogenous climate driver (Tier 2)
            "floor": meta["floor"],
            "volume_m3": meta["volume_m3"],
            "ac_btu": meta["ac_btu"],
        }
        try:
            row = [float(feat_values[f]) for f in _features]
        except KeyError as exc:
            logger.error("Unknown model feature %s — ML shadow unavailable for this reading.", exc)
        else:
            try:
                features = np.array([row], dtype=float)
                ml_load = round(float(max(0.0, _model.predict(features)[0])), 3)
            except Exception as exc:  # a broken bundle must never stop the heuristic
                logger.error("ML predict failed (%s) — ML shadow unavailable for this reading.", exc)

    # Per-room policy decides the ACTIVE engine:
    #   manual    → no prediction, hold the configured target (zero offset)
    #   heuristic → heuristic formula
    #   auto      → heuristic (ML in shadow) when ML_SHADOW_MODE, else ML when loaded
    if policy == "manual":
        thermal_load = 0.0
        model_used = "manual"
    elif policy == "heuristic" or ml_load is None or ML_SHADOW_MODE:
        thermal_load = heuristic_load
        model_used = "heuristic"
    else:
        thermal_load = ml_load
        model_used = "ml"

    occupancy_telemetry = {
        "expected_occupancy": expected_people,
        "actual_occupancy": actual_people,
        "effective_occupancy": round(effective_people, 2),
        "occupancy_gap": occupancy_gap(expected_people, actual_people),
    }

    heur = _decide(current_temp, target_temp, heuristic_load, expected_people, actual_people, "Heurística")
    ml = (_decide(current_temp, target_temp, ml_load, expected_people, actual_people, "ML (sombra)")
          if ml_load is not None else None)
    if model_used == "heuristic":
        active = heur
    elif model_used == "ml" and ml is not None:
        active = ml
    else:
        active = _decide(current_temp, target_temp, 0.0, expected_people, actual_people, "Manual")

    return {
        # Legacy contract (unchanged semantics).
        "ac_status": active["ac_status"],
        # DEPRECATED (legacy): "PRE-COOLING" para todo ON; usar `action`.
        "cooling_mode": "PRE-COOLING" if active["ac_status"] == "ON" else None,
        "target": active["target"],
        "thermal_load_offset": round(thermal_load, 3),
        "model": model_used,
        **occupancy_telemetry,
        # CS5055 additive fields.
        "action": active["action"],
        "fan_pwm": active["fan_pwm"],
        "active_controller": model_used,
        "heuristic_action": heur["action"],
        "heuristic_reason": heur["reason"],
        "heuristic_target": heur["target"],
        "heuristic_fan_pwm": heur["fan_pwm"],
        "ml_action": ml["action"] if ml else None,
        "ml_reason": ml["reason"] if ml else ("Modelo ML no cargado" if _model is None else "Predicción ML no disponible"),
        "ml_target": ml["target"] if ml else None,
        "ml_fan_pwm": ml["fan_pwm"] if ml else None,
    }
