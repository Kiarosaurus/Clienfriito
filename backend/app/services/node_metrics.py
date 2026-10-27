"""Métricas derivadas del nodo ESP32 — "procesamiento previo" del dashboard (CS5055).

Funciones puras sobre una lista de documentos `sensor_readings` (orden cronológico
ascendente), sin acceso a BD, para poder probarlas con pytest. Las consumen:
  - GET /reports/node-metrics  → indicadores de funcionamiento por aula
  - GET /reports/roi           → consumo/costo del propio nodo (sin baseline AC)

Regla de honestidad: si un campo no viene en la telemetría, la métrica devuelve
None (el frontend muestra "sin dato") o se marca su fuente como "estimado".

Potencia del nodo (informe §hardware): el shunt del INA219 va provisionalmente en
la RAMA DEL ACTUADOR (ventilador/PTC). Por eso, con INA219_SCOPE="actuator":
    total = rama actuador (power_w, medido) + electrónica (nominal / η buck, estimado)
y sin INA219 todo es nominal ("estimado"). Con INA219_SCOPE="node" (shunt en la
entrada de 12 V) power_w ya es el total medido.
"""
from __future__ import annotations

import math
from collections import Counter, defaultdict
from datetime import datetime
from statistics import median
from typing import Any, Callable, Iterable, Optional

import app.config as cfg
from app.config import (
    COMFORT_BAND_C,
    ENERGY_COST_PER_KWH,
    ENERGY_CURRENCY,
    ENERGY_TARIFF_CONFIRMED,
    ENERGY_TARIFF_LABEL,
    FAN_MAX_POWER_W,
    FAN_MIN_ON_S,
    HEATER_POWER_W,
    LATENCY_TARGET_MS,
    NODE_IDLE_POWER_W,
)

CO_ALARM_PPM = 50.0          # umbral EPA / spec (alarma local)
DEFAULT_INTERVAL_S = 600.0   # cadencia supuesta cuando hay una sola lectura

# Etiquetas de fuente de potencia (las lee el frontend tal cual).
SRC_MEASURED = "medido"                      # shunt en la entrada: total medido
SRC_MEASURED_PLUS_EST = "medido + estimado"  # rama actuador medida + lógica nominal
SRC_MIXED = "mixto"                          # solo parte de las lecturas trae INA219
SRC_ESTIMATED = "estimado"                   # todo nominal
SRC_NONE = "sin dato"

ORIGINS = ("node", "simulado", "desconocido")


# ── Helpers ───────────────────────────────────────────────────────────────────

def parse_ts(ts: Any) -> Optional[datetime]:
    """ISO string (naive UTC en Mongo) → datetime naive; None si es inválido."""
    if isinstance(ts, datetime):
        return ts.replace(tzinfo=None)
    if not isinstance(ts, str) or not ts:
        return None
    try:
        dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
    except ValueError:
        return None
    return dt.replace(tzinfo=None) if dt.tzinfo else dt


def _num(v: Any) -> Optional[float]:
    if isinstance(v, bool) or v is None:
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return None if math.isnan(f) or math.isinf(f) else f


def percentile(values: list[float], p: float) -> Optional[float]:
    """Percentil con interpolación lineal (p en 0..100). None si no hay datos."""
    if not values:
        return None
    s = sorted(values)
    if len(s) == 1:
        return s[0]
    k = (len(s) - 1) * p / 100.0
    lo, hi = math.floor(k), math.ceil(k)
    return s[lo] + (s[hi] - s[lo]) * (k - lo)


def _round(v: Optional[float], nd: int = 2) -> Optional[float]:
    return None if v is None else round(v, nd)


def reading_origin(doc: dict) -> str:
    """Procedencia declarada: 'node' solo con marca explícita data_origin='node'.

    Sin marca no se asume hardware real: 'desconocido' (lecturas viejas, POST
    manuales, gateway serial previo). Seed y simulador → 'simulado'.
    """
    if doc.get("is_simulated") is True or doc.get("data_origin") in ("seed", "simulator"):
        return "simulado"
    if doc.get("data_origin") == "node":
        return "node"
    return "desconocido"


def filter_by_origin(docs: Iterable[dict], origin: str) -> list[dict]:
    """origin: 'all' | 'node' | 'simulado' | 'desconocido'."""
    docs = list(docs)
    if origin in (None, "", "all"):
        return docs
    return [d for d in docs if reading_origin(d) == origin]


