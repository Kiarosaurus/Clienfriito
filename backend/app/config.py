import os
import secrets

MONGO_URI = os.getenv("MONGO_URI", "mongodb://mongo:27017")
POSTGRES_URI = os.getenv(
    "POSTGRES_URI",
    "postgresql://postgres:postgres@localhost:5432/climate_db",
)

# IBM Watson Assistant
WATSON_API_KEY = os.getenv("WATSON_API_KEY", "")
WATSON_URL = os.getenv("WATSON_URL", "")
WATSON_ASSISTANT_ID = os.getenv("WATSON_ASSISTANT_ID", "")

# Watson Custom Extension API key (protects /sensors and /chat endpoints)
WATSON_EXTENSION_KEY = os.getenv("WATSON_EXTENSION_KEY", "")

# Initial password for the auto-seeded 'admin' account. The default is ONLY
# acceptable for local development — production deployments MUST set it.
ADMIN_PASSWORD = os.getenv("ADMIN_PASSWORD", "admin")

# JWT
SECRET_KEY = os.getenv("SECRET_KEY") or secrets.token_hex(32)
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = int(os.getenv("ACCESS_TOKEN_EXPIRE_MINUTES", "15"))

# Deployment timezone offset from UTC (whole hours), used to phase-align the diurnal
# temperature drift so its peak lands in the local afternoon. Default -5 = America/Lima
# (Barranco, UTEC — no DST). Override via env for other deployments.
LOCAL_UTC_OFFSET_HOURS = int(os.getenv("LOCAL_UTC_OFFSET_HOURS", "-5"))

# ── CS5055: nodo ESP32 (heurística activa + ML en sombra) ─────────────────────
# Spec (docs/hardware-spec.md): la heurística decide el actuador; el modelo ML
# corre en paralelo en modo sombra (solo se compara, no actúa). Poner "0" para
# volver al comportamiento previo (política "auto" = ML si hay modelo cargado).
ML_SHADOW_MODE = os.getenv("ML_SHADOW_MODE", "1") not in ("0", "false", "False")

# Potencias NOMINALES del nodo, usadas SOLO cuando una lectura no trae medición
# INA219 (power_w). El frontend las etiqueta "estimado". [CONFIRMAR con hardware]
#   idle  ≈ ESP32 con WiFi (~0.5 W) + calentadores MQ-135 (~0.8 W) y MQ-7 (~0.35 W)
#   fan   ≈ ventilador DC 12 V a 100 % PWM (~0.2 A)
#   heater= calefactor PTC 12 V (0 = no montado / sin dato)
NODE_IDLE_POWER_W = float(os.getenv("NODE_IDLE_POWER_W", "1.65"))
FAN_MAX_POWER_W = float(os.getenv("FAN_MAX_POWER_W", "2.4"))
HEATER_POWER_W = float(os.getenv("HEATER_POWER_W", "0"))

# Eficiencia del regulador buck 12 V → 5 V que alimenta la electrónica (ESP32 +
# calentadores MQ + DHT11). La potencia de la lógica vista desde la fuente de 12 V
# es NODE_IDLE_POWER_W / BUCK_EFFICIENCY. [CONFIRMAR P-12 con el regulador real]
BUCK_EFFICIENCY = float(os.getenv("BUCK_EFFICIENCY", "0.85"))

# Dónde está el shunt del INA219. Spec/informe: provisionalmente en la RAMA DEL
# ACTUADOR (ventilador/PTC), así que power_w NO es la potencia total del nodo:
#   "actuator" → total = power_w (medido) + lógica nominal (estimado)
#   "node"     → total = power_w (shunt en la entrada de 12 V, todo medido)
INA219_SCOPE = os.getenv("INA219_SCOPE", "actuator").strip().lower()
if INA219_SCOPE not in ("actuator", "node"):
    INA219_SCOPE = "actuator"

# Banda de confort ÚNICA (KPI, línea de tiempo y leyendas la leen del backend).
# Referencia: temperatura objetivo CONFIGURADA del aula. Asimétrica: por encima
# de objetivo + banda penaliza al controlador; por debajo de objetivo − banda es
# "aula fría, fuera de alcance del actuador" (un ventilador no calienta).
COMFORT_BAND_C = float(os.getenv("COMFORT_BAND_C", "1.0"))

# ── Puente MQTT (opcional, desactivado por defecto) ───────────────────────────
# Solo se activa si MQTT_BROKER_URL está definida, p. ej. mqtt://broker:1883.
# Topics de la spec [CONFIRMAR nombres exactos con el firmware]:
#   <prefijo>/<aula>/telemetry  (nodo → backend)
#   <prefijo>/<aula>/status     (LWT online/offline)
#   <prefijo>/<aula>/cmd        (backend → nodo, retenido)
MQTT_BROKER_URL = os.getenv("MQTT_BROKER_URL", "").strip()
MQTT_TOPIC_PREFIX = os.getenv("MQTT_TOPIC_PREFIX", "ccs").strip().strip("/") or "ccs"
MQTT_CLIENT_ID = os.getenv("MQTT_CLIENT_ID", "ccs-backend")
MQTT_USERNAME = os.getenv("MQTT_USERNAME", "")
MQTT_PASSWORD = os.getenv("MQTT_PASSWORD", "")

# Tarifa eléctrica configurable por env. Valor por defecto REFERENCIAL: pliego
# Luz del Sur LDS2026-10, tarifa BT5B, con IGV = S/ 0.7556 por kWh. La tarifa
# real que paga UTEC está por confirmar (ENERGY_TARIFF_CONFIRMED=1 al confirmarla).
ENERGY_COST_PER_KWH = float(os.getenv("ENERGY_COST_PER_KWH", "0.7556"))
ENERGY_CURRENCY = os.getenv("ENERGY_CURRENCY", "PEN")
ENERGY_TARIFF_LABEL = os.getenv(
    "ENERGY_TARIFF_LABEL",
    "Luz del Sur LDS2026-10, BT5B con IGV (referencial, a confirmar UTEC)",
)
ENERGY_TARIFF_CONFIRMED = os.getenv("ENERGY_TARIFF_CONFIRMED", "0") in ("1", "true", "True")

# Objetivo de latencia sensado→actuación (spec: < 3 s).
LATENCY_TARGET_MS = 3000

# Periodo nominal de muestreo del nodo (s). Disponibilidad (informe, OE2): una
# muestra se da por perdida cuando el hueco entre dos lecturas consecutivas supera
# 3× este periodo. 0 = estimarlo como la mediana de los intervalos observados.
# [CONFIRMAR con el periodo real del firmware]
NODE_SAMPLE_PERIOD_S = float(os.getenv("NODE_SAMPLE_PERIOD_S", "0")) or None
GAP_FACTOR = 3.0

# Encendido mínimo del ventilador: regla del FIRMWARE (spec); el backend solo la
# verifica, y únicamente si el muestreo es ≤ este valor.
FAN_MIN_ON_S = 60.0
