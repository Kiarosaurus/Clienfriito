# Firmware del nodo ESP32 (Aula A403)

Firmware del nodo IoT de control térmico, simulado en **Wokwi** dentro de VS Code.
Lee DHT22, MQ-135 y MQ-7, decide **en el propio nodo** qué hacer con el ventilador y el calefactor
(heurística con histéresis + alarma de CO local) y publica todo por **MQTT**.

| Archivo | Qué es |
|---|---|
| [`src/sketch.ino`](src/sketch.ino) | Firmware: sensores, heurística, alarma de CO, log serial y telemetría MQTT |
| [`diagram.json`](diagram.json) | Circuito de Wokwi |
| [`wokwi.toml`](wokwi.toml) | Firmware a simular y puerto serial RFC2217 (4000) |
| [`platformio.ini`](platformio.ini) | Placa `esp32dev`, framework Arduino y librerías |

> En hardware real cambia `DHTTYPE` a `DHT11` y reemplaza las conversiones simuladas del
> MQ-135 (`CO2_PPM_MIN/MAX`) y del MQ-7 por sus curvas de calibración.

## Compilar y simular

1. Abre **esta carpeta** (`hardware/firmware`) en VS Code, o el workspace `ccs.code-workspace` de la raíz.
   PlatformIO y Wokwi necesitan `platformio.ini` y `wokwi.toml` en la raíz de lo que abres.
2. Compila con el **✓ (Build)** de PlatformIO o `pio run`.
3. Abre `diagram.json` y pulsa **▶** (o `Cmd/Ctrl + Shift + P` → *Wokwi: Start Simulator*).

El nodo se conecta al broker en `host.wokwi.internal:1883`, que es tu computador visto desde Wokwi.
Ahí debe estar corriendo Mosquitto (`docker compose up`) o el broker liviano (`tools/broker-local`).

> ⚠️ **Wokwi pausa la simulación cuando VS Code no está a la vista.** Abre el monitor del nodo dentro de
> VS Code (*Simple Browser*) junto al simulador; si no, el nodo se congela y aparece *offline*.

## Escenarios para probar

Haz clic en las piezas del circuito mientras corre la simulación:

| Escenario | Qué hacer | Qué deberías ver |
|---|---|---|
| Aula vacía | Potenciómetro superior (MQ-135) al mínimo | **DISABLED**, todo apagado |
| Hace calor | Aula ocupada y T ≥ 24.5 °C en el DHT22 | **COOLING**: ventilador al 100 %, LED azul |
| Hace frío | Aula ocupada y T ≤ 23.5 °C | **HEATING**: calefactor encendido, LED ámbar |
| Temperatura agradable | 23.5 °C < T < 24.5 °C | **STANDBY**, LED verde |
| Histéresis | Pasar de calor a frío (o al revés) en menos de 60 s | Cambio **retenido** con cuenta regresiva |
| Alarma de CO | Potenciómetro inferior (MQ-7) a más de 50 ppm | **ALARMA CO**: ventilador al 100 %, buzzer, LED rojo |

[`docs/ESTADOS_Y_ESCENARIOS_CS5055.md`](../../docs/ESTADOS_Y_ESCENARIOS_CS5055.md) detalla 15 escenarios con su log esperado.

## Estados y reglas

| Estado | Cuándo | Ventilador | Calefactor | LED RGB |
|---|---|---|---|---|
| **COOLING** | Aula ocupada y T ≥ 24.5 °C | 100 % | OFF | Azul |
| **HEATING** | Aula ocupada y T ≤ 23.5 °C | OFF | ON | Ámbar |
| **STANDBY** | Aula ocupada, entre umbrales o setpoint alcanzado (24.0 °C) | OFF | OFF | Verde |
| **DISABLED** | Aula vacía (MQ-135 < 2200 ADC) | OFF | OFF | Apagado |
| **PRE_COOLING** | Reservado para el modelo de IA (no lo usa este firmware) | 55 % | OFF | Cian |
| **ALARMA CO** | CO ≥ 50 ppm, antes que cualquier otra lógica | 100 % | OFF | Rojo + buzzer |

- **Histéresis:** el ventilador o el calefactor no conmutan dos veces en menos de 60 s.
- **Alarma de CO:** se evalúa en el nodo, sin depender de la red, e ignora la histéresis.
- **Periodo:** mide y publica cada 1 s; el bloque `CICLO` del log sale cada 2 s.
- **Sin red:** sigue controlando el aula y reintenta la conexión MQTT cada 5 s.

## MQTT

| Tópico | Dirección | Contenido |
|---|---|---|
| `ccs/A403/telemetry` | nodo → backend y monitor | JSON por ciclo |
| `ccs/A403/status` | nodo → monitor | `online`; `offline` por *Last Will* (retenido) |
| `ccs/A403/config` | nodo → monitor | Umbrales del firmware (retenido) |
| `ccs/A403/command` | backend → nodo | Reservado (el nodo ya está suscrito) |

```json
{
  "ciclo": 42, "uptime_s": 44.0,
  "temp_c": 25.6, "humedad": 55, "co2_proxy": 3535, "co2_ppm": 1781, "co_ppm": 4,
  "accion": "COOLING", "alarma_co": false,
  "ventilador_pwm": 255, "calefactor": false, "buzzer": false, "led": "AZUL (enfriando)",
  "motivo": "Aula ocupada y T >= 24.5 C: ventilador ON",
  "bloqueo_s": 0, "pendiente": "", "is_simulated": true
}
```

- `co2_proxy` es el ADC crudo del MQ-135 (0–4095) y `co2_ppm` su conversión **simulada** (400–2000 ppm),
  que es lo que usa el backend para estimar la ocupación.
- `bloqueo_s` / `pendiente`: segundos y estado al que pasará mientras la histéresis retiene un cambio.
- `is_simulated: true` hace que el backend separe estas lecturas de las del hardware real.
