"""CS5055 — contrato aditivo del nodo ESP32, ML en sombra y métricas derivadas.

Sin bases de datos: Mongo y Postgres se sustituyen por dobles en memoria.
"""
from datetime import datetime, timedelta
import types

import pytest

from app.services import predictive_service
from app.services.predictive_service import calculate_cooling_demand
from app.services.node_metrics import compute_node_energy, compute_node_metrics, percentile

NEW_FIELDS = {
    "power_w": 3.1, "current_ma": 258.0, "bus_voltage_v": 12.02, "fan_pwm": 65.0,
    "heater_on": False, "alarm_active": False, "node_online": True,
    "rssi_dbm": -61.0, "latency_ms": 840.0, "uptime_s": 3600.0, "data_origin": "node",
}


# ── Dobles de BD ──────────────────────────────────────────────────────────────

class _Cursor:
    def __init__(self, docs):
        self._docs = list(docs)

    def sort(self, key, direction):
        self._docs.sort(key=lambda d: d.get(key) or "", reverse=direction < 0)
        return self

    def limit(self, n):
        self._docs = self._docs[:n]
        return self

    async def to_list(self, length=None):
        return [dict(d) for d in self._docs[:length]]


class _Collection:
    def __init__(self):
        self.docs: list[dict] = []

    async def insert_one(self, doc):
        self.docs.append(dict(doc))
        return types.SimpleNamespace(inserted_id=f"id-{len(self.docs)}")

    async def delete_many(self, flt):
        return types.SimpleNamespace(deleted_count=0)

    def find(self, flt=None, projection=None):
        flt = flt or {}
        out = []
        for d in self.docs:
            sid = flt.get("sensor_id")
            if isinstance(sid, str) and d.get("sensor_id") != sid:
                continue
            out.append(d)
        return _Cursor(out)


class _MongoDB(dict):
    def __getitem__(self, name):
        if name not in self:
            self[name] = _Collection()
        return dict.__getitem__(self, name)


class _Query:
    def filter(self, *a, **k):
        return self

    def first(self):
        return None

    def all(self):
        return []


class _Session:
    def query(self, *a, **k):
        return _Query()


@pytest.fixture
def api_client(monkeypatch):
    pytest.importorskip("fastapi")
    pytest.importorskip("httpx")
    from fastapi.testclient import TestClient
    import app.dependencies as deps
    from app.main import app
    from app.database import get_db
    from app.database_sql import get_db_sql

    monkeypatch.setattr(deps, "WATSON_EXTENSION_KEY", "")
    mongo = _MongoDB()
    app.dependency_overrides[get_db] = lambda: mongo
    app.dependency_overrides[get_db_sql] = lambda: _Session()
    yield TestClient(app)
    app.dependency_overrides.clear()


# ── Contrato de lecturas ──────────────────────────────────────────────────────

def test_ingest_and_list_roundtrip_new_node_fields(api_client):
    payload = {"sensor_id": "node-A403", "temperature": 24.1, "humidity": 60,
               "co2_ppm": 900, "co_ppm": 2.0, **NEW_FIELDS}
    res = api_client.post("/api/v1/sensors/", json=payload)
    assert res.status_code == 201, res.text
    # INF-3-05: la respuesta de decisión expone T* (target) junto a action/fan_pwm.
    assert "target" in res.json()["cognitive_action"]

    res = api_client.get("/api/v1/sensors/?sensor_id=node-A403")
    assert res.status_code == 200
    body = res.json()
    assert len(body) == 1
    for key, value in NEW_FIELDS.items():
        assert body[0][key] == value, key
    # ac_status sigue presente como alias del contrato viejo.
    assert "ac_status" in body[0]["cognitive_action"]


def test_old_payload_without_new_fields_still_valid(api_client):
    res = api_client.post("/api/v1/sensors/", json={
        "sensor_id": "legacy", "temperature": 22.0, "humidity": 50})
    assert res.status_code == 201
    row = api_client.get("/api/v1/sensors/?sensor_id=legacy").json()[0]
    assert row["fan_pwm"] is None and row["power_w"] is None


def test_fan_pwm_out_of_range_rejected(api_client):
    res = api_client.post("/api/v1/sensors/", json={
        "sensor_id": "x", "temperature": 22.0, "humidity": 50, "fan_pwm": 140})
    assert res.status_code == 422


