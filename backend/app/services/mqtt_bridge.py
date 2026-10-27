"""Puente MQTT opcional (CS5055) — nodo ESP32 ⇄ backend.

Desactivado por defecto: solo arranca si la variable de entorno MQTT_BROKER_URL
está definida (p. ej. ``mqtt://broker:1883`` o ``mqtts://...``). Sin ella, la
ingesta sigue siendo HTTP (``POST /api/v1/sensors/``) y /health informa
``mqtt: "disabled"``.

Topics de docs/hardware-spec.md — **[CONFIRMAR nombres exactos con el firmware]**:
    <prefijo>/<aula>/telemetry  nodo → backend   (JSON con la telemetría)
    <prefijo>/<aula>/status     LWT del broker   ("online" / "offline")
    <prefijo>/<aula>/cmd        backend → nodo   (JSON retenido: action, target, fan_pwm, heater_on, reason)

La telemetría reutiliza exactamente la ruta de ingesta del POST
(`data_service.process_reading`): misma decisión heurística/ML-sombra, mismo
documento en Mongo. Las funciones de parseo son puras para probarlas sin broker.

LWT: el estado ``online``/``offline`` se guarda APARTE de las lecturas, solo
cuando cambia, en la colección ``node_status_events`` ({room_id, online, ts}).
No se copia a cada telemetría (un nodo caído no publica lecturas, así que ese
campo nunca mostraría la caída). /health expone el último estado por aula y
/reports/node-metrics suma las transiciones a offline a la disponibilidad.
"""
from __future__ import annotations

import asyncio
import json
import logging
from datetime import datetime
from typing import TYPE_CHECKING, Any, Optional
from urllib.parse import urlparse

if TYPE_CHECKING:  # import diferido: las funciones de topic/status no requieren pydantic
    from app.models.sensor import SensorReading

logger = logging.getLogger(__name__)

KINDS = ("telemetry", "status", "cmd")

# Alias cortos del payload de la spec → campos del contrato de lectura.
_ALIASES = {
    "temp": "temperature",
    "hum": "humidity",
    "co2": "co2_ppm",
    "co": "co_ppm",
    "bus_v": "bus_voltage_v",
    "rssi": "rssi_dbm",
}

# Estado observable desde /health.
_state: dict[str, Any] = {
    "status": "disabled",        # disabled | connecting | connected | disconnected
    "broker": None,
    "last_error": None,
    "messages": 0,
    "last_message_ts": None,
}
# Último estado LWT por aula: {room: {"online": bool, "ts": iso}}
node_status: dict[str, dict] = {}

_bridge: Optional["MqttBridge"] = None


# ── Funciones puras (testeables sin broker) ───────────────────────────────────

def parse_topic(topic: str, prefix: str = "ccs") -> Optional[tuple[str, str]]:
    """'ccs/A403/telemetry' → ('A403', 'telemetry'); None si no corresponde."""
    parts = (topic or "").split("/")
    if len(parts) != 3 or parts[0] != prefix or not parts[1] or parts[2] not in KINDS:
        return None
    if parts[1] in ("+", "#"):
        return None
    return parts[1], parts[2]


def decode_payload(raw: Any) -> dict:
    """bytes | str | dict → dict. ValueError si no es un objeto JSON."""
    if isinstance(raw, dict):
        return dict(raw)
    if isinstance(raw, (bytes, bytearray)):
        raw = raw.decode("utf-8", errors="strict")
    if not isinstance(raw, str):
        raise ValueError("payload no es texto")
    obj = json.loads(raw)
    if not isinstance(obj, dict):
        raise ValueError("payload JSON no es un objeto")
    return obj


def parse_status(raw: Any) -> Optional[bool]:
    """LWT: 'online'/'offline' (texto o JSON {"status": ...}) → True/False; None si no se entiende."""
    if isinstance(raw, (bytes, bytearray)):
        raw = raw.decode("utf-8", errors="ignore")
    if isinstance(raw, str):
        txt = raw.strip()
        if txt.startswith("{"):
            try:
                raw = json.loads(txt)
            except ValueError:
                return None
        else:
            raw = txt
    if isinstance(raw, dict):
        raw = raw.get("status", raw.get("state", raw.get("online")))
    if isinstance(raw, bool):
        return raw
    val = str(raw).strip().lower() if raw is not None else ""
    if val in ("online", "1", "true", "up", "connected"):
        return True
    if val in ("offline", "0", "false", "down", "disconnected"):
        return False
    return None


