"""Prueba 2: envia lecturas DHT11 periodicas y las solicitadas con el pulsador.

Carga primero hardware/prueba2_dht11_boton_serial/prueba2_dht11_boton_serial.ino en la
ESP32. Instala pyserial con `python -m pip install pyserial` y ejecuta:
    python hardware/prueba2_mi_cuarto.py --port COM12

Si solo hay un puerto serie conectado, --port es opcional. No genera datos.
"""

import argparse
import json
import math
import os
import sys
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


SENSOR_ID = "Prueba tipo 1"
ROOM_ID = "MI-CUARTO"
DEFAULT_API_URL = "http://localhost:3000/api/v1/sensors/"
BAUD_RATE = 115200


def parse_dht_line(raw: bytes) -> tuple[float, float, str] | None:
    """Acepta solo JSON con medidas validas del DHT11; ignora mensajes de arranque."""
    try:
        data = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None
    if not isinstance(data, dict) or data.get("sensor") != "DHT11":
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
    return float(temperature), float(humidity), trigger


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
        with serial.Serial(port, BAUD_RATE, timeout=2) as connection:
            while True:
                reading = parse_dht_line(connection.readline())
                if reading is None:
                    continue
                temperature, humidity, trigger = reading
                try:
                    result = send_reading(args.url, api_key, temperature, humidity)
                except RuntimeError as exc:
                    print(f"Error al enviar lectura: {exc}", file=sys.stderr, flush=True)
                    continue
                action = (result.get("cognitive_action") or {}).get("ac_status", "?")
                source = "boton" if trigger == "button" else "periodica"
                print(f"HTTP 201 | DHT11 {temperature:.1f} C | {humidity:.1f} % | {source} | accion: {action}", flush=True)
    except KeyboardInterrupt:
        print("\nEnvio detenido.")
        return 0
    except (RuntimeError, serial.SerialException) as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
