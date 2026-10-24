# -*- coding: utf-8 -*-
"""
Classroom sensor-node gateway (classroom A403, UTEC Barranco):
- Reads environmental sensor data from an Arduino UNO (Serial, JSON)
- Counts room occupancy with the laptop camera (MediaPipe Face Detection)
- Merges everything into a single JSON, printed each cycle, and POSTs it
  to the Climate Cognitive System backend.

Requirements:
    pip install pyserial mediapipe opencv-python requests

Adjust SERIAL_PORT for your system:
    Windows: 'COM3', 'COM4', etc.
    Linux/Mac: '/dev/ttyUSB0' or '/dev/ttyACM0'
"""

import cv2
import mediapipe as mp
import serial
import json
import time
import threading
import requests
import urllib3

# ── Configuration ──────────────────────────────────────────
SERIAL_PORT = 'COM6'      # <-- ADJUST
BAUD_RATE   = 9600
CAMERA_INDEX = 0          # 0 = laptop built-in camera

# Position of the virtual crossing line (fraction of the frame width)
LINE_X_RATIO = 0.5

# ── Upload to the server (Climate Cognitive System) ────────
API_URL   = "https://kiarosaurus.me/api/v1/sensors/"
SENSOR_ID = "s-A403"       # <-- MUST match the device id registered in the web app (seed: s-<room>)
API_KEY   = ""             # optional X-API-Key; required when WATSON_EXTENSION_KEY is set server-side
IS_SIMULATED = False       # True when sending test data (marks readings as simulated)
HTTP_TIMEOUT = 5           # seconds
VERIFY_TLS = True          # real, valid Let's Encrypt cert on the server -> verification on

# Silence "InsecureRequestWarning" when VERIFY_TLS=False
if not VERIFY_TLS:
    urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

# ── MQ7 (CO) calibration ───────────────────────────────────
# The MQ7 reports 'co_raw' (ADC reading). To convert it to real ppm:
#   ADC -> voltage -> Rs (sensor resistance) -> Rs/R0 ratio -> datasheet curve.
# ADJUST for your hardware:
ADC_MAX = 1023.0     # Arduino UNO/Nano = 1023 (10 bits). ESP32 = 4095 (12 bits).
VCC     = 5.0        # Sensor supply voltage (5.0 or 3.3)
RL      = 10.0       # Module load resistance in kΩ (typically 10k)

# R0 = sensor resistance in clean air (kΩ). CALIBRATED ONCE:
#   set CALIBRATE_MQ7 = True, run the script in clean air for ~5 min (sensor pre-heated),
#   copy the average "suggested R0" here, then set CALIBRATE_MQ7 = False again.
MQ7_R0 = 10.0
CALIBRATE_MQ7   = False   # True: prints the suggested R0 and does NOT send data
CLEAN_AIR_RATIO = 27.0    # Rs/R0 in clean air per the MQ7 datasheet

# CO curve from the datasheet (log-log fit): ppm = A * (Rs/R0)^B
MQ7_A = 99.042
MQ7_B = -1.518


def mq7_raw_to_ppm(raw):
    """Convert the MQ7 ADC reading to CO ppm using the datasheet curve."""
    if raw is None or raw <= 0:
        return 0.0
    v = (raw / ADC_MAX) * VCC
    if v <= 0:
        return 0.0
    rs = (VCC - v) / v * RL          # voltage divider with RL
    ratio = rs / MQ7_R0
    ppm = MQ7_A * (ratio ** MQ7_B)
    # Clamp to the sensor's sensible range (20-2000 ppm); outside that = noise
    if ppm < 0:
        ppm = 0.0
    return round(ppm, 2)


def mq7_r0_sugerido(raw):
    """Estimated R0 from a clean-air reading (calibration mode)."""
    if raw is None or raw <= 0:
        return None
    v = (raw / ADC_MAX) * VCC
    if v <= 0:
        return None
    rs = (VCC - v) / v * RL
    return rs / CLEAN_AIR_RATIO

# ── State shared between threads ───────────────────────────
estado = {
    "sensores": {},      # last JSON received from the Arduino
    "aforo_actual": 0,
    "lock": threading.Lock()
}


