// Helpers del nodo ESP32 compartidos por las vistas (CS5055).
// Regla: un campo ausente NUNCA se convierte en un dato; se devuelve null y la
// vista muestra "sin dato" / "estimado".
import type { CognitiveAction, DecisionState, NodeTelemetry, OriginCounts, OriginFilter, ReadingOrigin, ReadingPower } from '../types'

// Potencia del nodo: el frontend NO duplica el modelo. Cada lectura trae su
// desglose calculado por el backend (`power`, misma regla que /reports/roi) y
// los parámetros nominales llegan en /health (`power_model`). [CONFIRMAR P-12]
export const LATENCY_TARGET_MS = 3000
export const CO_ALARM_PPM = 50
// Sin LWT del broker, un nodo pasa a "fuera de línea" si su última lectura es
// más vieja que max(3 × periodo de muestreo, 30 s); sin periodo conocido, 2 min.
export const ONLINE_STALE_MS = 2 * 60_000
export const MIN_STALE_MS = 30_000
// Banda de confort por defecto (la fuente es el backend: comfort_band_c).
export const DEFAULT_COMFORT_BAND_C = 1.0

export function mqttTopic(roomId: string | number | null | undefined, kind: 'telemetry' | 'cmd' | 'status' = 'telemetry') {
  return `ccs/${roomId ?? '<aula>'}/${kind}`
}

export function fmtNum(n: number | null | undefined, unit = '', dec = 1): string {
  return n == null || Number.isNaN(n) ? '—' : `${n.toFixed(dec)}${unit}`
}

// Stored timestamps are naive UTC ("YYYY-MM-DDTHH:MM:SS.ffffff"). Force UTC parse.
// Devuelve null si el timestamp es inválido (se descarta la lectura, no se inventa "ahora").
export function parseUtcMs(ts: string | null | undefined): number | null {
  if (!ts) return null
  const iso = /(Z|[+-]\d\d:?\d\d)$/.test(ts) ? ts : `${ts}Z`
  const ms = Date.parse(iso)
  return Number.isNaN(ms) ? null : ms
}

// ── Estado de decisión ────────────────────────────────────────────────────────
export function decisionOf(action?: Partial<CognitiveAction> | null): DecisionState | null {
  if (!action) return null
  if (action.action) return action.action
  if (action.ac_status === 'ON') return 'ON'   // contrato viejo: sin distinción PRE-COOLING
  if (action.ac_status === 'STANDBY' || action.ac_status === 'DISABLED') return action.ac_status
  return null
}

export const DECISION_TOKENS: Record<DecisionState | 'NONE', { label: string; pill: string; dot: string; desc: string }> = {
  'ON':          { label: 'ON',          pill: 'bg-blue-500/10 border-blue-500/30 text-blue-300',       dot: 'bg-blue-400',    desc: 'Ventilando: temperatura sobre el objetivo ajustado' },
  'PRE-COOLING': { label: 'PRE-COOLING', pill: 'bg-sky-500/10 border-sky-500/30 text-sky-300',          dot: 'bg-sky-400',     desc: 'Ventilación anticipada: reserva próxima y aula aún vacía' },
  'STANDBY':     { label: 'STANDBY',     pill: 'bg-slate-700/50 border-slate-600/60 text-slate-300',    dot: 'bg-slate-400',   desc: 'En espera: temperatura dentro del objetivo' },
  'DISABLED':    { label: 'DISABLED',    pill: 'bg-amber-500/10 border-amber-500/30 text-amber-300',    dot: 'bg-amber-400',   desc: 'Control deshabilitado para este nodo' },
  'HEATING':     { label: 'HEATING',     pill: 'bg-orange-500/10 border-orange-500/30 text-orange-300', dot: 'bg-orange-400',  desc: 'Calefactor PTC activo' },
  'NONE':        { label: 'Sin decisión', pill: 'bg-slate-800 border-slate-700 text-slate-500',         dot: 'bg-slate-600',   desc: 'La lectura no trae acción cognitiva' },
}

export function decisionTokens(state: DecisionState | null) {
  return DECISION_TOKENS[state ?? 'NONE']
}

// ── Procedencia de la lectura ─────────────────────────────────────────────────
// "Nodo físico" SOLO con marca explícita data_origin='node' (la pone el firmware
// o el puente MQTT). Sin marca → "origen no declarado": nunca se asume real.
type OriginLike = { is_simulated?: boolean | null; data_origin?: string | null }

export function isSimulatedReading(r: OriginLike | null | undefined): boolean {
  if (!r) return false
  return r.is_simulated === true || r.data_origin === 'seed' || r.data_origin === 'simulator'
}

export function readingOrigin(r: OriginLike | null | undefined): ReadingOrigin {
  if (isSimulatedReading(r)) return 'simulado'
  if (r?.data_origin === 'node') return 'node'
  return 'desconocido'
}

