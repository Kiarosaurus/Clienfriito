// ── Estados de decisión (docs/hardware-spec.md) ───────────────────────────────
// ON · PRE-COOLING · STANDBY · DISABLED (+ HEATING [CONFIRMAR] si se monta el PTC).
export type DecisionState = 'ON' | 'PRE-COOLING' | 'STANDBY' | 'DISABLED' | 'HEATING'

export interface CognitiveAction {
  // Alias heredado del sistema viejo; se mantiene mientras se migra a `action`.
  ac_status: 'ON' | 'STANDBY' | 'DISABLED'
  cooling_mode: string | null
  target: number | null
  // Omitted by the backend on the no-context path (model: 'none').
  thermal_load_offset?: number
  model: 'ml' | 'heuristic' | 'manual' | 'none'
  // Occupancy telemetry (feed-forward + feedback) — present since Tier 2.
  expected_occupancy?: number | null
  actual_occupancy?: number | null
  effective_occupancy?: number | null
  occupancy_gap?: number | null
  // CS5055 (opcionales): decisión explícita, comando del ventilador y
  // heurística activa vs ML en modo sombra.
  action?: DecisionState | null
  fan_pwm?: number | null
  active_controller?: 'heuristic' | 'ml' | 'manual' | 'none' | null
  heuristic_action?: DecisionState | null
  heuristic_reason?: string | null
  heuristic_target?: number | null
  heuristic_fan_pwm?: number | null
  ml_action?: DecisionState | null
  ml_reason?: string | null
  ml_target?: number | null
  ml_fan_pwm?: number | null
}

export interface RoomContext {
  // Room PKs are strings (e.g. "A403"), mirroring rooms.id in PostgreSQL.
  room_id: string
  room_name: string
  max_capacity: number
  target_temp: number
  expected_people: number | null
}

// Desglose de potencia de UNA lectura calculado por el backend (fuente única,
// misma regla que /reports/roi). Opcional: backends viejos no lo envían.
export interface ReadingPower {
  total_w: number | null
  actuator_w: number | null
  logic_w: number | null
  actuator_measured: boolean
  total_measured: boolean
  actuator_basis?: 'medido' | 'reportado' | 'comandado' | 'inferido' | 'sin dato' | string | null
  source?: 'medido' | 'medido + estimado' | 'estimado' | string | null
  ina219_scope?: 'actuator' | 'node' | string | null
  current_ma?: number | null
  bus_voltage_v?: number | null
}

export interface SensorReadingResponse {
  power?: ReadingPower | null
  sensor_id: string
  anomaly_detected: boolean
  inserted_id: string
  timestamp: string
  cognitive_action: CognitiveAction
  room_context?: RoomContext
}

// Telemetría del nodo ESP32 (topic ccs/<room>/telemetry). Todo opcional:
// si el nodo no lo envía, la UI muestra "sin dato" o "estimado".
export interface NodeTelemetry {
  power_w?: number | null
  current_ma?: number | null
  bus_voltage_v?: number | null
  fan_pwm?: number | null
  heater_on?: boolean | null
  alarm_active?: boolean | null
  node_online?: boolean | null
  rssi_dbm?: number | null
  latency_ms?: number | null
  uptime_s?: number | null
  data_origin?: 'node' | 'simulator' | 'seed' | string | null
}

export interface ReadingInput extends NodeTelemetry {
  sensor_id: string
  temperature: number
  humidity: number
  co2_ppm: number | null
  co_ppm: number | null
  camera_occupancy?: number | null
  is_simulated?: boolean
}

export interface CombinedReading {
  input: ReadingInput
  output: SensorReadingResponse
  sentAt: number
}

// Documento plano devuelto por GET /sensors/ (lectura persistida).
export interface StoredReading extends NodeTelemetry {
  sensor_id: string
  temperature: number
  humidity: number
  co2_ppm: number | null
  co_ppm: number | null
  camera_occupancy?: number | null
  is_simulated?: boolean
  anomaly_detected?: boolean | null
  timestamp: string
  cognitive_action?: CognitiveAction | null
  power?: ReadingPower | null
}