def origin_counts(docs: Iterable[dict]) -> dict:
    c = Counter(reading_origin(d) for d in docs)
    return {k: c.get(k, 0) for k in ORIGINS}


def decision_state(doc: dict) -> Optional[str]:
    """Estado de decisión: action nuevo → si no, deriva de ac_status (alias)."""
    ca = doc.get("cognitive_action") or {}
    if ca.get("action"):
        return str(ca["action"])
    status = ca.get("ac_status")
    return str(status) if status else None


def fan_duty(doc: dict) -> tuple[Optional[float], str]:
    """Ciclo PWM 0..1 y su fuente ('reportado' | 'comandado' | 'inferido' | 'sin dato').

    'reportado' = ciclo aplicado que informa el nodo (no hay tacómetro: no es una
    medición de giro).
    """
    pwm = _num(doc.get("fan_pwm"))
    if pwm is not None:
        return max(0.0, min(100.0, pwm)) / 100.0, "reportado"
    ca = doc.get("cognitive_action") or {}
    cmd = _num(ca.get("fan_pwm"))
    if cmd is not None:
        return max(0.0, min(100.0, cmd)) / 100.0, "comandado"
    state = decision_state(doc)
    if state in ("ON", "PRE-COOLING"):
        return 1.0, "inferido"          # cota superior: sin PWM conocido → 100 %
    if state in ("STANDBY", "DISABLED"):
        return 0.0, "inferido"
    return None, "sin dato"


def logic_power_w() -> float:
    """Electrónica (ESP32 + calentadores MQ + DHT11) vista desde 12 V. Nominal."""
    eff = cfg.BUCK_EFFICIENCY if cfg.BUCK_EFFICIENCY and cfg.BUCK_EFFICIENCY > 0 else 1.0
    return NODE_IDLE_POWER_W / eff


def node_power_breakdown(doc: dict) -> dict:
    """Potencia de una lectura por componente.

    Devuelve total_w, actuator_w, logic_w y banderas de medición. Con el shunt en
    la entrada (INA219_SCOPE='node') el total es medido y no hay desglose.
    """
    p = _num(doc.get("power_w"))
    if p is not None and cfg.INA219_SCOPE == "node":
        return {"total_w": p, "actuator_w": None, "logic_w": None,
                "actuator_measured": True, "total_measured": True}
    logic = logic_power_w()
    if p is not None:
        actuator, measured = p, True
    else:
        duty, _ = fan_duty(doc)
        actuator = FAN_MAX_POWER_W * (duty or 0.0)
        if doc.get("heater_on") is True:
            actuator += HEATER_POWER_W
        measured = False
    return {"total_w": actuator + logic, "actuator_w": actuator, "logic_w": logic,
            "actuator_measured": measured, "total_measured": False}


def node_power_w(doc: dict) -> tuple[float, bool]:
    """Compatibilidad: (potencia total W, ¿total medido?)."""
    b = node_power_breakdown(doc)
    return b["total_w"], b["total_measured"]


def power_model() -> dict:
    """Parámetros nominales del modelo de potencia (fuente única; /health los expone)."""
    return {
        "node_idle_power_w": NODE_IDLE_POWER_W,
        "buck_efficiency": cfg.BUCK_EFFICIENCY,
        "logic_power_w": round(logic_power_w(), 3),
        "fan_max_power_w": FAN_MAX_POWER_W,
        "heater_power_w": HEATER_POWER_W,
        "ina219_scope": cfg.INA219_SCOPE,
    }


def reading_power(doc: dict) -> dict:
    """Desglose de potencia de UNA lectura para el frontend (misma regla que /roi).

    total_w = rama actuador + electrónica (o total medido si INA219_SCOPE='node').
    `actuator_basis` indica de dónde sale la rama: 'medido' (INA219) o, sin INA219,
    el ciclo PWM 'reportado' / 'comandado' / 'inferido' (decisión ON sin PWM →
    cota 100 %) / 'sin dato' (se toma 0 W).
    """
    b = node_power_breakdown(doc)
    if b["total_measured"]:
        basis, source = "medido", SRC_MEASURED
    elif b["actuator_measured"]:
        basis, source = "medido", SRC_MEASURED_PLUS_EST
    else:
        basis, source = fan_duty(doc)[1], SRC_ESTIMATED
    return {
        "total_w": _round(b["total_w"], 3),
        "actuator_w": _round(b["actuator_w"], 3),
        "logic_w": _round(b["logic_w"], 3),
        "actuator_measured": b["actuator_measured"],
        "total_measured": b["total_measured"],
        "actuator_basis": basis,
        "source": source,
        "ina219_scope": cfg.INA219_SCOPE,
        "current_ma": _num(doc.get("current_ma")),
        "bus_voltage_v": _num(doc.get("bus_voltage_v")),
    }