def telemetry_to_reading(room: str, payload: dict, sensor_id: Optional[str] = None,
                         node_online: Optional[bool] = None) -> "SensorReading":
    """Normaliza el JSON del nodo al contrato `SensorReading` (valida con pydantic).

    - Acepta los alias cortos de la spec (temp, hum, bus_v, ...).
    - `sensor_id`: el del payload; si falta, el del nodo registrado en el aula;
      si tampoco hay, ``node-<aula>``.
    - Procedencia: ``data_origin='node'`` salvo que el payload declare otra.
    - `node_online`: solo si el payload lo trae o se pasa explícitamente; el
      puente NO inyecta el último LWT (se persiste aparte, ver `record_status`).
    """
    from app.models.sensor import SensorReading

    data = {_ALIASES.get(k, k): v for k, v in payload.items()}
    data.pop("room", None)
    data.pop("room_id", None)
    data.setdefault("sensor_id", sensor_id or f"node-{room}")
    data.setdefault("data_origin", "node")
    if data["data_origin"] == "node":
        data["is_simulated"] = False
    if data.get("node_online") is None and node_online is not None:
        data["node_online"] = node_online
    if data.get("timestamp") is None:
        data.pop("timestamp", None)
    return SensorReading(**data)


def build_cmd(cognitive_action: Optional[dict]) -> Optional[dict]:
    """Comando retenido para ccs/<aula>/cmd a partir de la decisión del backend."""
    if not cognitive_action:
        return None
    ca = cognitive_action
    action = ca.get("action") or ca.get("ac_status")
    if action is None:
        return None
    return {
        "action": action,
        # T* = consigna ajustada por el backend; el firmware la usa para la
        # histéresis local (aditivo, INF-3-05).
        "target": ca.get("target"),
        "fan_pwm": ca.get("fan_pwm"),
        "heater_on": ca.get("heater_on"),
        "reason": ca.get("heuristic_reason") or ca.get("reason"),
        "controller": ca.get("active_controller") or ca.get("model"),
    }


def cmd_topic(room: str, prefix: str = "ccs") -> str:
    return f"{prefix}/{room}/cmd"


def status_for_health() -> dict:
    """Bloque aditivo para /health."""
    from app.config import MQTT_TOPIC_PREFIX
    st = _state["status"]
    out: dict[str, Any] = {
        "mqtt": "connected" if st == "connected" else ("disabled" if st == "disabled" else "disconnected"),
        "ingest": "mqtt+http" if st == "connected" else "http",
    }
    if st != "disabled":
        out["mqtt_topics"] = {
            "telemetry": f"{MQTT_TOPIC_PREFIX}/+/telemetry",
            "status": f"{MQTT_TOPIC_PREFIX}/+/status",
            "cmd": f"{MQTT_TOPIC_PREFIX}/<aula>/cmd (retenido)",
        }
        out["mqtt_messages"] = _state["messages"]
        # Último LWT por aula (aunque el nodo ya no publique telemetría).
        out["node_status"] = dict(node_status)
        if _state["last_error"]:
            out["mqtt_error"] = _state["last_error"]
    return out


def status_changed(room: str, online: bool) -> bool:
    """True si el LWT del aula cambia respecto del último conocido (o es el primero)."""
    last = node_status.get(room)
    return last is None or last.get("online") is not online


async def record_status(db, room: str, online: bool, ts: str) -> bool:
    """Actualiza el último LWT del aula y, SOLO si cambió, persiste la transición.

    Devuelve True si se registró un evento. Un fallo de Mongo no tumba el puente.
    """
    changed = status_changed(room, online)
    node_status[room] = {"online": online, "ts": ts if changed else node_status[room]["ts"],
                         "last_msg_ts": ts}
    if not changed:
        return False
    try:
        await db["node_status_events"].insert_one({"room_id": room, "online": online, "ts": ts})
    except Exception as exc:
        logger.warning("No se pudo persistir el LWT de %s: %s", room, exc)
    return True


async def load_last_status(db) -> None:
    """Restaura el último LWT por aula desde Mongo (sobrevive a reinicios)."""
    try:
        cursor = db["node_status_events"].find({}, {"_id": 0}).sort("ts", -1).limit(1_000)
        for ev in await cursor.to_list(length=1_000):
            room = ev.get("room_id")
            if room and room not in node_status and isinstance(ev.get("online"), bool):
                node_status[room] = {"online": ev["online"], "ts": ev.get("ts"), "restored": True}
    except Exception as exc:
        logger.warning("No se pudo restaurar el último LWT: %s", exc)


# ── Cliente (solo si MQTT_BROKER_URL) ─────────────────────────────────────────

