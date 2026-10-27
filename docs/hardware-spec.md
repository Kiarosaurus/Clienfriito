# Especificación de hardware — FUENTE DE VERDAD

Todo agente que toque frontend, backend, diagramas o informe se alinea a ESTE archivo.
Origen: `informe/informe-proyecto-iot.pdf` (Perfil P1, §5) + `hardware/README.md`.
Ítems marcados **[CONFIRMAR]** = supuestos razonables pendientes de validar con el equipo;
no se presentan como hechos en el informe hasta confirmarse (ver `informe/PENDIENTES.md`).

## Cambio de arquitectura (viejo → nuevo)

| Aspecto | Sistema viejo (código actual) | Sistema nuevo (CS5055) |
|---|---|---|
| MCU | Arduino UNO (ADC 10 bit) | **ESP32 DevKit** (ADC 12 bit, WiFi integrado) |
| Enlace | USB-Serial → laptop `sistema.py` → HTTPS POST | **MQTT sobre WiFi**, QoS 1, LWT, retained cmd |
| Actuador | AC central (simulado, `ac_status`) | **Ventilador DC 12 V PWM** + **buzzer + LED RGB** + **PTC 12 V** [adicional] |
| Decisión | heurística / ML | heurística = activa; ML = **modo sombra** (comparación lado a lado) |
| Costos | AC 2.5 kW, "Tradicional vs Cognitivo" (AC 24/7) | **consumo propio del nodo** (medido INA219), sin baseline AC |

## Sensores (≥3 exigidos por rúbrica)

| # | Sensor | Mide | Interfaz ESP32 | Carácter |
|---|---|---|---|---|
| 1 | DHT11 | temperatura °C, humedad % | digital 1-wire (GPIO) | vital |
| 2 | MQ-135 | calidad aire → proxy CO2 (ppm relativo) → ocupación estimada | analógico **ADC1** (GPIO32–39; ADC2 no usable con WiFi) vía divisor 5 V→3.3 V | vital |
| 3 | MQ-7 | CO ppm (R0 calibrado aire limpio); canal de seguridad local | analógico ADC1 vía divisor | vital |
| 4 | INA219 (o ACS712) | corriente, tensión, potencia del actuador | **I2C** (0x40) | adicional |
| 5 | Cámara + MediaPipe | conteo personas (cruce de línea) en equipo externo | fuera del nodo (HTTP/MQTT desde laptop) | externo, valida ocupación CO2 |

## Actuadores (≥1 exigido; LCD no cuenta)

| # | Actuador | Control | Disparo |
|---|---|---|---|
| 1 | Ventilador DC 12 V | MOSFET logic-level (o relé) + diodo flyback, **PWM** 0–100 % | comando MQTT de la heurística |
| 2 | Buzzer + LED RGB | GPIO digital | **local**: CO > 50 ppm, sin red; fuerza ventilador 100 % |
| 3 | Calefactor PTC cerámico 12 V | MOSFET/relé | decisión calentar [CONFIRMAR si se monta] |

## Alimentación (P1 perdió puntos por omitirla — SIEMPRE explícita)

- Fuente DC 12 V → ventilador, PTC (rama potencia).
- Regulador buck 12 V → 5 V → heaters MQ-135/MQ-7, DHT11 [CONFIRMAR], ESP32 VIN.
- LDO ESP32 5 V → 3.3 V lógica. Tierras comunes. [CONFIRMAR corriente fuente según PTC]
- Todo ≤ 12 V DC; nunca 220 V AC.

## MQTT [CONFIRMAR nombres exactos con firmware]

| Topic | Dir | Payload |
|---|---|---|
| `ccs/<room>/telemetry` | nodo → broker | temp, hum, co2_ppm, co_ppm, power_w, current_ma, bus_v, fan_pwm, heater_on, alarm_active, rssi_dbm, uptime_s |
| `ccs/<room>/cmd` (retained) | backend → nodo | action, fan_pwm, heater_on, reason |
| `ccs/<room>/status` (LWT) | broker | `online` / `offline` |

## Estados de decisión

`ON`, `PRE-COOLING`, `STANDBY`, `DISABLED` (P1). Con PTC: añadir `HEATING` [CONFIRMAR].
Histéresis ±0.5 °C, encendido mínimo 60 s. Latencia objetivo sensado→actuación < 3 s.
Fail-safe: sin conexión → CO evaluado localmente, actuador a estado seguro.

## Campos de datos para frontend (contrato aditivo — campos opcionales)

Lectura: `temperature, humidity, co2_ppm, co_ppm, camera_occupancy` (ya existen) +
`power_w, current_ma, bus_voltage_v, fan_pwm, heater_on, alarm_active, node_online, rssi_dbm, latency_ms`.
Decisión: `heuristic_action`, `ml_action` (sombra), `heuristic_reason`, `ml_reason`, `active_controller`,
`thermal_load_offset`, `expected/actual/effective_occupancy`.
Compatibilidad: `ac_status` existente se mantiene como alias hasta migrar; no romper endpoints.

## Costos (para dashboard y speech del video)

- Mostrar: kWh y costo del **propio nodo** por día / mes / año, potencia medida (INA219) o
  nominal etiquetada "estimado" si no hay medición.
- Mensaje: "el gasto es tan poco que ni se siente".
- **PROHIBIDO**: comparar contra AC encendido 24/7, "Tradicional vs Cognitivo", `AC_POWER_KW`.
- Permitido: energía heurística vs ML-sombra (misma ventana) — es comparación interna del nodo.
- Tarifa y moneda configurables [CONFIRMAR: S/ por kWh vigente vs USD 0.15 actual].

## Despliegue

1 nodo físico en aula piloto A403 UTEC Barranco; demás aulas simuladas (`is_simulated`).
