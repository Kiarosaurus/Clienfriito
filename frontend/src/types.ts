export interface CognitiveAction {
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
}

export interface RoomContext {
  // Room PKs are strings (e.g. "A403"), mirroring rooms.id in PostgreSQL.
  room_id: string
  room_name: string
  max_capacity: number
  target_temp: number
  expected_people: number | null
}

export interface SensorReadingResponse {
  sensor_id: string
  anomaly_detected: boolean
  inserted_id: string
  timestamp: string
  cognitive_action: CognitiveAction
  room_context?: RoomContext
}

export interface ReadingInput {
  sensor_id: string
  temperature: number
  humidity: number
  co2_ppm: number
  co_ppm: number
  is_simulated?: boolean
}

export interface CombinedReading {
  input: ReadingInput
  output: SensorReadingResponse
  sentAt: number
}
