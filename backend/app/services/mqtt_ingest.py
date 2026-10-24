"""
MQTT ingest — telemetry from the ESP32 node into the same pipeline as HTTP readings.

The node (hardware/firmware/src/sketch.ino) publishes one JSON per control cycle on
`ccs/<room>/telemetry`. This service subscribes to MQTT_TOPIC (default
`ccs/+/telemetry`), translates each message into a SensorReading and hands it to
process_reading — exactly what POST /api/v1/sensors/ does — so the reading is stored
in MongoDB and gets the backend's cognitive_action (ML / heuristic, run in shadow).

The node decides the actuators locally (heuristic with hysteresis + CO alarm). That
decision travels in the message and is stored as `node_state`, next to the backend's
`cognitive_action`, so both logics can be compared on the same reading.

Payload fields used (see publicarTelemetria in the firmware):
    temp_c, humedad, co2_ppm, co_ppm, is_simulated   -> SensorReading
    accion, motivo, alarma_co, ventilador_pwm, ...   -> node_state
"""
import asyncio
import json
import logging
import uuid

from pydantic import ValidationError

from app.config import MQTT_ENABLED, MQTT_HOST, MQTT_PORT, MQTT_TOPIC
from app.models.sensor import SensorReading

logger = logging.getLogger(__name__)

RETRY_SECONDS = 5

# Node decision fields copied verbatim into node_state.
NODE_STATE_FIELDS = (
    "accion", "motivo", "alarma_co", "ventilador_pwm", "calefactor", "buzzer", "led",
    "bloqueo_s", "pendiente", "ciclo", "uptime_s", "co2_proxy",
)

_task: asyncio.Task | None = None


def telemetry_to_reading(topic: str, payload: bytes | str) -> SensorReading | None:
    """Translate one node telemetry message into a SensorReading.

    Returns None (and the message is skipped) when the topic is not
    `ccs/<room>/telemetry`, the payload is not valid JSON, or the DHT had no reading
    (temperature/humidity are mandatory in SensorReading).
    """
    parts = topic.split("/")
    if len(parts) != 3 or parts[2] != "telemetry" or not parts[1]:
        return None
    try:
        data = json.loads(payload)
    except (TypeError, ValueError):
        logger.warning("MQTT: payload is not valid JSON on %s", topic)
        return None
    if not isinstance(data, dict):
        return None
    if data.get("temp_c") is None or data.get("humedad") is None:
        logger.debug("MQTT: reading without DHT data on %s skipped", topic)
        return None

    try:
        return SensorReading(
            # Seed convention: one device per room, id "s-<room>" (e.g. s-A403).
            sensor_id=f"s-{parts[1]}",
            temperature=float(data["temp_c"]),
            humidity=float(data["humedad"]),
            co2_ppm=data.get("co2_ppm"),
            co_ppm=float(data.get("co_ppm") or 0.0),
            is_simulated=bool(data.get("is_simulated", False)),
            node_state={k: data[k] for k in NODE_STATE_FIELDS if k in data},
        )
    except (TypeError, ValueError, ValidationError) as exc:
        logger.warning("MQTT: invalid telemetry on %s: %s", topic, exc)
        return None


async def _ingest(topic: str, payload: bytes) -> None:
    reading = telemetry_to_reading(topic, payload)
    if reading is None:
        return
    from app.database import get_db
    from app.database_sql import SessionLocal
    from app.services.data_service import process_reading

    db_sql = SessionLocal()
    try:
        await process_reading(get_db(), reading, db_sql=db_sql)
    finally:
        db_sql.close()


async def _run() -> None:
    import aiomqtt

    client_id = f"ccs-backend-{uuid.uuid4().hex[:8]}"
    while True:
        try:
            async with aiomqtt.Client(MQTT_HOST, MQTT_PORT, identifier=client_id) as client:
                await client.subscribe(MQTT_TOPIC)
                logger.info("MQTT ingest connected to %s:%d, subscribed to %s", MQTT_HOST, MQTT_PORT, MQTT_TOPIC)
                async for message in client.messages:
                    try:
                        await _ingest(str(message.topic), message.payload)
                    except Exception:  # one bad message must not stop the subscriber
                        logger.exception("MQTT: could not ingest message on %s", message.topic)
        except aiomqtt.MqttError as exc:
            logger.warning("MQTT broker %s:%d unavailable (%s); retrying in %d s",
                           MQTT_HOST, MQTT_PORT, exc, RETRY_SECONDS)
            await asyncio.sleep(RETRY_SECONDS)


def start_mqtt_ingest() -> None:
    global _task
    if not MQTT_ENABLED:
        logger.info("MQTT ingest disabled (MQTT_ENABLED=false).")
        return
    if _task is None or _task.done():
        _task = asyncio.create_task(_run())


async def stop_mqtt_ingest() -> None:
    global _task
    if _task is not None:
        _task.cancel()
        try:
            await _task
        except asyncio.CancelledError:
            pass
        _task = None