def power_source(breakdowns: list[dict]) -> str:
    n = len(breakdowns)
    if n == 0:
        return SRC_NONE
    act = sum(1 for b in breakdowns if b["actuator_measured"])
    if act == 0:
        return SRC_ESTIMATED
    if act < n:
        return SRC_MIXED
    return SRC_MEASURED if all(b["total_measured"] for b in breakdowns) else SRC_MEASURED_PLUS_EST


def _intervals_s(times: list[datetime]) -> list[float]:
    return [(b - a).total_seconds() for a, b in zip(times, times[1:])]


def _sample_dt(times: list[datetime]) -> list[float]:
    """Duración representada por cada muestra (intervalo hasta la siguiente, acotado)."""
    gaps = _intervals_s(times)
    nominal = median(gaps) if gaps else DEFAULT_INTERVAL_S
    cap = max(nominal * 3, 120.0)
    out = [min(g, cap) for g in gaps]
    out.append(nominal)  # la última muestra representa un intervalo nominal
    return out


def _by_sensor(rows: list[tuple[datetime, dict]]) -> dict[str, list[tuple[datetime, dict, float]]]:
    """Agrupa por nodo y asigna a cada muestra su duración (ponderación temporal)."""
    groups: dict[str, list[tuple[datetime, dict]]] = defaultdict(list)
    for t, d in rows:
        groups[str(d.get("sensor_id") or "?")].append((t, d))
    out: dict[str, list[tuple[datetime, dict, float]]] = {}
    for sid, items in groups.items():
        items.sort(key=lambda r: r[0])
        dts = _sample_dt([t for t, _ in items])
        out[sid] = [(t, d, dt) for (t, d), dt in zip(items, dts)]
    return out


def _wavg(items: list[tuple[float, float]]) -> Optional[float]:
    """Media ponderada [(valor, peso)]; None si no hay peso."""
    tot = sum(w for _, w in items)
    return sum(v * w for v, w in items) / tot if tot > 0 else None


def _mean(vals: list[float]) -> Optional[float]:
    return sum(vals) / len(vals) if vals else None


def _is_valid(doc: dict) -> bool:
    t, h = _num(doc.get("temperature")), _num(doc.get("humidity"))
    co2, co = _num(doc.get("co2_ppm")), _num(doc.get("co_ppm"))
    return (
        t is not None and -10 <= t <= 60
        and h is not None and 0 <= h <= 100
        and co2 is not None and co2 > 0
        and co is not None and co >= 0
    )


def _in_alarm(doc: dict) -> bool:
    if doc.get("alarm_active") is True:
        return True
    co = _num(doc.get("co_ppm"))
    return co is not None and co > CO_ALARM_PPM


# ── Disponibilidad del enlace (OE2) ───────────────────────────────────────────

def _nominal_period(gaps: list[float]) -> tuple[Optional[float], str]:
    """Periodo nominal: configurado (NODE_SAMPLE_PERIOD_S) o mediana de intervalos > 0."""
    if cfg.NODE_SAMPLE_PERIOD_S and cfg.NODE_SAMPLE_PERIOD_S > 0:
        return float(cfg.NODE_SAMPLE_PERIOD_S), "configurado"
    pos = [g for g in gaps if g > 0]
    return (median(pos), "mediana") if pos else (None, "sin dato")


def lwt_offline_events(status_events: Optional[Iterable[dict]]) -> int:
    """Transiciones a 'offline' del LWT por aula (no cuenta 'offline' repetidos)."""
    evs = []
    for e in status_events or []:
        t = parse_ts(e.get("ts"))
        if t is not None and isinstance(e.get("online"), bool):
            evs.append((t, str(e.get("room_id") or e.get("room") or "?"), e["online"]))
    evs.sort(key=lambda r: r[0])
    last: dict[str, bool] = {}
    drops = 0
    for _, room, online in evs:
        if not online and last.get(room) is not False:
            drops += 1
        last[room] = online
    return drops