# ── Heurística activa + ML en sombra ──────────────────────────────────────────

CTX = {"room_id": "A403", "target_temp": 20.0, "expected_people": 20,
       "max_capacity": 40, "control_policy": "auto"}
TS = datetime(2026, 7, 2, 15, 0)


class _FakeModel:
    def __init__(self, value):
        self.value = value

    def predict(self, rows):
        return [self.value]


@pytest.mark.asyncio
async def test_without_model_ml_shadow_is_none(monkeypatch):
    monkeypatch.setattr(predictive_service, "_model", None)
    r = await calculate_cooling_demand(25.0, CTX, TS, co2_ppm=900)
    assert r["active_controller"] == "heuristic"
    assert r["heuristic_action"] == "ON" and r["action"] == "ON"
    assert r["ml_action"] is None
    assert 40 <= r["fan_pwm"] <= 100
    # INF-3-05 / FE-3-13: la decisión incluye T* (consigna ajustada) y el comando
    # MQTT la reenvía al nodo para su histéresis local.
    assert isinstance(r["target"], float)
    from app.services.mqtt_bridge import build_cmd
    assert build_cmd(r)["target"] == r["target"]


@pytest.mark.asyncio
async def test_shadow_mode_keeps_heuristic_in_control(monkeypatch):
    import app.config as cfg
    monkeypatch.setattr(cfg, "ML_SHADOW_MODE", True)
    # ML predicts a huge thermal load → its decision differs, but must not act.
    monkeypatch.setattr(predictive_service, "_model", _FakeModel(10.0))
    r = await calculate_cooling_demand(19.0, CTX, TS, co2_ppm=420)
    assert r["model"] == "heuristic" and r["active_controller"] == "heuristic"
    assert r["ml_action"] in ("ON", "PRE-COOLING")
    assert r["ac_status"] == ("ON" if r["heuristic_action"] != "STANDBY" else "STANDBY")
    assert r["action"] == r["heuristic_action"]
    assert r["ml_reason"].startswith("ML (sombra)")


@pytest.mark.asyncio
async def test_precooling_when_planned_class_and_empty_room(monkeypatch):
    monkeypatch.setattr(predictive_service, "_model", None)
    # co2 at baseline → actual occupancy 0 while a class of 20 is planned.
    r = await calculate_cooling_demand(25.0, CTX, TS, co2_ppm=400)
    assert r["action"] == "PRE-COOLING"
    assert r["ac_status"] == "ON"


# ── Métricas derivadas ────────────────────────────────────────────────────────

def _doc(i, **kw):
    t0 = datetime(2026, 10, 1, 10, 0)
    base = {"sensor_id": "n1", "temperature": 21.0, "humidity": 60, "co2_ppm": 600,
            "co_ppm": 1.0, "timestamp": (t0 + timedelta(seconds=30 * i)).isoformat(),
            "cognitive_action": {"ac_status": "STANDBY", "target": 20.5}}
    base.update(kw)
    return base


def test_percentile_interpolates():
    assert percentile([100, 200, 300, 400, 500], 95) == pytest.approx(480)
    assert percentile([], 50) is None


def test_node_metrics_core_indicators():
    docs = [_doc(i, latency_ms=500 + 100 * i, fan_pwm=0, node_online=True) for i in range(10)]
    docs[3]["fan_pwm"] = 80; docs[4]["fan_pwm"] = 80; docs[5]["fan_pwm"] = 0   # ciclo de 60 s
    docs[6]["co_ppm"] = 70; docs[6]["alarm_active"] = True                      # 1 evento local
    docs[8]["node_online"] = False
    docs[2]["humidity"] = None                                                  # lectura inválida
    docs[1]["cognitive_action"].update(heuristic_action="ON", ml_action="ON")
    docs[2]["cognitive_action"].update(heuristic_action="ON", ml_action="STANDBY")
    docs[0]["camera_occupancy"] = 10; docs[0]["cognitive_action"]["actual_occupancy"] = 12

    m = compute_node_metrics(docs, window_hours=24)
    assert m["samples"] == 10
    assert m["data_quality"]["valid_pct"] == 90.0
    assert m["latency"]["p95_ms"] == pytest.approx(1355, abs=1)
    assert m["latency"]["within_target_pct"] == 100.0
    # Disponibilidad por huecos (OE2): node_online de las lecturas no interviene.
    assert m["availability"]["source"] == "huecos" and m["availability"]["drops"] == 0
    assert m["agreement"]["match_pct"] == 50.0 and m["agreement"]["divergences"] == 1
    assert m["occupancy"]["mae_people"] == 2.0
    assert m["alarm"]["events"] == 1 and m["alarm"]["local_samples"] == 1
    assert m["fan"]["cycles"] == 1 and m["fan"]["min_on_compliance_pct"] == 100.0
    assert m["energy"]["source"] == "estimado"