export function originLabel(r: OriginLike): string {
  if (r.data_origin === 'seed') return 'Simulado (dataset)'
  if (r.is_simulated || r.data_origin === 'simulator') return 'Simulado'
  if (r.data_origin === 'node') return 'Nodo físico'
  return 'Origen no declarado'
}

// ── Enlace MQTT / LWT ─────────────────────────────────────────────────────────
// Prioridad: 1) LWT del broker (`/health.node_status[aula]`, solo con el puente
// MQTT conectado) → cambia a offline apenas el broker publica la última voluntad;
// 2) sin LWT, antigüedad de la última lectura. `node_online` dentro de una
// lectura NO se usa: un nodo caído no publica, así que nunca llegaría un false.
export type LwtEntry = { online: boolean; ts?: string | null }
export type OnlineState = {
  online: boolean | null
  source: 'lwt' | 'inferido' | 'sin dato'
  lastSeenMs: number | null
  staleMs: number
  lwtSinceMs: number | null
}

export function staleThresholdMs(intervalS?: number | null): number {
  return intervalS != null && intervalS > 0 ? Math.max(3 * intervalS * 1000, MIN_STALE_MS) : ONLINE_STALE_MS
}

export function nodeOnline(
  r: { timestamp?: string } | null | undefined,
  nowMs = Date.now(),
  opts: { lwt?: LwtEntry | null; intervalS?: number | null } = {},
): OnlineState {
  const last = parseUtcMs(r?.timestamp)
  const staleMs = staleThresholdMs(opts.intervalS)
  if (opts.lwt && typeof opts.lwt.online === 'boolean') {
    return { online: opts.lwt.online, source: 'lwt', lastSeenMs: last, staleMs, lwtSinceMs: parseUtcMs(opts.lwt.ts ?? null) }
  }
  if (last == null) return { online: null, source: 'sin dato', lastSeenMs: null, staleMs, lwtSinceMs: null }
  return { online: nowMs - last <= staleMs, source: 'inferido', lastSeenMs: last, staleMs, lwtSinceMs: null }
}

// ── Filtro de procedencia con respaldo ────────────────────────────────────────
// Si el usuario no eligió filtro y no hay lecturas marcadas como nodo físico en
// la ventana, se pasa a "Todas" (con aviso visible); si después aparecen, vuelve.
export function originAutoSwitch(o: {
  filter: OriginFilter; touched: boolean; fallback: boolean; samples: number; countsAll?: OriginCounts | null
}): 'all' | 'node' | null {
  const c = o.countsAll
  if (o.touched || !c) return null
  const total = (c.node ?? 0) + (c.simulado ?? 0) + (c.desconocido ?? 0)
  if (o.filter === 'node' && o.samples === 0 && total > 0) return 'all'
  if (o.filter === 'all' && o.fallback && (c.node ?? 0) > 0) return 'node'
  return null
}

export function ago(ms: number | null, nowMs = Date.now()): string {
  if (ms == null) return 'sin dato'
  const s = Math.max(0, Math.round((nowMs - ms) / 1000))
  if (s < 60) return `hace ${s} s`
  if (s < 3600) return `hace ${Math.round(s / 60)} min`
  if (s < 86400) return `hace ${Math.round(s / 3600)} h`
  return `hace ${Math.round(s / 86400)} d`
}

// ── Actuadores ────────────────────────────────────────────────────────────────
// 'reportado' = ciclo PWM aplicado que informa el nodo (no hay tacómetro).
export type Sourced<T> = { value: T | null; source: 'reportado' | 'comandado' | 'estimado' | 'sin dato' }

export function fanPwmOf(r: NodeTelemetry | null | undefined, action?: Partial<CognitiveAction> | null): Sourced<number> {
  if (r?.fan_pwm != null) return { value: r.fan_pwm, source: 'reportado' }
  if (action?.fan_pwm != null) return { value: action.fan_pwm, source: 'comandado' }
  return { value: null, source: 'sin dato' }
}

// Desglose de potencia de la lectura tal como lo calcula el backend (`power`).
// Sin ese bloque (backend viejo) → null: la vista muestra "sin dato".
export function powerOf(r: { power?: ReadingPower | null } | null | undefined): ReadingPower | null {
  return r?.power ?? null
}

export const POWER_BASIS_TEXT: Record<string, string> = {
  medido: 'medido por el INA219',
  reportado: 'sin INA219: nominal del ventilador × PWM reportado',
  comandado: 'sin INA219: nominal del ventilador × PWM comandado',
  inferido: 'sin INA219 ni PWM: cota con ventilador al 100 % (decisión ON)',
  'sin dato': 'sin INA219 ni PWM: rama tomada como 0 W',
}

export function formatDuration(s: number | null | undefined): string {
  if (s == null) return '—'
  if (s < 60) return `${Math.round(s)} s`
  if (s < 3600) return `${Math.round(s / 60)} min`
  return `${(s / 3600).toFixed(1)} h`
}