def compute_availability(rows: list[tuple[datetime, dict]],
                         status_events: Optional[Iterable[dict]] = None,
                         window_end: Optional[datetime] = None) -> Optional[dict]:
    """Disponibilidad según el informe (OE2): pérdida de muestras = huecos mayores
    a GAP_FACTOR (3) × periodo nominal entre lecturas consecutivas de un nodo.

    Siempre se calcula desde las marcas de tiempo: `node_online` de las lecturas
    NO interviene (un nodo caído no publica, así que nunca aparecería un False).
    Las transiciones LWT persistidas se informan aparte (`lwt_offline_events`).
    """
    events = list(status_events or [])
    lwt_drops = lwt_offline_events(events)
    groups: dict[str, list[datetime]] = defaultdict(list)
    for t, d in rows:
        groups[str(d.get("sensor_id") or "?")].append(t)

    span_s = lost_s = 0.0
    received = lost_samples = drops = 0
    nominals: list[float] = []
    nominal_src = "sin dato"
    ongoing: Optional[float] = None
    for times in groups.values():
        times.sort()
        gaps = _intervals_s(times)
        nominal, src = _nominal_period(gaps)
        if nominal is None or nominal <= 0:
            continue
        nominal_src = src
        nominals.append(nominal)
        threshold = cfg.GAP_FACTOR * nominal
        long_gaps = [g for g in gaps if g > threshold]
        drops += len(long_gaps)
        lost_s += sum(g - nominal for g in long_gaps)
        lost_samples += sum(max(0, round(g / nominal) - 1) for g in long_gaps)
        received += len(times)
        span_s += (times[-1] - times[0]).total_seconds()
        if window_end is not None:
            tail = (window_end - times[-1]).total_seconds()
            if tail > threshold:
                ongoing = max(ongoing or 0.0, tail)

    if not nominals:
        if not events:
            return None
        return {"source": "LWT", "uptime_pct": None, "sample_loss_pct": None, "drops": 0,
                "lwt_offline_events": lwt_drops, "samples": 0, "lost_samples": 0, "lost_s": None,
                "gap_threshold_s": None, "gap_factor": cfg.GAP_FACTOR, "nominal_period_s": None,
                "nominal_source": "sin dato", "ongoing_gap_s": None, "nodes": 0}
    nominal_avg = sum(nominals) / len(nominals)
    span_s = span_s or nominal_avg
    return {
        "source": "huecos + LWT" if events else "huecos",
        "uptime_pct": _round(max(0.0, 100 * (1 - lost_s / span_s)), 1),
        "sample_loss_pct": (_round(100 * lost_samples / (received + lost_samples), 1)
                            if received + lost_samples else None),
        "drops": drops,
        "lwt_offline_events": lwt_drops,
        "samples": received,
        "lost_samples": lost_samples,
        "lost_s": round(lost_s),
        "gap_threshold_s": _round(cfg.GAP_FACTOR * nominal_avg, 1),
        "gap_factor": cfg.GAP_FACTOR,
        "nominal_period_s": _round(nominal_avg, 1),
        "nominal_source": nominal_src,
        "ongoing_gap_s": round(ongoing) if ongoing is not None else None,
        "nodes": len(nominals),
    }


# ── Indicadores de funcionamiento ─────────────────────────────────────────────