def test_node_metrics_empty_window_is_safe():
    m = compute_node_metrics([], window_hours=24)
    assert m["samples"] == 0 and m["latency"] is None and m["energy"] is None


def test_availability_inferred_from_gaps_without_lwt():
    docs = [_doc(i) for i in range(5)]
    docs.append(_doc(40))  # hueco de 17.5 min con cadencia de 30 s
    m = compute_node_metrics(docs, window_hours=1)
    assert m["availability"]["source"] == "huecos"
    assert m["availability"]["drops"] == 1
    assert m["availability"]["uptime_pct"] < 100


def test_availability_gap_counts_even_with_node_online_true():
    """FE-3-01: un hueco de 1 h baja la disponibilidad aunque las lecturas digan online."""
    docs = [_doc(i, node_online=True) for i in range(20)]            # cada 30 s
    docs += [_doc(i + 120, node_online=True) for i in range(20)]     # hueco de ~1 h
    m = compute_node_metrics(docs, window_hours=2)
    av = m["availability"]
    assert av["source"] == "huecos"
    assert av["drops"] == 1
    assert av["uptime_pct"] < 100
    assert av["gap_threshold_s"] == pytest.approx(90.0)              # 3 × 30 s
    assert av["lost_samples"] >= 100 and av["sample_loss_pct"] > 5


def test_availability_adds_lwt_offline_transitions_and_ongoing_gap():
    docs = [_doc(i) for i in range(10)]
    t0 = datetime(2026, 10, 1, 10, 0)
    events = [
        {"room_id": "A403", "online": True, "ts": t0.isoformat()},
        {"room_id": "A403", "online": False, "ts": (t0 + timedelta(minutes=1)).isoformat()},
        {"room_id": "A403", "online": False, "ts": (t0 + timedelta(minutes=2)).isoformat()},  # repetido
        {"room_id": "A403", "online": True, "ts": (t0 + timedelta(minutes=3)).isoformat()},
        {"room_id": "A403", "online": False, "ts": (t0 + timedelta(minutes=4)).isoformat()},
    ]
    m = compute_node_metrics(docs, window_hours=1, status_events=events,
                             window_end=t0 + timedelta(minutes=30))
    av = m["availability"]
    assert av["source"] == "huecos + LWT"
    assert av["lwt_offline_events"] == 2
    assert av["uptime_pct"] == 100.0           # sin huecos entre lecturas
    assert av["ongoing_gap_s"] is not None     # la última lectura es de hace > 3× periodo


def test_reading_power_matches_energy_rule():
    """FE-3-05: el desglose por lectura usa la misma regla que /roi."""
    from app.services.node_metrics import logic_power_w, reading_power, power_model
    r = reading_power(_doc(0, power_w=1.2, current_ma=100, bus_voltage_v=12.0))
    assert r["source"] == "medido + estimado" and r["actuator_basis"] == "medido"
    assert r["total_w"] == pytest.approx(1.2 + logic_power_w(), abs=1e-3)
    assert r["current_ma"] == 100
    est = reading_power(_doc(0, fan_pwm=50))
    assert est["source"] == "estimado" and est["actuator_basis"] == "reportado"
    on = reading_power(_doc(0, cognitive_action={"action": "ON", "ac_status": "ON"}))
    assert on["actuator_basis"] == "inferido"            # ON sin PWM → cota 100 %
    assert power_model()["logic_power_w"] == pytest.approx(logic_power_w(), abs=1e-3)


async def test_mqtt_status_persisted_only_on_change():
    """FE-3-01: el LWT se guarda aparte, solo cuando cambia."""
    from app.services import mqtt_bridge
    mqtt_bridge.node_status.clear()
    db = _MongoDB()
    assert await mqtt_bridge.record_status(db, "A403", True, "2026-10-01T10:00:00") is True
    assert await mqtt_bridge.record_status(db, "A403", True, "2026-10-01T10:00:30") is False
    assert await mqtt_bridge.record_status(db, "A403", False, "2026-10-01T10:01:00") is True
    assert [e["online"] for e in db["node_status_events"].docs] == [True, False]
    assert mqtt_bridge.node_status["A403"]["online"] is False
    mqtt_bridge.node_status.clear()