class MqttBridge:
    def __init__(self, url: str, prefix: str, loop: asyncio.AbstractEventLoop):
        self.url = url
        self.prefix = prefix
        self.loop = loop
        self.client = None

    def start(self) -> None:
        from app.config import MQTT_CLIENT_ID, MQTT_PASSWORD, MQTT_USERNAME
        try:
            import paho.mqtt.client as mqtt  # dependencia opcional
        except ImportError:
            _state.update(status="disconnected", last_error="paho-mqtt no instalado")
            logger.error("MQTT_BROKER_URL definida pero paho-mqtt no está instalado.")
            return

        u = urlparse(self.url if "://" in self.url else f"mqtt://{self.url}")
        host, port = u.hostname or "localhost", u.port or (8883 if u.scheme == "mqtts" else 1883)
        _state["broker"] = f"{host}:{port}"
        try:
            client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id=MQTT_CLIENT_ID)
        except AttributeError:  # paho-mqtt 1.x
            client = mqtt.Client(client_id=MQTT_CLIENT_ID)
        if MQTT_USERNAME:
            client.username_pw_set(MQTT_USERNAME, MQTT_PASSWORD or None)
        if u.scheme == "mqtts":
            client.tls_set()

        def on_connect(c, _userdata, _flags, rc, *_args):
            ok = getattr(rc, "is_failure", None)
            failed = ok if isinstance(ok, bool) else (rc != 0)
            if failed:
                _state.update(status="disconnected", last_error=f"conexión rechazada ({rc})")
                return
            _state.update(status="connected", last_error=None)
            c.subscribe([(f"{self.prefix}/+/telemetry", 1), (f"{self.prefix}/+/status", 1)])
            logger.info("MQTT conectado a %s; suscrito a %s/+/telemetry y /status", _state["broker"], self.prefix)

        def on_disconnect(_c, _userdata, *args):
            _state["status"] = "disconnected"
            logger.warning("MQTT desconectado (%s)", args[-2] if len(args) >= 2 else args)

        def on_message(_c, _userdata, msg):
            asyncio.run_coroutine_threadsafe(self.handle(msg.topic, msg.payload), self.loop)

        client.on_connect = on_connect
        client.on_disconnect = on_disconnect
        client.on_message = on_message
        _state["status"] = "connecting"
        client.connect_async(host, port, keepalive=30)
        client.loop_start()
        self.client = client

    def stop(self) -> None:
        if self.client is not None:
            self.client.loop_stop()
            self.client.disconnect()
        _state["status"] = "disabled"

    def publish_cmd(self, room: str, cmd: dict) -> None:
        if self.client is None or _state["status"] != "connected":
            return
        self.client.publish(cmd_topic(room, self.prefix), json.dumps(cmd), qos=1, retain=True)

    async def handle(self, topic: str, raw: Any) -> None:
        parsed = parse_topic(topic, self.prefix)
        if parsed is None:
            return
        room, kind = parsed
        _state["messages"] += 1
        _state["last_message_ts"] = datetime.utcnow().isoformat()
        try:
            if kind == "status":
                online = parse_status(raw)
                if online is not None:
                    from app.database import get_db
                    await record_status(get_db(), room, online, _state["last_message_ts"])
                return
            if kind != "telemetry":
                return
            await self._ingest(room, decode_payload(raw))
        except Exception as exc:  # un mensaje malformado no tumba el puente
            _state["last_error"] = f"{kind}@{room}: {exc}"
            logger.warning("MQTT mensaje descartado (%s): %s", topic, exc)

    async def _ingest(self, room: str, payload: dict) -> None:
        from starlette.concurrency import run_in_threadpool
        from app.database import get_db
        from app.database_sql import SessionLocal
        from app.models.admin import SensorDevice
        from app.services.data_service import process_reading

        session = SessionLocal()
        try:
            sid = payload.get("sensor_id")
            if not sid:
                dev = await run_in_threadpool(
                    lambda: session.query(SensorDevice).filter(SensorDevice.room_id == room).first())
                sid = dev.id if dev else None
            # El LWT NO se copia a la lectura: se guarda aparte (record_status).
            reading = telemetry_to_reading(room, payload, sensor_id=sid)
            result = await process_reading(get_db(), reading, db_sql=session)
        finally:
            session.close()
        cmd = build_cmd(result.get("cognitive_action"))
        if cmd:
            self.publish_cmd(room, cmd)


async def start_bridge() -> None:
    """Arranca el puente si MQTT_BROKER_URL está definida; si no, queda 'disabled'."""
    global _bridge
    from app.config import MQTT_BROKER_URL, MQTT_TOPIC_PREFIX
    if not MQTT_BROKER_URL:
        _state["status"] = "disabled"
        logger.info("Puente MQTT desactivado (MQTT_BROKER_URL vacía): ingesta solo por HTTP.")
        return
    try:
        from app.database import get_db
        await load_last_status(get_db())
    except Exception as exc:
        logger.warning("Sin LWT previo: %s", exc)
    _bridge = MqttBridge(MQTT_BROKER_URL, MQTT_TOPIC_PREFIX, asyncio.get_running_loop())
    try:
        _bridge.start()
    except Exception as exc:
        _state.update(status="disconnected", last_error=str(exc))
        logger.error("No se pudo iniciar el puente MQTT: %s", exc)


def stop_bridge() -> None:
    if _bridge is not None:
        _bridge.stop()
