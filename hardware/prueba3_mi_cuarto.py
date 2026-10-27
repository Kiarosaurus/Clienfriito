"""Prueba 3: DHT11 + boton + retorno de decision de la API a la ESP32.

Carga primero hardware/prueba3_control_virtual/prueba3_control_virtual.ino en la
ESP32. Instala pyserial con `python -m pip install pyserial` y ejecuta:
    python hardware/prueba3_mi_cuarto.py --port COM12

La orden devuelta solo se registra por Serial: no acciona motor ni reles.
"""

import argparse
import json
import math
import os
import sys
import time
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


SENSOR_ID = "Prueba tipo 1"
ROOM_ID = "MI-CUARTO"
DEFAULT_API_URL = "http://localhost:3000/api/v1/sensors/"
BAUD_RATE = 115200


def parse_dht_line(raw: bytes) -> tuple[int, float, float, str] | None:
    """Acepta solo JSON con medidas validas del DHT11; ignora mensajes de arranque."""
    try:
        data = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None
    if not isinstance(data, dict) or data.get("sensor") != "DHT11":
        return None
    sequence = data.get("seq")
    if isinstance(sequence, bool) or not isinstance(sequence, int) or not 0 <= sequence <= 0xFFFFFFFF:
        return None
    temperature = data.get("temperature")
    humidity = data.get("humidity")
    if isinstance(temperature, bool) or isinstance(humidity, bool):
        return None
    if not isinstance(temperature, (int, float)) or not isinstance(humidity, (int, float)):
        return None
    if not math.isfinite(temperature) or not math.isfinite(humidity) or not 0 <= humidity <= 100:
        return None
    trigger = data.get("trigger")
    if trigger not in ("button", "periodic"):
        trigger = "periodic"
    return sequence, float(temperature), float(humidity), trigger


def command_from_response(sequence: int, result: dict) -> tuple[str, str, bytes]:
    """Usa solo la decision activa de la API; conserva 'NA' si no hay PWM."""
    decision = result.get("cognitive_action") or {}
    action = decision.get("action") or decision.get("ac_status")
    if action not in {"ON", "PRE-COOLING", "STANDBY", "DISABLED"}:
        raise RuntimeError(f"Accion de API no reconocida: {action!r}")
    pwm = decision.get("fan_pwm")
    if pwm is None:
        pwm_text = "NA"
    elif isinstance(pwm, bool) or not isinstance(pwm, (int, float)) or not math.isfinite(pwm) or not 0 <= pwm <= 100:
        raise RuntimeError(f"fan_pwm de API invalido: {pwm!r}")
    else:
        pwm_text = f"{pwm:.1f}"
    return action, pwm_text, f"CMD,{sequence},{action},{pwm_text}\n".encode("ascii")


def parse_ack(raw: bytes) -> tuple[int, str, str] | None:
    try:
        parts = raw.decode("ascii").strip().split(",")
        if len(parts) != 4 or parts[0] != "ACK":
            return None
        return int(parts[1]), parts[2], parts[3]
    except (UnicodeDecodeError, ValueError):
        return None


def send_reading(url: str, api_key: str, temperature: float, humidity: float) -> dict:
    payload = {
        "sensor_id": SENSOR_ID,
        "temperature": temperature,
        "humidity": humidity,
        "is_simulated": False,
        "data_origin": "node",
    }
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["X-API-Key"] = api_key
    request = Request(url, data=json.dumps(payload).encode("utf-8"), headers=headers, method="POST")
    try:
        with urlopen(request, timeout=5) as response:
            result = json.load(response)
    except HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"HTTP {exc.code}: {detail}") from exc
    except URLError as exc:
        raise RuntimeError(f"No se pudo conectar a {url}: {exc.reason}") from exc

    if result.get("skipped"):
        raise RuntimeError(f"Lectura descartada: {result.get('reason', 'motivo desconocido')}")
    actual_room = (result.get("room_context") or {}).get("room_id")
    if actual_room != ROOM_ID:
        raise RuntimeError(
            f"La API guardo la lectura, pero devolvio aula {actual_room!r}; "
            f"se esperaba {ROOM_ID!r}. Revisa la asociacion del sensor."
        )
    return result


def choose_port(requested: str | None, available: list[str]) -> str:
    if requested:
        return requested
    if len(available) == 1:
        return available[0]
    listed = ", ".join(available) if available else "ninguno"
    raise RuntimeError(f"Indica --port COMx. Puertos detectados: {listed}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", help="Puerto USB de la ESP32, por ejemplo COM12")
    parser.add_argument("--url", default=DEFAULT_API_URL, help="URL local de ingesta")
    args = parser.parse_args()

    try:
        import serial
        from serial.tools import list_ports
    except ImportError:
        print("Falta pyserial. Instala con: python -m pip install pyserial", file=sys.stderr)
        return 1

    try:
        port = choose_port(args.port, [p.device for p in list_ports.comports()])
        print(f"Leyendo DHT11 en {port} a {BAUD_RATE} baudios; destino: {ROOM_ID} / {SENSOR_ID}")
        print(f"Abre http://localhost:3000/room/{ROOM_ID}. Pulsa Ctrl+C para terminar.")
        print("Cierra el Monitor serie de Arduino IDE antes de ejecutar este script.")
        api_key = os.environ.get("CCS_API_KEY", "")
        pending: dict[int, tuple[str, str, float]] = {}
        with serial.Serial(port, BAUD_RATE, timeout=1) as connection:
            while True:
                raw = connection.readline()
                ack = parse_ack(raw)
                if ack is not None:
                    sequence, action, pwm_text = ack
                    expected = pending.pop(sequence, None)
                    if expected and (action, pwm_text) == expected[:2]:
                        print(f"ESP32 confirmo orden {sequence}: {action}, PWM solicitado {pwm_text} % (virtual)", flush=True)
                    else:
                        print(f"Confirmacion inesperada de ESP32: {raw.decode('ascii', errors='replace').strip()}", file=sys.stderr)
                    continue
                if raw.startswith(b"ERR,"):
                    print(f"ESP32: {raw.decode('ascii', errors='replace').strip()}", file=sys.stderr)
                now = time.monotonic()
                for old_seq, (_, _, sent_at) in list(pending.items()):
                    if now - sent_at > 3:
                        print(f"Sin confirmacion de ESP32 para orden {old_seq}", file=sys.stderr)
                        del pending[old_seq]
                reading = parse_dht_line(raw)
                if reading is None:
                    continue
                sequence, temperature, humidity, trigger = reading
                try:
                    result = send_reading(args.url, api_key, temperature, humidity)
                    action, pwm_text, command = command_from_response(sequence, result)
                except RuntimeError as exc:
                    print(f"Error al enviar lectura: {exc}", file=sys.stderr, flush=True)
                    continue
                source = "boton" if trigger == "button" else "periodica"
                print(f"HTTP 201 | DHT11 {temperature:.1f} C | {humidity:.1f} % | {source} | API: {action}, PWM {pwm_text}", flush=True)
                connection.write(command)
                connection.flush()
                pending[sequence] = (action, pwm_text, time.monotonic())
    except KeyboardInterrupt:
        print("\nEnvio detenido.")
        return 0
    except (RuntimeError, serial.SerialException) as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