def test_energy_measured_vs_estimated_and_no_ac_baseline():
    from app.services.node_metrics import logic_power_w
    measured = [_doc(i, power_w=2.0) for i in range(4)]
    e = compute_node_energy(measured, 7, day_key=lambda t: t.date().isoformat())
    # Shunt en la rama del actuador: total = 2.0 W medidos + lógica nominal.
    assert e["power_source"] == "medido + estimado"
    kwh = (2.0 + logic_power_w()) * 24 / 1000
    assert e["node"]["kwh_day"] == pytest.approx(kwh, abs=1e-4)
    assert e["node"]["kwh_year"] == pytest.approx(kwh * 365, rel=1e-3)
    assert e["breakdown"]["actuator_avg_w"] == pytest.approx(2.0)
    flat = repr(e)
    for forbidden in ("traditional", "ac_power_kw", "savings"):
        assert forbidden not in flat

    estimated = compute_node_energy([_doc(0)], 7, day_key=lambda t: t.date().isoformat())
    assert estimated["power_source"] == "estimado"
    empty = compute_node_energy([], 7, day_key=lambda t: t.date().isoformat())
    assert empty["node"] is None and empty["upper_bound"]["kwh_day"] > 0


def test_energy_heuristic_vs_ml_shadow():
    docs = [_doc(i, cognitive_action={"ac_status": "ON", "heuristic_fan_pwm": 100, "ml_fan_pwm": 0})
            for i in range(3)]
    e = compute_node_energy(docs, 7, day_key=lambda t: t.date().isoformat())
    assert e["heuristic_vs_ml"]["heuristic_kwh_day"] > e["heuristic_vs_ml"]["ml_shadow_kwh_day"]


# ── Rutas nuevas / RBAC de alarma ─────────────────────────────────────────────

def _as(role):
    from app.main import app
    import app.dependencies as deps
    app.dependency_overrides[deps.get_current_user] = lambda: types.SimpleNamespace(
        id=1, username=f"t-{role}", role=role, status="active")


def test_guest_can_read_co_emergencies(api_client):
    _as("guest")
    res = api_client.get("/api/v1/sensors/emergencies")
    assert res.status_code == 200
    assert res.json() == {"real": [], "simulated": []}


def test_node_metrics_route_returns_derived_indicators(api_client):
    api_client.post("/api/v1/sensors/", json={
        "sensor_id": "node-A403", "temperature": 24.1, "humidity": 60,
        "co2_ppm": 900, "co_ppm": 2.0, **NEW_FIELDS})
    _as("guest")
    res = api_client.get("/api/v1/reports/node-metrics?sensor_id=node-A403&hours=24")
    assert res.status_code == 200
    body = res.json()
    assert body["samples"] == 1
    assert body["latency"]["p95_ms"] == 840
    # INA219 en la rama del actuador: rama medida + electrónica nominal (FE-2-01).
    assert body["energy"]["source"] == "medido + estimado"
    assert body["origin_counts"]["node"] == 1


def test_roi_route_is_node_consumption_without_ac_baseline(api_client):
    api_client.post("/api/v1/sensors/", json={
        "sensor_id": "node-A403", "temperature": 24.1, "humidity": 60, **NEW_FIELDS})
    _as("admin")
    res = api_client.get("/api/v1/reports/roi")
    assert res.status_code == 200
    body = res.json()
    assert body["power_source"] == "medido + estimado"
    assert body["node"]["kwh_day"] > 0
    for forbidden in ("traditional_kwh", "ac_power_kw", "energy_saved_kwh"):
        assert forbidden not in res.text


# ── Iteración 2 (FE-2-xx) ─────────────────────────────────────────────────────

def test_power_scope_node_means_total_measured(monkeypatch):
    import app.config as cfg
    monkeypatch.setattr(cfg, "INA219_SCOPE", "node")
    e = compute_node_energy([_doc(i, power_w=3.0) for i in range(3)], 7,
                            day_key=lambda t: t.date().isoformat())
    assert e["power_source"] == "medido"
    assert e["node"]["avg_power_w"] == pytest.approx(3.0)


