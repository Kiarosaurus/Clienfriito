# hardware — Physical Sensor Node (Classroom A403)

Client-side gateway for the physical sensor node. An **Arduino UNO** samples the
environmental sensors and streams them as JSON over USB-Serial; `sistema.py`
(running on a bridge laptop) parses the stream, adds a **camera-based occupancy
count** (MediaPipe Face Detection), converts the MQ-7 raw ADC value to real CO
ppm, and POSTs the merged reading to the deployed backend.

## Components

| Component | Role | Data |
|---|---|---|
| Arduino UNO | Sensor node — samples and emits JSON over Serial (9600 baud, ~2 s) | `{"dht11":{...},"mq135":{...},"mq7":{...}}` |
| DHT11 | Thermal environment | temperature (°C), humidity (%) |
| MQ-135 | Air quality | CO₂-proxy concentration (ppm) → actual occupancy |
| MQ-7 | Safety | CO raw ADC → ppm via datasheet curve (see calibration below) |
| Laptop camera + MediaPipe | Occupancy count | people entering/leaving via virtual-line crossing |

## Data flow

```
Arduino UNO ──Serial JSON (~2 s)──► sistema.py ──HTTPS POST──► /api/v1/sensors/
                                        ▲                        (kiarosaurus.me)
                            laptop camera + MediaPipe
                            (occupancy line-crossing count)
```

The backend responds with the `cognitive_action` computed for the reading
(`ac_status`, adjusted target, thermal load offset), which the script logs.

The camera count travels as `camera_occupancy` — the CURRENT headcount (not the
room's max capacity, not the reservation plan). The backend persists it next to
the CO₂-derived `actual_occupancy`, so the mass-balance proxy can be validated
and re-calibrated against a direct measurement.

## Running

```bash
pip install pyserial mediapipe opencv-python requests
python sistema.py
```

Before running, adjust in `sistema.py`:

- `SERIAL_PORT` — `COM3`/`COM6` on Windows, `/dev/ttyUSB0`/`/dev/ttyACM0` on Linux/Mac.
- `SENSOR_ID` — must match a device registered in the web app (seed convention: `s-<room>`, e.g. `s-A403`).
- `API_KEY` — required only when the server sets `WATSON_EXTENSION_KEY`.
- `IS_SIMULATED` — set `True` for test traffic so the backend buckets it as simulated.

## MQ-7 calibration

The MQ-7 needs a one-time clean-air calibration to fix `R0`:

1. Set `CALIBRATE_MQ7 = True` and run the script in clean air ~5 min (sensor pre-heated).
2. Average the printed "suggested R0" values and copy the result into `MQ7_R0`.
3. Set `CALIBRATE_MQ7 = False`. Conversion then follows the datasheet log-log curve
   `ppm = A · (Rs/R0)^B`.

Press `q` in the camera window to quit.