def compute_node_metrics(docs: Iterable[dict], window_hours: float,
                         configured_targets: Optional[dict[str, float]] = None,
                         status_events: Optional[Iterable[dict]] = None,
                         window_end: Optional[datetime] = None) -> dict:
    """Indicadores derivados para una ventana de lecturas (orden indiferente).

    `configured_targets`: {sensor_id: objetivo configurado del aula} para la banda
    de confort única. Sin él, el KPI de confort queda en None (no se inventa).
    `status_events`: transiciones LWT persistidas ({"online": bool, "ts": iso}) de
    la ventana; solo suman caídas, no reemplazan el cálculo por huecos.
    `window_end`: fin de la ventana, para informar una caída en curso.
    """
    rows = []
    discarded = 0
    for d in docs:
        ts = parse_ts(d.get("timestamp"))
        if ts is None:
            discarded += 1
            continue
        rows.append((ts, d))
    rows.sort(key=lambda r: r[0])
    n = len(rows)
    times = [r[0] for r in rows]
    data = [r[1] for r in rows]

    oc = origin_counts(data)
    base: dict[str, Any] = {
        "window_hours": window_hours,
        "samples": n,
        "discarded_invalid_timestamp": discarded,
        "first_ts": times[0].isoformat() if n else None,
        "last_ts": times[-1].isoformat() if n else None,
        "simulated_samples": oc["simulado"],
        "origin_counts": oc,
        "comfort_band_c": COMFORT_BAND_C,
    }
    if n == 0:
        return {**base, "availability": compute_availability([], status_events, window_end),
                "data_quality": None, "latency": None,
                "comfort": None, "agreement": None, "occupancy": None, "alarm": None,
                "fan": None, "energy": None, "decisions": {}}

    dts = _sample_dt(times)
    gaps = _intervals_s(times)
    nominal_s = median(gaps) if gaps else None

    # Disponibilidad (informe, OE2): SIEMPRE por huecos entre marcas de tiempo
    # consecutivas de cada nodo; el LWT persistido solo suma eventos de caída.
    availability = compute_availability(rows, status_events=status_events, window_end=window_end)

    valid = sum(1 for d in data if _is_valid(d))
    data_quality = {"valid_pct": _round(100 * valid / n, 1), "valid": valid, "total": n,
                    "median_interval_s": _round(nominal_s, 1)}

    lat = [v for v in (_num(d.get("latency_ms")) for d in data) if v is not None]
    latency = None
    if lat:
        latency = {"p50_ms": _round(percentile(lat, 50), 0), "p95_ms": _round(percentile(lat, 95), 0),
                   "max_ms": _round(max(lat), 0), "samples": len(lat), "target_ms": LATENCY_TARGET_MS,
                   "within_target_pct": _round(100 * sum(1 for v in lat if v < LATENCY_TARGET_MS) / len(lat), 1)}

    # Confort — definición ÚNICA: objetivo CONFIGURADO del aula ± COMFORT_BAND_C,
    # asimétrica (por debajo de la banda = aula fría, fuera de alcance del ventilador).
    over = inside = cold = 0
    for d in data:
        t = _num(d.get("temperature"))
        tgt = _num((configured_targets or {}).get(str(d.get("sensor_id"))))
        if t is None or tgt is None:
            continue
        if t > tgt + COMFORT_BAND_C:
            over += 1
        elif t < tgt - COMFORT_BAND_C:
            cold += 1
        else:
            inside += 1
    pool = over + inside + cold
    comfort = None
    if pool:
        comfort = {
            "controller_ok_pct": _round(100 * (inside + cold) / pool, 1),
            "in_band_pct": _round(100 * inside / pool, 1),
            "over_band_pct": _round(100 * over / pool, 1),
            "cold_pct": _round(100 * cold / pool, 1),
            "band_c": COMFORT_BAND_C,
            "band_ref": "objetivo configurado",
            "samples": pool,
        }

    pairs = []
    for ts, d in rows:
        ca = d.get("cognitive_action") or {}
        if ca.get("heuristic_action") and ca.get("ml_action"):
            pairs.append((ts, ca))
    agreement = None
    if pairs:
        div = [(ts, ca) for ts, ca in pairs if ca["heuristic_action"] != ca["ml_action"]]
        agreement = {
            "match_pct": _round(100 * (len(pairs) - len(div)) / len(pairs), 1),
            "samples": len(pairs),
            "divergences": len(div),
            "recent_divergences": [
                {"timestamp": ts.isoformat(), "heuristic_action": ca.get("heuristic_action"),
                 "ml_action": ca.get("ml_action"), "heuristic_reason": ca.get("heuristic_reason"),
                 "ml_reason": ca.get("ml_reason")}
                for ts, ca in div[-5:]
            ],
        }

    occ = []
    for d in data:
        cam = _num(d.get("camera_occupancy"))
        est = _num((d.get("cognitive_action") or {}).get("actual_occupancy"))
        if cam is not None and est is not None:
            occ.append(est - cam)
    occupancy = ({"mae_people": _round(sum(abs(e) for e in occ) / len(occ), 2),
                  "bias_people": _round(sum(occ) / len(occ), 2), "samples": len(occ)} if occ else None)

    alarm_flags = [_in_alarm(d) for d in data]
    events = sum(1 for i, a in enumerate(alarm_flags) if a and (i == 0 or not alarm_flags[i - 1]))
    alarm_s = sum(dt for dt, a in zip(dts, alarm_flags) if a)
    local = sum(1 for d in data if d.get("alarm_active") is True)
    alarm = {"events": events, "time_in_alarm_s": round(alarm_s), "local_samples": local,
             "server_only_samples": sum(alarm_flags) - local, "threshold_ppm": CO_ALARM_PPM}

    duties = [fan_duty(d) for d in data]
    known = [(t, du) for t, (du, _src) in zip(times, duties) if du is not None]
    cycles, ok_cycles, closed = 0, 0, 0
    on_since: Optional[datetime] = None
    for t, du in known:
        if du > 0 and on_since is None:
            on_since, cycles = t, cycles + 1
        elif du == 0 and on_since is not None:
            closed += 1
            if (t - on_since).total_seconds() >= FAN_MIN_ON_S:
                ok_cycles += 1
            on_since = None
    # Con muestreo más lento que la regla, todo ciclo dura ≥ 60 s de forma trivial:
    # el cumplimiento no es evaluable.
    evaluable = nominal_s is not None and nominal_s <= FAN_MIN_ON_S
    if not evaluable:
        min_on_pct = None
        min_on_reason = (f"no evaluable (muestreo {round(nominal_s)} s > {round(FAN_MIN_ON_S)} s)"
                         if nominal_s is not None else "no evaluable (una sola lectura)")
    elif not closed:
        min_on_pct, min_on_reason = None, "sin ciclos cerrados en la ventana"
    else:
        min_on_pct, min_on_reason = _round(100 * ok_cycles / closed, 1), None
    reported_pwm = [du for du, src in duties if src == "reportado"]
    fan = {
        "cycles": cycles,
        "closed_cycles": closed,
        "min_on_compliance_pct": min_on_pct,
        "min_on_evaluable": evaluable,
        "min_on_reason": min_on_reason,
        "min_on_s": FAN_MIN_ON_S,
        "avg_pwm_pct": _round(100 * sum(du for _, du in known) / len(known), 1) if known else None,
        "pwm_source": "reportado" if reported_pwm and len(reported_pwm) == len(known) else
                      ("mixto" if reported_pwm else ("estimado" if known else "sin dato")),
    }

    # Energía — ponderada por tiempo y por nodo (no promedio por lectura).
    groups = _by_sensor(rows)
    per_node_avg, per_node_act, per_node_logic, energy_wh = [], [], [], 0.0
    all_bd = []
    for items in groups.values():
        bds = [(node_power_breakdown(d), dt) for _, d, dt in items]
        all_bd.extend(b for b, _ in bds)
        avg = _wavg([(b["total_w"], dt) for b, dt in bds])
        if avg is not None:
            per_node_avg.append(avg)
        act = _wavg([(b["actuator_w"], dt) for b, dt in bds if b["actuator_w"] is not None])
        if act is not None:
            per_node_act.append(act)
        lg = _wavg([(b["logic_w"], dt) for b, dt in bds if b["logic_w"] is not None])
        if lg is not None:
            per_node_logic.append(lg)
        energy_wh += sum(b["total_w"] * dt / 3600 for b, dt in bds)
    act_measured = sum(1 for b in all_bd if b["actuator_measured"])
    energy = {
        "avg_power_w": _round(_mean(per_node_avg), 3),
        "energy_wh": _round(energy_wh, 3),
        "measured_samples": act_measured,
        "source": power_source(all_bd),
        "nodes": len(groups),
        "weighting": "tiempo",
        "breakdown": {
            "actuator_avg_w": _round(_mean(per_node_act), 3),
            "actuator_source": ("medido (INA219)" if act_measured == n else
                                ("mixto" if act_measured else "estimado")),
            "logic_avg_w": _round(_mean(per_node_logic), 3),
            "logic_source": "estimado (nominal)",
            "ina219_scope": cfg.INA219_SCOPE,
        },
    }

    decisions = dict(Counter(s for s in (decision_state(d) for d in data) if s))

    rssi = [v for v in (_num(d.get("rssi_dbm")) for d in data) if v is not None]

    return {
        **base,
        "availability": availability,
        "data_quality": data_quality,
        "latency": latency,
        "comfort": comfort,
        "agreement": agreement,
        "occupancy": occupancy,
        "alarm": alarm,
        "fan": fan,
        "energy": energy,
        "decisions": decisions,
        "rssi_avg_dbm": _round(sum(rssi) / len(rssi), 1) if rssi else None,
    }