def test_power_without_ina219_is_all_estimated_with_logic_share():
    from app.services.node_metrics import logic_power_w
    e = compute_node_energy([_doc(i) for i in range(3)], 7, day_key=lambda t: t.date().isoformat())
    assert e["power_source"] == "estimado"
    assert e["breakdown"]["logic_avg_w"] == pytest.approx(logic_power_w(), abs=1e-3)
    assert e["breakdown"]["actuator_avg_w"] == 0


def test_energy_is_time_weighted_not_per_reading():
    from app.services.node_metrics import logic_power_w
    t0 = datetime(2026, 10, 1, 0, 0)
    # 1 h a 1 W (muestras cada 10 min) y luego ráfaga de 5 muestras a 10 W cada 5 s.
    slow = [{"sensor_id": "n1", "power_w": 1.0, "timestamp": (t0 + timedelta(minutes=10 * i)).isoformat()}
            for i in range(7)]
    burst = [{"sensor_id": "n1", "power_w": 10.0,
              "timestamp": (t0 + timedelta(minutes=60, seconds=5 * (i + 1))).isoformat()} for i in range(5)]
    e = compute_node_energy(slow + burst, 7, day_key=lambda t: t.date().isoformat())
    actuator = e["breakdown"]["actuator_avg_w"]
    # Por lectura daría (7*1 + 5*10)/12 = 4.75 W; ponderado por tiempo queda cerca de 1 W.
    assert actuator < 2.5
    assert e["node"]["avg_power_w"] == pytest.approx(actuator + logic_power_w(), abs=1e-2)


def test_energy_multiple_nodes_reports_average_per_node():
    a = [_doc(i, sensor_id="a", power_w=1.0) for i in range(3)]
    b = [_doc(i, sensor_id="b", power_w=3.0, data_origin="seed") for i in range(30)]
    e = compute_node_energy(a + b, 7, day_key=lambda t: t.date().isoformat())
    assert e["nodes"] == 2 and e["simulated_nodes"] == 1
    assert e["breakdown"]["actuator_avg_w"] == pytest.approx(2.0)


def test_origin_requires_explicit_node_mark():
    from app.services.node_metrics import filter_by_origin, reading_origin
    assert reading_origin({"is_simulated": False}) == "desconocido"
    assert reading_origin({"data_origin": "node"}) == "node"
    assert reading_origin({"data_origin": "seed", "is_simulated": False}) == "simulado"
    docs = [_doc(0, data_origin="node"), _doc(1), _doc(2, data_origin="seed")]
    assert len(filter_by_origin(docs, "node")) == 1
    m = compute_node_metrics(docs, window_hours=24)
    assert m["origin_counts"] == {"node": 1, "simulado": 1, "desconocido": 1}


def test_comfort_band_single_and_asymmetric():
    docs = [_doc(0, temperature=20.5), _doc(1, temperature=23.0), _doc(2, temperature=17.0),
            _doc(3, temperature=21.0)]
    m = compute_node_metrics(docs, window_hours=24, configured_targets={"n1": 20.0})
    cf = m["comfort"]
    assert cf["band_ref"] == "objetivo configurado" and cf["band_c"] == 1.0
    assert cf["in_band_pct"] == 50.0       # 20.5 y 21.0
    assert cf["over_band_pct"] == 25.0     # 23.0 penaliza
    assert cf["cold_pct"] == 25.0          # 17.0: aula fría, fuera de alcance
    assert cf["controller_ok_pct"] == 75.0
    assert compute_node_metrics(docs, window_hours=24)["comfort"] is None


def test_min_on_not_evaluable_with_slow_sampling():
    t0 = datetime(2026, 10, 1, 10, 0)
    docs = [{"sensor_id": "n1", "temperature": 22, "humidity": 50, "fan_pwm": 80 if i % 2 else 0,
             "timestamp": (t0 + timedelta(minutes=10 * i)).isoformat()} for i in range(6)]
    fan = compute_node_metrics(docs, window_hours=24)["fan"]
    assert fan["min_on_compliance_pct"] is None
    assert fan["min_on_evaluable"] is False and "muestreo" in fan["min_on_reason"]