// ── GET /health (aditivo CS5055) ──────────────────────────────────────────────
export type MqttState = 'disabled' | 'connected' | 'disconnected'
export interface HealthInfo {
  status?: string
  engine?: 'ml' | 'heuristic'
  active_controller?: 'heuristic' | 'ml'
  ml_shadow?: boolean
  ml_loaded?: boolean
  // Puente MQTT opcional: ausente en backends viejos → se trata como 'disabled'.
  mqtt?: MqttState
  ingest?: 'http' | 'mqtt+http'
  mqtt_topics?: { telemetry: string; status: string; cmd: string }
  // Último LWT por aula (solo con el puente MQTT activo; persistido en Mongo).
  node_status?: Record<string, { online: boolean; ts: string | null; last_msg_ts?: string | null; restored?: boolean }>
  // Parámetros nominales del modelo de potencia (fuente única en el backend).
  power_model?: {
    node_idle_power_w: number
    buck_efficiency: number
    logic_power_w: number
    fan_max_power_w: number
    heater_power_w: number
    ina219_scope: 'actuator' | 'node' | string
  }
}

// Procedencia declarada de una lectura: 'node' solo con data_origin='node'.
export type ReadingOrigin = 'node' | 'simulado' | 'desconocido'
export type OriginFilter = 'all' | ReadingOrigin
export type OriginCounts = Record<ReadingOrigin, number>

export interface PowerBreakdown {
  actuator_avg_w: number | null
  actuator_source: string
  logic_avg_w: number | null
  logic_source: string
  ina219_scope?: 'actuator' | 'node'
}

// ── GET /reports/node-metrics ─────────────────────────────────────────────────
export interface NodeMetrics {
  window_hours: number
  samples: number
  simulated_samples: number
  origin_counts?: OriginCounts
  origin_counts_all?: OriginCounts
  origin_filter?: OriginFilter
  comfort_band_c?: number
  first_ts: string | null
  last_ts: string | null
  // Disponibilidad (informe, OE2): huecos > 3× periodo nominal entre lecturas
  // consecutivas; las transiciones LWT persistidas se suman aparte.
  availability: {
    source: 'huecos' | 'huecos + LWT' | 'LWT' | string
    uptime_pct: number | null
    sample_loss_pct?: number | null
    drops: number
    lwt_offline_events?: number
    samples: number
    lost_samples?: number
    lost_s?: number | null
    gap_threshold_s?: number | null
    gap_factor?: number
    nominal_period_s?: number | null
    nominal_source?: 'configurado' | 'mediana' | 'sin dato' | string
    ongoing_gap_s?: number | null
    nodes?: number
  } | null
  data_quality: { valid_pct: number | null; valid: number; total: number; median_interval_s: number | null } | null
  latency: {
    p50_ms: number | null; p95_ms: number | null; max_ms: number | null
    samples: number; target_ms: number; within_target_pct: number | null
  } | null
  // Banda única: objetivo CONFIGURADO ± band_c, asimétrica (frío no penaliza).
  comfort: {
    controller_ok_pct?: number | null
    in_band_pct: number | null
    over_band_pct?: number | null
    cold_pct?: number | null
    band_c: number
    band_ref?: string
    samples: number
  } | null
  agreement: {
    match_pct: number | null
    samples: number
    divergences: number
    recent_divergences: {
      timestamp: string
      heuristic_action: string | null
      ml_action: string | null
      heuristic_reason: string | null
      ml_reason: string | null
    }[]
  } | null
  occupancy: { mae_people: number | null; bias_people: number | null; samples: number } | null
  alarm: {
    events: number; time_in_alarm_s: number; local_samples: number
    server_only_samples: number; threshold_ppm: number
  } | null
  fan: {
    cycles: number; closed_cycles: number; min_on_compliance_pct: number | null
    min_on_evaluable?: boolean; min_on_reason?: string | null
    min_on_s: number; avg_pwm_pct: number | null; pwm_source: string
  } | null
  energy: {
    avg_power_w: number | null; energy_wh: number | null; measured_samples: number; source: string
    nodes?: number; weighting?: string; breakdown?: PowerBreakdown
  } | null
  decisions: Record<string, number>
  rssi_avg_dbm?: number | null
}