# ── Consumo / costo del propio nodo ───────────────────────────────────────────

def _shadow_power(doc: dict, which: str) -> Optional[float]:
    """Potencia estimada si mandara la heurística ('heuristic') o el ML ('ml')."""
    ca = doc.get("cognitive_action") or {}
    pwm = _num(ca.get(f"{which}_fan_pwm"))
    if pwm is None:
        return None
    return logic_power_w() + FAN_MAX_POWER_W * max(0.0, min(100.0, pwm)) / 100.0


def compute_node_energy(docs: Iterable[dict], days: int, day_key: Callable[[datetime], str]) -> dict:
    """Consumo del nodo: potencia media → kWh y costo por día/mes/año.

    El nodo está alimentado 24 h, así que la proyección diaria es
    potencia_media × 24 h. La media se pondera por TIEMPO dentro de cada nodo y,
    si la ventana incluye varios nodos, se informa el PROMEDIO POR NODO.
    `day_key(datetime) → 'YYYY-MM-DD'` agrupa por fecha local.
    """
    rows = [(parse_ts(d.get("timestamp")), d) for d in docs]
    rows = sorted([(t, d) for t, d in rows if t is not None], key=lambda r: r[0])
    n = len(rows)

    logic_w = logic_power_w()
    upper_w = logic_w + FAN_MAX_POWER_W + HEATER_POWER_W
    assumptions = {
        "node_idle_power_w": NODE_IDLE_POWER_W,
        "buck_efficiency": cfg.BUCK_EFFICIENCY,
        "logic_power_w": round(logic_w, 3),
        "fan_max_power_w": FAN_MAX_POWER_W,
        "heater_power_w": HEATER_POWER_W,
        "ina219_scope": cfg.INA219_SCOPE,
        "cost_per_kwh": ENERGY_COST_PER_KWH,
        "currency": ENERGY_CURRENCY,
        "tariff_confirmed": ENERGY_TARIFF_CONFIRMED,
        "tariff_label": ENERGY_TARIFF_LABEL,
        "method": ("potencia media del nodo ponderada por tiempo × 24 h "
                   "(el nodo permanece energizado todo el día)"),
    }

    def _cost_block(avg_w: Optional[float]) -> Optional[dict]:
        if avg_w is None:
            return None
        kwh_day = avg_w * 24 / 1000
        return {
            "avg_power_w": round(avg_w, 3),
            "kwh_day": round(kwh_day, 4), "kwh_month": round(kwh_day * 30, 3), "kwh_year": round(kwh_day * 365, 2),
            "cost_day": round(kwh_day * ENERGY_COST_PER_KWH, 4),
            "cost_month": round(kwh_day * 30 * ENERGY_COST_PER_KWH, 3),
            "cost_year": round(kwh_day * 365 * ENERGY_COST_PER_KWH, 2),
        }

    result: dict[str, Any] = {
        "window_days": days,
        "total_readings": n,
        "measured_readings": 0,
        "power_source": SRC_NONE,
        "node": None,
        "breakdown": None,
        "upper_bound": {**_cost_block(upper_w), "label": "cota máxima: ventilador al 100 % las 24 h"},
        "heuristic_vs_ml": None,
        "trend_data": [],
        "assumptions": assumptions,
        "simulated_readings": 0,
        "origin_counts": {k: 0 for k in ORIGINS},
        "nodes": 0,
        "simulated_nodes": 0,
        "per_node": [],
    }
    if n == 0:
        return result

    data = [d for _, d in rows]
    oc = origin_counts(data)
    result["origin_counts"] = oc
    result["simulated_readings"] = oc["simulado"]

    groups = _by_sensor(rows)
    all_bd: list[dict] = []
    node_avgs, act_avgs, logic_avgs = [], [], []
    h_avgs, m_avgs, pair_samples = [], [], 0
    for sid, items in groups.items():
        bds = [(node_power_breakdown(d), dt) for _, d, dt in items]
        all_bd.extend(b for b, _ in bds)
        avg = _wavg([(b["total_w"], dt) for b, dt in bds])
        node_avgs.append(avg)
        act = _wavg([(b["actuator_w"], dt) for b, dt in bds if b["actuator_w"] is not None])
        if act is not None:
            act_avgs.append(act)
        lg = _wavg([(b["logic_w"], dt) for b, dt in bds if b["logic_w"] is not None])
        if lg is not None:
            logic_avgs.append(lg)
        pairs = [(_shadow_power(d, "heuristic"), _shadow_power(d, "ml"), dt) for _, d, dt in items]
        pairs = [(h, m, dt) for h, m, dt in pairs if h is not None and m is not None]
        if pairs:
            h_avgs.append(_wavg([(h, dt) for h, _, dt in pairs]))
            m_avgs.append(_wavg([(m, dt) for _, m, dt in pairs]))
            pair_samples += len(pairs)
        node_oc = origin_counts([d for _, d, _ in items])
        result["per_node"].append({
            "sensor_id": sid,
            "readings": len(items),
            "avg_power_w": _round(avg, 3),
            "origin": max(node_oc, key=lambda k: node_oc[k]),
            "power_source": power_source([b for b, _ in bds]),
        })

    measured = sum(1 for b in all_bd if b["actuator_measured"])
    result["measured_readings"] = measured
    result["power_source"] = power_source(all_bd)
    result["nodes"] = len(groups)
    result["simulated_nodes"] = sum(1 for p in result["per_node"] if p["origin"] == "simulado")
    result["node"] = _cost_block(_mean([a for a in node_avgs if a is not None]))
    if cfg.INA219_SCOPE != "node" or measured < n:
        result["breakdown"] = {
            "actuator_avg_w": _round(_mean(act_avgs), 3),
            "actuator_source": ("medido (INA219, rama actuador)" if measured == n else
                                ("mixto" if measured else "estimado (nominal × PWM)")),
            "logic_avg_w": _round(_mean(logic_avgs), 3),
            "logic_source": "estimado (nominal / η buck)",
        }
    span_h = (rows[-1][0] - rows[0][0]).total_seconds() / 3600
    result["total_hours_analyzed"] = round(span_h, 2)

    if h_avgs:
        h_avg, m_avg = _mean(h_avgs), _mean(m_avgs)
        result["heuristic_vs_ml"] = {
            "samples": pair_samples,
            "heuristic_kwh_day": round(h_avg * 24 / 1000, 4),
            "ml_shadow_kwh_day": round(m_avg * 24 / 1000, 4),
            "source": "estimado (PWM comandado × potencia nominal del ventilador + lógica nominal)",
        }

    # Tendencia diaria: por día y por nodo, media ponderada; luego promedio por nodo.
    by_day: dict[str, dict[str, list]] = defaultdict(lambda: defaultdict(list))
    for sid, items in groups.items():
        for t, d, dt in items:
            by_day[day_key(t)][sid].append((d, dt))
    for day in sorted(by_day):
        node_vals, h_vals, m_vals, count, meas = [], [], [], 0, 0
        for sid, items in by_day[day].items():
            bds = [(node_power_breakdown(d), dt) for d, dt in items]
            v = _wavg([(b["total_w"], dt) for b, dt in bds])
            if v is not None:
                node_vals.append(v)
            count += len(items)
            meas += sum(1 for b, _ in bds if b["actuator_measured"])
            pr = [(_shadow_power(d, "heuristic"), _shadow_power(d, "ml"), dt) for d, dt in items]
            pr = [(h, m, dt) for h, m, dt in pr if h is not None and m is not None]
            if pr:
                h_vals.append(_wavg([(h, dt) for h, _, dt in pr]))
                m_vals.append(_wavg([(m, dt) for _, m, dt in pr]))
        avg = _mean(node_vals)
        result["trend_data"].append({
            "date": day,
            "node_kwh": round(avg * 24 / 1000, 4) if avg is not None else None,
            "measured_pct": round(100 * meas / count, 1) if count else 0.0,
            "readings": count,
            "heuristic_kwh": round(_mean(h_vals) * 24 / 1000, 4) if h_vals else None,
            "ml_shadow_kwh": round(_mean(m_vals) * 24 / 1000, 4) if m_vals else None,
        })
    return result