def test_missing_co_stays_null_and_anomaly_is_persisted(api_client):
    res = api_client.post("/api/v1/sensors/", json={
        "sensor_id": "no-mq7", "temperature": 41.0, "humidity": 50})
    assert res.status_code == 201
    row = api_client.get("/api/v1/sensors/?sensor_id=no-mq7").json()[0]
    assert row["co_ppm"] is None
    assert row["anomaly_detected"] is True


# ── Puente MQTT (sin broker) ──────────────────────────────────────────────────

def test_mqtt_topic_to_room():
    from app.services.mqtt_bridge import parse_topic, cmd_topic
    assert parse_topic("ccs/A403/telemetry") == ("A403", "telemetry")
    assert parse_topic("ccs/A403/status") == ("A403", "status")
    assert parse_topic("ccs/A403/other") is None
    assert parse_topic("otro/A403/telemetry") is None
    assert parse_topic("ccs/A403/telemetry/x") is None
    assert cmd_topic("A403") == "ccs/A403/cmd"


def test_mqtt_telemetry_payload_aliases_and_origin():
    pytest.importorskip("pydantic")
    from app.services.mqtt_bridge import decode_payload, telemetry_to_reading
    raw = (b'{"temp": 24.5, "hum": 61, "co2_ppm": 820, "co_ppm": 3.2, "power_w": 1.9, '
           b'"current_ma": 160, "bus_v": 12.01, "fan_pwm": 55, "heater_on": false, '
           b'"alarm_active": false, "rssi_dbm": -63, "uptime_s": 120}')
    r = telemetry_to_reading("A403", decode_payload(raw), sensor_id="node-A403", node_online=True)
    assert r.sensor_id == "node-A403" and r.temperature == 24.5 and r.humidity == 61
    assert r.bus_voltage_v == 12.01 and r.fan_pwm == 55
    assert r.data_origin == "node" and r.is_simulated is False
    assert r.node_online is True
    r2 = telemetry_to_reading("B201", {"temp": 22, "hum": 50})
    assert r2.sensor_id == "node-B201" and r2.co_ppm is None
    with pytest.raises(ValueError):
        decode_payload(b"[1, 2]")


def test_mqtt_status_and_cmd_payloads():
    from app.services.mqtt_bridge import parse_status, build_cmd
    assert parse_status(b"online") is True
    assert parse_status("offline") is False
    assert parse_status('{"status": "offline"}') is False
    assert parse_status("???") is None
    cmd = build_cmd({"action": "ON", "ac_status": "ON", "fan_pwm": 70,
                     "heuristic_reason": "T sobre objetivo", "active_controller": "heuristic"})
    assert cmd == {"action": "ON", "target": None, "fan_pwm": 70, "heater_on": None,
                   "reason": "T sobre objetivo", "controller": "heuristic"}
    # INF-3-05: el comando lleva T* (consigna ajustada) para la histéresis local.
    cmd_t = build_cmd({"action": "STANDBY", "target": 23.5, "fan_pwm": 0})
    assert cmd_t["target"] == 23.5 and cmd_t["action"] == "STANDBY"
    assert build_cmd(None) is None


def test_default_tariff_is_referential_pen():
    """INF-3-09: tarifa por defecto S/ 0.7556/kWh (Luz del Sur BT5B, referencial)."""
    import app.config as cfg
    if "ENERGY_COST_PER_KWH" not in __import__("os").environ:
        assert cfg.ENERGY_COST_PER_KWH == pytest.approx(0.7556)
    if "ENERGY_CURRENCY" not in __import__("os").environ:
        assert cfg.ENERGY_CURRENCY == "PEN"
    e = compute_node_energy([], 7, day_key=lambda t: t.date().isoformat())
    assert "referencial" in e["assumptions"]["tariff_label"] or e["assumptions"]["tariff_confirmed"]


def test_health_reports_mqtt_disabled_by_default(api_client):
    body = api_client.get("/health").json()
    assert body["mqtt"] == "disabled" and body["ingest"] == "http"
    assert body["power_model"]["ina219_scope"] in ("actuator", "node")


def test_list_readings_includes_backend_power_breakdown(api_client):
    api_client.post("/api/v1/sensors/", json={
        "sensor_id": "node-A403", "temperature": 24.1, "humidity": 60, **NEW_FIELDS})
    rows = api_client.get("/api/v1/sensors/?sensor_id=node-A403").json()
    assert rows and rows[0]["power"]["source"] == "medido + estimado"
    assert rows[0]["power"]["actuator_w"] == pytest.approx(3.1)