# ── Thread 1: read the Arduino over Serial ─────────────────
def hilo_serial():
    try:
        ser = serial.Serial(SERIAL_PORT, BAUD_RATE, timeout=2)
        time.sleep(2)  # wait for the Arduino to reset
        print(f"[Serial] Connected to {SERIAL_PORT}")
    except Exception as e:
        print(f"[Serial] Could not open the port: {e}")
        return

    while True:
        try:
            line = ser.readline().decode('utf-8', errors='ignore').strip()
            if not line:
                continue
            data = json.loads(line)
            with estado["lock"]:
                estado["sensores"] = data
        except json.JSONDecodeError:
            continue
        except Exception as e:
            print(f"[Serial] Error: {e}")
            time.sleep(2)


# ── Thread 2: camera + occupancy counting ──────────────────
def hilo_camara():
    mp_face = mp.solutions.face_detection

    cap = cv2.VideoCapture(CAMERA_INDEX)
    if not cap.isOpened():
        print("[Camera] Could not open the camera.")
        return

    # Simple tracking: list of centroids from the previous frame
    # each item: {"cx": x, "lado": "izq"/"der", "frames_sin_ver": int}
    tracks = []
    aforo = 0

    with mp_face.FaceDetection(model_selection=0, min_detection_confidence=0.6) as detector:
        while True:
            ok, frame = cap.read()
            if not ok:
                break

            h, w, _ = frame.shape
            line_x = int(w * LINE_X_RATIO)

            rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            results = detector.process(rgb)

            detecciones_actuales = []  # x centroids in this frame

            if results.detections:
                for det in results.detections:
                    bbox = det.location_data.relative_bounding_box
                    x = int(bbox.xmin * w)
                    y = int(bbox.ymin * h)
                    bw = int(bbox.width * w)
                    bh = int(bbox.height * h)
                    cx = x + bw // 2

                    detecciones_actuales.append(cx)

                    # Draw the bounding box
                    cv2.rectangle(frame, (x, y), (x + bw, y + bh), (0, 255, 0), 2)
                    cv2.circle(frame, (cx, y + bh // 2), 4, (0, 0, 255), -1)

            # ── Simple proximity-based tracking ─────────────
            nuevos_tracks = []
            usados = set()

            for t in tracks:
                # find the detection closest to the existing track
                mejor = None
                mejor_dist = 60  # distance threshold in px
                for i, cx in enumerate(detecciones_actuales):
                    if i in usados:
                        continue
                    dist = abs(cx - t["cx"])
                    if dist < mejor_dist:
                        mejor_dist = dist
                        mejor = i

                if mejor is not None:
                    nuevo_cx = detecciones_actuales[mejor]
                    usados.add(mejor)

                    lado_anterior = t["lado"]
                    lado_actual = "izq" if nuevo_cx < line_x else "der"

                    # Detect line crossing
                    if lado_anterior == "izq" and lado_actual == "der":
                        aforo += 1
                        print(f"[Occupancy] Person ENTERED. Current count: {aforo}")
                    elif lado_anterior == "der" and lado_actual == "izq":
                        aforo = max(0, aforo - 1)
                        print(f"[Occupancy] Person LEFT. Current count: {aforo}")

                    t["cx"] = nuevo_cx
                    t["lado"] = lado_actual
                    t["frames_sin_ver"] = 0
                    nuevos_tracks.append(t)
                else:
                    # No match found, bump the missing-frames counter
                    t["frames_sin_ver"] += 1
                    if t["frames_sin_ver"] < 10:  # tolerate short occlusions
                        nuevos_tracks.append(t)

            # Create new tracks for unassigned detections
            for i, cx in enumerate(detecciones_actuales):
                if i not in usados:
                    lado = "izq" if cx < line_x else "der"
                    nuevos_tracks.append({
                        "cx": cx,
                        "lado": lado,
                        "frames_sin_ver": 0
                    })

            tracks = nuevos_tracks

            # Update the shared state
            with estado["lock"]:
                estado["aforo_actual"] = aforo

            # Draw the virtual line and the occupancy count
            cv2.line(frame, (line_x, 0), (line_x, h), (255, 0, 0), 2)
            cv2.putText(frame, f"Occupancy: {aforo}", (10, 30),
                        cv2.FONT_HERSHEY_SIMPLEX, 1, (0, 255, 255), 2)

            cv2.imshow("Occupancy Monitor - Classroom A403", frame)

            if cv2.waitKey(1) & 0xFF == ord('q'):
                break

    cap.release()
    cv2.destroyAllWindows()


# ── Map the Arduino data to the payload the server expects ──
def _to_float(d, *keys, default=None):
    """Return the first key found in d converted to float."""
    for k in keys:
        if k in d and d[k] is not None:
            try:
                return float(d[k])
            except (ValueError, TypeError):
                pass
    return default


def construir_payload(sensores, aforo):
    """Build the JSON that /api/v1/sensors/ expects, reading the Arduino's
    nested structure: {"dht11":{...},"mq135":{...},"mq7":{...}}."""
    dht   = sensores.get("dht11", {}) or {}
    mq135 = sensores.get("mq135", {}) or {}
    mq7   = sensores.get("mq7", {}) or {}

    temp = _to_float(dht, "temp_c", "temperature", "temperatura")
    hum  = _to_float(dht, "humidity_pct", "humidity", "humedad")
    if temp is None or hum is None:
        return None  # without temperature/humidity the server rejects the reading (422)

    return {
        "sensor_id":   SENSOR_ID,
        "temperature": temp,
        "humidity":    hum,
        "co2_ppm":     _to_float(mq135, "air_quality_ppm", "co2_ppm", "co2"),
        # MQ7 co_raw converted to real ppm with the calibrated curve.
        "co_ppm":      mq7_raw_to_ppm(_to_float(mq7, "co_raw", "co_ppm")),
        "is_simulated": IS_SIMULATED,
        # CURRENT headcount from the camera (line-crossing count) — not the room's
        # max capacity nor the reservation plan. Persisted server-side next to the
        # CO2-derived actual_occupancy so the mass-balance proxy can be validated.
        "camera_occupancy": aforo,
    }


def enviar_al_servidor(payload):
    headers = {"X-API-Key": API_KEY} if API_KEY else {}
    try:
        r = requests.post(API_URL, json=payload, headers=headers,
                          timeout=HTTP_TIMEOUT, verify=VERIFY_TLS)
        if r.status_code == 201:
            accion = r.json().get("cognitive_action", {}).get("ac_status", "?")
            print(f"[POST] OK 201 — ac_status={accion}")
        else:
            print(f"[POST] {r.status_code}: {r.text[:200]}")
    except requests.RequestException as e:
        print(f"[POST] Network error: {e}")


# ── Thread 3: merge, print the JSON and send to the server ──
def hilo_combinado():
    while True:
        time.sleep(2)  # same interval as the Arduino
        with estado["lock"]:
            sensores = dict(estado["sensores"])
            aforo = estado["aforo_actual"]

        if not sensores:
            print("[Merge] Waiting for Arduino data...")
            continue

        sensores["camera_occupancy"] = aforo

        salida = json.dumps(sensores, ensure_ascii=False)
        print(f"[FINAL JSON] {salida}")

        # Calibration mode: do NOT send, only print the suggested R0 in clean air
        if CALIBRATE_MQ7:
            raw = _to_float(sensores.get("mq7", {}) or {}, "co_raw", "co_ppm")
            r0 = mq7_r0_sugerido(raw)
            if r0 is not None:
                print(f"[MQ7 CALIB] raw={raw} -> suggested R0 = {r0:.2f} kΩ "
                      f"(average several clean-air readings and copy it into MQ7_R0)")
            else:
                print(f"[MQ7 CALIB] invalid raw: {raw}")
            continue

        # Send to the server
        payload = construir_payload(sensores, aforo)
        if payload is None:
            print("[POST] temperature/humidity missing in the Arduino JSON — not sending.")
        else:
            enviar_al_servidor(payload)


# ── Main ────────────────────────────────────────────────────
if __name__ == "__main__":
    t_serial = threading.Thread(target=hilo_serial, daemon=True)
    t_combinado = threading.Thread(target=hilo_combinado, daemon=True)

    t_serial.start()
    t_combinado.start()

    # The camera must run on the main thread (OpenCV requires it on many systems)
    hilo_camara()
