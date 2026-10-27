import { useState, useEffect, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import {
  ComposedChart, Area, Line, LineChart, Scatter, XAxis, YAxis, CartesianGrid,
  Tooltip, Legend, ResponsiveContainer, ReferenceLine, ReferenceArea,
} from 'recharts'
import { CalendarClock } from 'lucide-react'
import {
  ArrowLeft, Building2, RefreshCw, AlertCircle, Cpu, Radio, SlidersHorizontal,
  WifiOff, CloudFog, Thermometer, Droplets, Wind, Users, BrainCircuit, Bot, Sigma,
  Inbox, LineChart as LineChartIcon, Fan, Activity, GitCompare, FlaskConical, Siren,
  Network, type LucideIcon,
} from 'lucide-react'
import api, { getApiErrorDetail } from '../api/client'
import { useAuth } from '../context/AuthContext'
import { MetricCard } from '../components/MetricCard'
import { EmptyState } from '../components/EmptyState'
import {
  getColorTemp, getColorHumedad, getColorCO2, getColorCO,
  levelTemp, levelHumedad, levelCO2, levelCO, getStatusLabel,
  LEVEL_TO_STATUS, levelTone, NEUTRAL_TEXT,
} from '../utils/sensorColors'
import type { NodeMetrics, OriginFilter, StoredReading } from '../types'
import {
  decisionOf, fanPwmOf, fmtNum, isSimulatedReading, readingOrigin, parseUtcMs, CO_ALARM_PPM,
  DEFAULT_COMFORT_BAND_C, originAutoSwitch,
} from '../utils/node'
import {
  DecisionBadge, NodeLinkBadge, SimulatedBadge, OriginBadge, OriginToggle, originSummary,
  ActuatorPanel, NodeLinkPanel, NodeKpiGrid, HeuristicVsMl, AlarmOverrideBadge, overrideNote,
  OriginFallbackNotice, intervalOf,
} from '../components/NodeWidgets'
import { useHealth, useNow, updatedAgo } from '../utils/live'

const PILOT_ROOM = 'A403'   // único nodo físico (docs/hardware-spec.md)
// Refresco en vivo (FE-2-03): lecturas 10 s, indicadores 30 s, línea de tiempo 60 s.
const READINGS_POLL_MS = 10_000
const METRICS_POLL_MS = 30_000
const TIMELINE_POLL_MS = 60_000

interface RoomInfo {
  // Room PKs are strings in PostgreSQL (e.g. "A403").
  id: string
  name: string
  max_capacity: number
  target_temp: number
  control_policy: string   // auto | heuristic | manual
}

// ── Cognitive-policy modes ────────────────────────────────────────────────────
// Backend enum: control_policy = auto | heuristic | manual (sin cambios en la API).
// Spec CS5055: la heurística controla el ventilador; el ML corre en modo sombra.
const POLICY_CARDS: { value: string; label: string; desc: string; Icon: LucideIcon }[] = [
  {
    value: 'auto',
    label: 'Automática',
    Icon: Bot,
    desc: 'La heurística decide el ventilador. El modelo ML corre en paralelo en modo sombra: su decisión se registra para comparar, pero no actúa. Recomendado para operación normal.',
  },
  {
    value: 'heuristic',
    label: 'Solo heurística',
    Icon: Sigma,
    desc: 'Fija la heurística como controlador aunque el servidor desactive el modo sombra. Objetivo ajustado por ocupación esperada y CO₂ medido; predecible y sin dependencia del modelo.',
  },
  {
    value: 'manual',
    label: 'Manual',
    Icon: SlidersHorizontal,
    desc: 'El ventilador sigue la temperatura objetivo fijada por el administrador, sin ajuste por ocupación. Solo para mantenimiento o pruebas.',
  },
]

function PolicyCard({
  card, selected, disabled, onSelect,
}: {
  card: { value: string; label: string; desc: string; Icon: LucideIcon }
  selected: boolean
  disabled?: boolean
  onSelect: (val: string) => void
}) {
  const { Icon } = card
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => onSelect(card.value)}
      className={`relative w-full text-left flex items-start gap-3 rounded-xl border p-4 transition-colors ${
        selected
          ? 'border-violet-500/60 bg-violet-500/5'
          : 'border-slate-700 bg-slate-800/40 hover:bg-slate-800 hover:border-slate-600'
      } ${disabled ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer'}`}
    >
      <Icon size={20} className={`shrink-0 mt-0.5 ${selected ? 'text-violet-400' : 'text-slate-400'}`} />
      <div className="min-w-0">
        <p className="text-sm font-semibold text-slate-100">{card.label}</p>
        <p className="text-xs text-slate-400 leading-relaxed mt-1">{card.desc}</p>
      </div>
      {selected && (
        <span className="absolute top-3 right-3 inline-flex items-center text-[10px] font-medium text-violet-300 bg-violet-500/10 border border-violet-500/30 rounded-full px-2 py-0.5">
          Activo
        </span>
      )}
    </button>
  )
}

interface SensorDevice {
  sensor_id: string
  room_id: string
  is_active: boolean
  control_enabled: boolean
  _updating?: boolean
}

function Toggle({
  checked, onChange, disabled, label, sublabel,
}: {
  checked: boolean
  onChange: (val: boolean) => void
  disabled?: boolean
  label: string
  sublabel?: string
}) {
  return (
    <div className={`flex items-center justify-between gap-3 py-2 ${disabled ? 'opacity-50' : ''}`}>
      <div>
        <p className="text-xs font-medium text-slate-300">{label}</p>
        {sublabel && <p className="text-xs text-slate-500">{sublabel}</p>}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => !disabled && onChange(!checked)}
        className={`relative w-11 h-6 rounded-full transition-colors shrink-0 ${
          disabled ? 'cursor-not-allowed' : 'cursor-pointer'
        } ${checked ? 'bg-blue-600' : 'bg-slate-600'}`}
      >
        <span
          className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${
            checked ? 'translate-x-5' : 'translate-x-0'
          }`}
        />
      </button>
    </div>
  )
}

function Section({ icon, title, right, children }: {
  icon: React.ReactNode; title: string; right?: React.ReactNode; children: React.ReactNode
}) {
  return (
    <div className="bg-slate-800 border border-slate-700 rounded-xl p-5">
      <div className="flex items-center justify-between gap-3 mb-4 flex-wrap">
        <h2 className="flex items-center gap-2 text-slate-300 text-sm font-semibold uppercase tracking-wide">
          {icon} {title}
        </h2>
        {right}
      </div>
      {children}
    </div>
  )
}

// ── 24h Timeline types ────────────────────────────────────────────────────────

interface TimelineReservation {
  id: number
  username: string | null
  expected_occupancy: number
  start_time: string
  end_time: string
}

interface TimelineAc {
  status: string | null
  setpoint?: number | null
  suggested_setpoint?: number | null
  configured_setpoint: number
  cooling_mode?: string | null
  model?: string | null
  action?: string | null
}

interface TimelinePoint {
  hour: string
  phase: 'past' | 'current' | 'future'
  reservation: TimelineReservation | null
  actual_temperature?: number | null
  actual_humidity?: number | null
  actual_co_ppm?: number | null
  readings_count?: number
  // Procedencia del bucket (aditivo): lecturas simuladas / marcadas como nodo físico.
  simulated_count?: number
  node_count?: number
  predicted_temperature?: number | null
  // Legacy field — not plotted anymore (a 12 V fan cannot hold the setpoint).
  projected_temperature?: number | null
  fan_pwm?: number | null
  planned_fan_pwm?: number | null
  expected_people?: number
  ac: TimelineAc
}

interface TimelineResponse {
  room_id: string
  room_name: string
  target_temp: number
  generated_at: string
  window: { start: string; end: string }
  baseline_temp: number
  baseline_source?: string
  comfort_band_c?: number
  timeline: TimelinePoint[]
}

interface TimelineRow {
  time: string
  hour_iso: string
  phase: 'past' | 'current' | 'future'
  temperatura_real: number | null
  temperatura_proyectada: number | null
  fan_pwm_real: number | null
  fan_pwm_plan: number | null
  reserva_icon: number | null
  reservation: TimelineReservation | null
  expected_people: number
  readings_count: number
  simulated_count: number
  decision: string | null
}

interface ReservationSpan {
  reservation: TimelineReservation
  x1: string
  x2: string
  isPast: boolean
}

const formatHourLabel = (iso: string) =>
  new Date(iso).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' })

const formatClock = (iso: string) =>
  new Date(iso).toLocaleString('es', {
    hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit',
  })

function CustomTooltip({ active, payload }: { active?: boolean; payload?: Array<{ payload: TimelineRow }> }) {
  if (!active || !payload?.length) return null
  const row = payload[0].payload
  const phaseLabel = row.phase === 'past' ? 'Pasado' : row.phase === 'current' ? 'Ahora' : 'Futuro'
  return (
    <div className="bg-slate-900/95 border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-200 shadow-xl min-w-[210px]">
      <div className="flex items-center justify-between mb-1.5 pb-1.5 border-b border-slate-700/70">
        <span className="text-slate-100 font-semibold">{row.time}</span>
        <span className="text-[10px] uppercase tracking-wider text-slate-400">{phaseLabel}</span>
      </div>
      {row.temperatura_real != null && (
        <p>Registrada: <span className="text-blue-300 font-semibold">{row.temperatura_real.toFixed(2)}°C</span>
          <span className="text-slate-500"> · {row.readings_count} lect.</span>
          {row.readings_count > 0 && row.simulated_count > 0 && (
            <span className="text-amber-400"> · {Math.round(100 * row.simulated_count / row.readings_count)} % simulada</span>
          )}</p>
      )}
      {row.fan_pwm_real != null && (
        <p>Ventilador (promedio): <span className="text-sky-300 font-semibold">{row.fan_pwm_real.toFixed(0)} %</span></p>
      )}
      {row.temperatura_proyectada != null && (
        <p>Proyectada (simulada): <span className="text-amber-300 font-semibold">{row.temperatura_proyectada.toFixed(2)}°C</span></p>
      )}
      {row.phase === 'future' && (
        <p className="text-slate-300">
          Decisión prevista: <span className="font-semibold">{row.decision ?? '—'}</span>
          {row.fan_pwm_plan != null && <span className="text-sky-300"> · PWM {row.fan_pwm_plan.toFixed(0)} %</span>}
        </p>
      )}
      {row.reservation && (
        <div className="mt-2 pt-2 border-t border-slate-700 text-emerald-300 leading-snug space-y-0.5">
          <p>
            Reserva de{' '}
            <span className="font-semibold text-emerald-200">{row.reservation.username ?? '—'}</span>
          </p>
          <p className="text-emerald-200/90">
            {formatClock(row.reservation.start_time)} → {formatClock(row.reservation.end_time)}
          </p>
          <p>
            Aforo esperado:{' '}
            <span className="font-semibold text-emerald-200">{row.reservation.expected_occupancy}</span> personas
          </p>
        </div>
      )}
    </div>
  )
}

const CHART_TOOLTIP = { backgroundColor: '#1e293b', border: '1px solid #334155', borderRadius: '8px', color: '#e2e8f0', fontSize: 12 }

export default function RoomDetail() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { user } = useAuth()
  const isGuest = user?.role === 'guest'

  const [room, setRoom] = useState<RoomInfo | null>(null)
  const [readings, setReadings] = useState<StoredReading[]>([])
  const [devices, setDevices] = useState<SensorDevice[]>([])
  const [timeline, setTimeline] = useState<TimelineResponse | null>(null)
  const [metrics, setMetrics] = useState<NodeMetrics | null>(null)
  const { data: health } = useHealth()
  const now = useNow(5_000)
  const [lastUpdated, setLastUpdated] = useState<number | null>(null)
  const [originFilter, setOriginFilter] = useState<OriginFilter>(id === PILOT_ROOM ? 'node' : 'all')
  const [originTouched, setOriginTouched] = useState(false)
  const [originFallback, setOriginFallback] = useState(false)
  const changeOrigin = useCallback((v: OriginFilter) => {
    setOriginTouched(true); setOriginFallback(false); setOriginFilter(v)
  }, [])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [controlError, setControlError] = useState<string | null>(null)
  const [policySaving, setPolicySaving] = useState(false)

  // Carga inicial: aula + nodos registrados.
  useEffect(() => {
    if (!id) return
    setLoading(true)
    setError(null)
    setOriginFilter(id === PILOT_ROOM ? 'node' : 'all')
    setOriginTouched(false); setOriginFallback(false)
    const fallbackDevices = { data: [] as SensorDevice[] }
    Promise.all([
      api.get<RoomInfo>(`/admin/rooms/${id}`),
      api.get<SensorDevice[]>('/admin/devices').catch(() => fallbackDevices),
    ])
      .then(([roomRes, devicesRes]) => {
        setRoom(roomRes.data)
        setDevices((devicesRes.data ?? []).filter(d => d.room_id === id))
      })
      .catch(err => setError(getApiErrorDetail(err) ?? 'Error cargando datos del aula.'))
      .finally(() => setLoading(false))
  }, [id])

  // Lecturas en vivo (10 s). Lecturas con timestamp inválido se descartan (no se inventa "ahora").
  const fetchReadings = useCallback(async (isCancelled: () => boolean) => {
    if (!id) return
    try {
      const { data } = await api.get<StoredReading[]>(`/sensors/?room_id=${encodeURIComponent(id)}&limit=60`)
      if (isCancelled()) return
      setReadings((data ?? []).filter(r => parseUtcMs(r.timestamp) != null))
      setLastUpdated(Date.now())
    } catch { /* se conserva el último estado; el badge cae a offline por antigüedad */ }
  }, [id])

  useEffect(() => {
    if (!id) return
    let cancelled = false
    const isCancelled = () => cancelled
    fetchReadings(isCancelled)
    const t = setInterval(() => fetchReadings(isCancelled), READINGS_POLL_MS)
    return () => { cancelled = true; clearInterval(t) }
  }, [id, fetchReadings])

  // Indicadores derivados (30 s), con filtro de procedencia.
  useEffect(() => {
    if (!id) return
    let cancelled = false
    const load = () => api.get<NodeMetrics>('/reports/node-metrics', { params: { room_id: id, hours: 24, origin: originFilter } })
      .then(res => {
        if (cancelled) return
        const data = res.data ?? null
        // Sin lecturas del nodo físico → "Todas" con aviso visible (FE-3-03).
        const sw = data ? originAutoSwitch({ filter: originFilter, touched: originTouched, fallback: originFallback, samples: data.samples, countsAll: data.origin_counts_all }) : null
        if (sw) { setOriginFallback(sw === 'all'); setOriginFilter(sw); return }
        setMetrics(data)
      })
      .catch(() => { if (!cancelled) setMetrics(null) })
    load()
    const t = setInterval(load, METRICS_POLL_MS)
    return () => { cancelled = true; clearInterval(t) }
  }, [id, originFilter, originTouched, originFallback])

  // Línea de tiempo 24 h (60 s).
  useEffect(() => {
    if (!id) return
    let cancelled = false
    const load = () => api.get<TimelineResponse>(`/admin/rooms/${id}/timeline`)
      .then(res => { if (!cancelled) setTimeline(res.data ?? null) })
      .catch(() => { if (!cancelled) setTimeline(null) })
    load()
    const t = setInterval(load, TIMELINE_POLL_MS)
    return () => { cancelled = true; clearInterval(t) }
  }, [id])

  async function handleToggle(
    sensorId: string,
    field: 'is_active' | 'control_enabled',
    value: boolean,
  ) {
    setControlError(null)
    setDevices(prev =>
      prev.map(d =>
        d.sensor_id === sensorId ? { ...d, [field]: value, _updating: true } : d
      )
    )

    const device = devices.find(d => d.sensor_id === sensorId)
    if (!device) return

    const payload = {
      is_active: field === 'is_active' ? value : device.is_active,
      control_enabled: field === 'control_enabled' ? value : device.control_enabled,
    }

    try {
      const { data } = await api.put<SensorDevice>(`/sensors/${sensorId}/control`, payload)
      setDevices(prev =>
        prev.map(d =>
          d.sensor_id === sensorId
            ? { ...d, is_active: data.is_active, control_enabled: data.control_enabled, _updating: false }
            : d
        )
      )
    } catch (err: unknown) {
      setDevices(prev =>
        prev.map(d =>
          d.sensor_id === sensorId
            ? { ...d, is_active: device.is_active, control_enabled: device.control_enabled, _updating: false }
            : d
        )
      )
      const detail = getApiErrorDetail(err)
      setControlError(detail ?? 'Error al actualizar el nodo.')
    }
  }

  async function handlePolicyChange(value: string) {
    setControlError(null)
    const prev = room?.control_policy
    setRoom(r => (r ? { ...r, control_policy: value } : r))
    setPolicySaving(true)
    try {
      await api.put(`/admin/rooms/${id}/policy`, { control_policy: value })
    } catch (err: unknown) {
      setRoom(r => (r ? { ...r, control_policy: prev ?? 'auto' } : r))
      const detail = getApiErrorDetail(err)
      setControlError(detail ?? 'No se pudo cambiar la política de control.')
    } finally {
      setPolicySaving(false)
    }
  }

  const hasSensors = devices.length > 0 || readings.length > 0
  const policy = room?.control_policy ?? 'auto'

  const latest = readings[0] ?? null
  const action = latest?.cognitive_action ?? null
  const decision = decisionOf(action)
  const fan = fanPwmOf(latest, action)
  const allSimulated = readings.length > 0 && readings.every(isSimulatedReading)
  const someSimulated = readings.some(isSimulatedReading)
  const unknownOrigin = readings.filter(r => readingOrigin(r) === 'desconocido').length
  const override = overrideNote(latest, action)
  const nodeId = latest?.sensor_id ?? devices[0]?.sensor_id ?? null
  const targetTemp = timeline?.target_temp ?? room?.target_temp ?? null

  // Controlador real (no se asume): lo dice la lectura; si no, /health.
  const controller = action?.active_controller ?? (action?.model && action.model !== 'none' ? action.model : null)
  const controllerLabel = controller === 'ml' ? 'ML' : controller === 'manual' ? 'manual' : controller === 'heuristic' ? 'heurística' : 'sin dato'
  const mlLoaded = health?.ml_loaded ?? (health?.engine ? health.engine === 'ml' : null)

  const policyStatus =
    policy === 'manual'
      ? `Modo manual · objetivo fijado en ${room?.target_temp ?? '—'}°C por el administrador`
      : `${policy === 'heuristic' ? 'Modo solo heurística' : 'Modo automático'} · controla: ${controllerLabel} · ML: ${
          mlLoaded == null ? 'estado desconocido' : mlLoaded ? 'en sombra (cargado)' : 'no cargado'
        }`

  // Alarm: local (node buzzer/LED) vs server-side inference (co_ppm > 50).
  const localAlarm = latest?.alarm_active === true
  const serverAlarm = !localAlarm && latest?.co_ppm != null && latest.co_ppm > CO_ALARM_PPM

  // Sensor series (chronological) — temp/hum and CO₂/CO. Respeta el filtro de
  // procedencia de los KPI: no mezcla en una curva lecturas de otro origen (FE-3-11).
  const seriesSrc = originFilter === 'all' ? readings : readings.filter(r => readingOrigin(r) === originFilter)
  const seriesSim = seriesSrc.filter(isSimulatedReading).length
  const seriesUnknown = seriesSrc.filter(r => readingOrigin(r) === 'desconocido').length
  const series = [...seriesSrc].reverse().map(r => ({
    time: new Date(parseUtcMs(r.timestamp) as number).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' }),
    temperatura: r.temperature,
    humedad: r.humidity,
    co2: r.co2_ppm,
    co: r.co_ppm,
    ventilador: fanPwmOf(r, r.cognitive_action).value,
  }))

  // Occupancy: reservation (plan) vs CO₂ estimate vs camera (validation).
  const occExpected = action?.expected_occupancy ?? null
  const occCo2 = action?.actual_occupancy ?? null
  const occCam = latest?.camera_occupancy ?? null
  const occError = occCo2 != null && occCam != null ? occCo2 - occCam : null

  // Build 24h rows from /timeline. Past = measured; future = simulated diurnal model.
  const timelineRows: TimelineRow[] = (timeline?.timeline ?? []).map(p => {
    const isPast = p.phase === 'past' || p.phase === 'current'
    return {
      time: formatHourLabel(p.hour),
      hour_iso: p.hour,
      phase: p.phase,
      temperatura_real: isPast ? (p.actual_temperature ?? null) : null,
      temperatura_proyectada: !isPast ? (p.predicted_temperature ?? null) : null,
      fan_pwm_real: isPast ? (p.fan_pwm ?? null) : null,
      fan_pwm_plan: !isPast ? (p.planned_fan_pwm ?? null) : null,
      reserva_icon: null,
      reservation: p.reservation,
      expected_people: p.expected_people ?? 0,
      readings_count: p.readings_count ?? 0,
      simulated_count: p.simulated_count ?? 0,
      decision: p.ac?.action ?? p.ac?.status ?? null,
    }
  })

  // Banda de confort ÚNICA: la define el backend (misma que el KPI), sobre el objetivo configurado.
  const TARGET_TOL = timeline?.comfort_band_c ?? metrics?.comfort_band_c ?? DEFAULT_COMFORT_BAND_C
  // Sin objetivo configurado no se dibuja banda ni línea de objetivo (no se inventa un valor).
  const tgt: number | null = timeline?.target_temp ?? room?.target_temp ?? null
  const tempPool = timelineRows
    .flatMap(r => [r.temperatura_real, r.temperatura_proyectada])
    .filter((v): v is number => v != null)
    .concat(tgt != null ? [tgt - TARGET_TOL, tgt + TARGET_TOL] : [])
  const minT = tempPool.length ? Math.min(...tempPool) : 15
  const maxT = tempPool.length ? Math.max(...tempPool) : 30
  const reservaY = maxT + 1.5
  const yDomain: [number, number] = [Math.floor(minT - 1), Math.ceil(reservaY + 0.5)]

  const reservationSpans: ReservationSpan[] = []
  const nowMs = timeline ? new Date(timeline.generated_at).getTime() : Date.now()
  for (const row of timelineRows) {
    const res = row.reservation
    if (!res) continue
    const last = reservationSpans[reservationSpans.length - 1]
    if (last && last.reservation.id === res.id) {
      last.x2 = row.time
    } else {
      row.reserva_icon = reservaY
      reservationSpans.push({
        reservation: res,
        x1: row.time,
        x2: row.time,
        isPast: new Date(res.end_time).getTime() <= nowMs,
      })
    }
  }
  const nowLabel = timelineRows.find(r => r.phase === 'current')?.time

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-slate-400 py-12 justify-center">
        <RefreshCw size={16} className="animate-spin" /> Cargando…
      </div>
    )
  }

  const tLvl = latest && targetTemp != null ? levelTemp(latest.temperature, action?.target ?? targetTemp) : null
  const timelineSimPct = (() => {
    const tot = timelineRows.reduce((a, r) => a + (r.phase !== 'future' ? r.readings_count : 0), 0)
    const sim = timelineRows.reduce((a, r) => a + (r.phase !== 'future' ? r.simulated_count : 0), 0)
    return tot > 0 ? Math.round(100 * sim / tot) : null
  })()
  const hLvl = latest ? levelHumedad(latest.humidity) : null
  const c2Lvl = latest?.co2_ppm != null ? levelCO2(latest.co2_ppm) : null
  const coLvl = latest?.co_ppm != null ? levelCO(latest.co_ppm) : null

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-4 flex-wrap">
        <button
          onClick={() => navigate('/rooms')}
          className="p-2 rounded-lg text-slate-400 hover:text-slate-100 hover:bg-slate-700 transition-colors"
        >
          <ArrowLeft size={18} />
        </button>
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-blue-600/20 border border-blue-500/30 flex items-center justify-center">
            <Building2 size={20} className="text-blue-400" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-white">{room?.name}</h1>
            <p className="text-xs text-slate-400">Capacidad: {room?.max_capacity} · Temperatura objetivo: {room?.target_temp}°C</p>
          </div>
        </div>
        <div className="flex items-center gap-2 ml-auto flex-wrap">
          {hasSensors && <NodeLinkBadge reading={latest} now={now} roomId={room?.id ?? id} intervalS={intervalOf(metrics)} />}
          {allSimulated ? <SimulatedBadge reading={latest} /> : latest && <OriginBadge reading={latest} />}
          <span className="flex items-center gap-1 text-[11px] text-slate-500" title="Lecturas cada 10 s · indicadores cada 30 s · línea de tiempo cada 60 s">
            <RefreshCw size={11} /> {updatedAgo(lastUpdated, now)}
          </span>
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-2 bg-red-900/30 border border-red-500/40 rounded-lg px-4 py-3 text-sm text-red-300">
          <AlertCircle size={16} className="shrink-0" /> {error}
        </div>
      )}

      {!error && !hasSensors && (
        <div className="flex flex-col items-center justify-center gap-5 bg-slate-800 border border-slate-700 rounded-xl px-8 py-16 text-center">
          <div className="w-16 h-16 rounded-full bg-slate-700/60 border border-slate-600 flex items-center justify-center">
            <WifiOff size={28} className="text-slate-500" />
          </div>
          <div className="space-y-2 max-w-sm">
            <h3 className="text-slate-200 font-semibold text-base">Aula sin nodo</h3>
            <p className="text-slate-400 text-sm leading-relaxed">
              No hay un nodo ESP32 asignado a esta aula. Asígnelo desde Infraestructura para comenzar a recibir su telemetría.
            </p>
          </div>
        </div>
      )}

      {!error && hasSensors && <>

      {/* Banners — procedencia y alarma */}
      {allSimulated && (
        <div className="flex items-start gap-2 bg-amber-900/30 border border-amber-500/40 rounded-xl px-4 py-3 text-sm text-amber-300">
          <FlaskConical size={15} className="shrink-0 mt-0.5" />
          <span><strong>Aula simulada.</strong> Todas las lecturas mostradas son sintéticas; el único nodo físico está en el aula piloto A403.</span>
        </div>
      )}
      {!allSimulated && someSimulated && (
        <div className="flex items-center gap-2 bg-amber-900/20 border border-amber-500/30 rounded-xl px-4 py-2.5 text-xs text-amber-300">
          <FlaskConical size={13} className="shrink-0" /> Algunas lecturas son simuladas; se marcan en la tabla.
        </div>
      )}
      {unknownOrigin > 0 && (
        <div className="flex items-center gap-2 bg-slate-800 border border-slate-600 rounded-xl px-4 py-2.5 text-xs text-slate-400">
          <AlertCircle size={13} className="shrink-0" />
          {unknownOrigin} de {readings.length} lecturas no declaran procedencia (data_origin): se muestran como “origen no declarado”, no como nodo físico.
        </div>
      )}
      {(localAlarm || serverAlarm) && (
        <div className="flex items-center gap-3 bg-red-900/40 border border-red-500/50 rounded-xl px-4 py-3">
          <Siren size={20} className="text-red-400 shrink-0" />
          <span className="text-sm text-red-200">
            {localAlarm
              ? <><strong>Alarma local activa en el nodo</strong> · buzzer y LED encendidos · ventilador al 100 % (override: decisión del servidor {decision ?? 'sin decisión'} ignorada)</>
              : <><strong>CO sobre {CO_ALARM_PPM} ppm detectado por el servidor</strong> · el nodo no reportó alarma local</>}
            {' '}· CO {fmtNum(latest?.co_ppm, ' ppm', 1)}
          </span>
        </div>
      )}

      {/* Estado + magnitudes */}
      <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-4">
        <div className="col-span-2 lg:col-span-1 bg-slate-800/60 border border-slate-700/60 border-l-4 border-l-blue-500 rounded-xl p-4 flex flex-col gap-3">
          <div className="flex items-start justify-between gap-2">
            <span className="w-9 h-9 rounded-lg ring-1 bg-blue-500/10 ring-blue-500/30 text-blue-400 flex items-center justify-center">
              <Fan size={18} />
            </span>
            <div className="flex flex-col items-end gap-1">
              <DecisionBadge state={decision} />
              <AlarmOverrideBadge reading={latest} />
            </div>
          </div>
          <div>
            <p className="text-xs text-slate-400">Decisión · ventilador</p>
            <p className="text-2xl font-bold leading-tight text-white tabular-nums">{fmtNum(fan.value, ' %', 0)}</p>
          </div>
          <p className="text-xs text-slate-500">{override ?? `PWM ${fan.source} · controla: ${controllerLabel}`}</p>
        </div>

        <MetricCard
          icon={<Thermometer size={18} />} label="Temperatura"
          value={fmtNum(latest?.temperature, '', 1)} unit={latest ? '°C' : undefined}
          status={tLvl ? LEVEL_TO_STATUS[tLvl] : 'normal'} tone={tLvl ? levelTone(tLvl) : undefined}
          statusText={tLvl ? getStatusLabel(tLvl) : undefined}
          sub={latest ? `Objetivo ajustado: ${fmtNum(action?.target, '°C')}` : 'Sin datos'}
        />
        <MetricCard
          icon={<Droplets size={18} />} label="Humedad"
          value={fmtNum(latest?.humidity, '', 0)} unit={latest ? '%' : undefined}
          status={hLvl ? LEVEL_TO_STATUS[hLvl] : 'normal'} tone={hLvl ? levelTone(hLvl) : undefined}
          statusText={hLvl ? getStatusLabel(hLvl) : undefined}
          sub={latest ? 'DHT11' : 'Sin datos'}
        />
        <MetricCard
          icon={<Wind size={18} />} label="CO₂ (relativo)"
          value={fmtNum(latest?.co2_ppm, '', 0)} unit={latest?.co2_ppm != null ? 'ppm' : undefined}
          status={c2Lvl ? LEVEL_TO_STATUS[c2Lvl] : 'normal'} tone={c2Lvl ? levelTone(c2Lvl) : undefined}
          statusText={c2Lvl ? getStatusLabel(c2Lvl) : undefined}
          sub={latest?.co2_ppm != null ? 'MQ-135 · proxy de ocupación' : 'Sin dato'}
        />
        <MetricCard
          icon={<CloudFog size={18} />} label="Monóxido de carbono (CO)"
          value={fmtNum(latest?.co_ppm, '', 1)} unit={latest?.co_ppm != null ? 'ppm' : undefined}
          status={coLvl ? LEVEL_TO_STATUS[coLvl] : 'normal'} tone={coLvl ? levelTone(coLvl) : undefined}
          statusText={coLvl ? getStatusLabel(coLvl) : undefined}
          sub={latest?.co_ppm != null ? `MQ-7 · alarma > ${CO_ALARM_PPM} ppm` : 'Sin dato'}
        />
        <div className="bg-slate-800/60 border border-slate-700/60 border-l-4 border-l-indigo-500 rounded-xl p-4 flex flex-col gap-2">
          <span className="w-9 h-9 rounded-lg ring-1 bg-indigo-500/10 ring-indigo-500/30 text-indigo-400 flex items-center justify-center">
            <Users size={18} />
          </span>
          <p className="text-xs text-slate-400">Ocupación</p>
          <div className="text-xs text-slate-300 space-y-0.5 tabular-nums">
            <p>Reservada: <strong className="text-white">{occExpected ?? '—'}</strong></p>
            <p>Estimada CO₂: <strong className="text-white">{fmtNum(occCo2, '', 0)}</strong></p>
            <p>Cámara: <strong className="text-white">{occCam ?? '—'}</strong></p>
          </div>
          <p className="text-[11px] text-slate-500">
            {occError != null ? `Error CO₂ − cámara: ${occError > 0 ? '+' : ''}${occError.toFixed(0)} pers.` : 'Sin conteo de cámara para validar'}
          </p>
        </div>
      </div>

      {/* Indicadores de funcionamiento */}
      <Section
        icon={<Activity size={15} className="text-emerald-400" />}
        title="Indicadores de funcionamiento · últimas 24 h"
        right={<OriginToggle value={originFilter} onChange={changeOrigin} />}
      >
        <OriginFallbackNotice active={originFallback && originFilter === 'all'} />
        {metrics && <p className="text-[11px] text-slate-500 -mt-2 mb-3">{originSummary(metrics)}</p>}
        <NodeKpiGrid metrics={metrics} />
      </Section>

      {/* Actuadores + enlace */}
      <Section icon={<Fan size={15} className="text-sky-400" />} title="Actuadores del nodo">
        <ActuatorPanel reading={latest} action={action} />
      </Section>
      <Section icon={<Network size={15} className="text-blue-400" />} title="Nodo ESP32 y enlace">
        <NodeLinkPanel roomId={room?.id ?? id} sensorId={nodeId} reading={latest} metrics={metrics} now={now} />
      </Section>

      {/* Heurística vs ML */}
      <Section icon={<GitCompare size={15} className="text-violet-400" />} title="Heurística vs ML (sombra)">
        <HeuristicVsMl action={action} metrics={metrics} mlLoaded={mlLoaded} />
      </Section>

      {/* Series de sensores */}
      <Section
        icon={<LineChartIcon size={15} className="text-sky-400" />}
        title={`Series de sensores · últimas ${series.length} lecturas${originFilter === 'node' ? ' del nodo físico' : ''}${seriesSim > 0 ? ` (${seriesSim} simuladas)` : ''}${seriesUnknown > 0 ? ` (${seriesUnknown} sin origen declarado)` : ''}`}
      >
        {series.length === 0 ? (
          <p className="text-sm text-slate-500">
            {readings.length > 0 && originFilter !== 'all'
              ? 'Sin lecturas del nodo físico entre las últimas recibidas: cambia a “Todas” para graficar las de otro origen.'
              : 'Sin lecturas para graficar.'}
          </p>
        ) : (
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={series} margin={{ top: 5, right: 5, left: -10, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                <XAxis dataKey="time" stroke="#64748b" tick={{ fontSize: 10 }} minTickGap={28} />
                <YAxis yAxisId="t" stroke="#64748b" tick={{ fontSize: 10 }} domain={['dataMin - 1', 'dataMax + 1']} allowDecimals={false} />
                <YAxis yAxisId="p" orientation="right" stroke="#64748b" tick={{ fontSize: 10 }} domain={[0, 100]} />
                <Tooltip contentStyle={CHART_TOOLTIP} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Line yAxisId="t" dataKey="temperatura" name="Temperatura (°C)" stroke="#38bdf8" dot={false} strokeWidth={2} connectNulls={false} isAnimationActive={false} />
                <Line yAxisId="p" dataKey="humedad" name="Humedad (%)" stroke="#a855f7" dot={false} strokeWidth={1.5} connectNulls={false} isAnimationActive={false} />
                <Line yAxisId="p" dataKey="ventilador" name="Ventilador (%)" stroke="#22c55e" dot={false} strokeWidth={1.5} strokeDasharray="4 3" connectNulls={false} isAnimationActive={false} />
              </LineChart>
            </ResponsiveContainer>
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={series} margin={{ top: 5, right: 5, left: -10, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                <XAxis dataKey="time" stroke="#64748b" tick={{ fontSize: 10 }} minTickGap={28} />
                <YAxis yAxisId="c2" stroke="#64748b" tick={{ fontSize: 10 }} />
                <YAxis yAxisId="co" orientation="right" stroke="#64748b" tick={{ fontSize: 10 }} />
                <Tooltip contentStyle={CHART_TOOLTIP} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <ReferenceLine yAxisId="co" y={CO_ALARM_PPM} stroke="#ef4444" strokeDasharray="4 2" strokeOpacity={0.6} />
                <Line yAxisId="c2" dataKey="co2" name="CO₂ (ppm)" stroke="#eab308" dot={false} strokeWidth={2} connectNulls={false} isAnimationActive={false} />
                <Line yAxisId="co" dataKey="co" name="CO (ppm)" stroke="#f97316" dot={false} strokeWidth={1.5} connectNulls={false} isAnimationActive={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
      </Section>

      {/* Política cognitiva */}
      <div className="bg-slate-800 border border-slate-700 rounded-xl p-5">
        <div className="flex items-center justify-between mb-4">
          <h2 className="flex items-center gap-2 text-slate-300 text-sm font-semibold uppercase tracking-wide">
            <BrainCircuit size={15} className="text-violet-400" /> Política cognitiva
          </h2>
          {isGuest && (
            <span className="text-xs text-amber-400 bg-amber-900/30 border border-amber-500/30 px-2 py-0.5 rounded-full">
              Solo lectura
            </span>
          )}
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
          {POLICY_CARDS.map(card => (
            <PolicyCard
              key={card.value}
              card={card}
              selected={policy === card.value}
              disabled={isGuest || policySaving}
              onSelect={handlePolicyChange}
            />
          ))}
        </div>
        <p className="flex items-center gap-1.5 text-[13px] text-slate-500 mt-4">
          {policySaving && <RefreshCw size={12} className="animate-spin shrink-0" />}
          {policyStatus}
        </p>
      </div>

      {/* Gestión de nodos */}
      <div className="bg-slate-800 border border-slate-700 rounded-xl p-5">
        <div className="flex items-center justify-between mb-4">
          <h2 className="flex items-center gap-2 text-slate-300 text-sm font-semibold uppercase tracking-wide">
            <SlidersHorizontal size={15} className="text-blue-400" /> Gestión del nodo
          </h2>
          {isGuest && (
            <span className="text-xs text-amber-400 bg-amber-900/30 border border-amber-500/30 px-2 py-0.5 rounded-full">
              Solo lectura
            </span>
          )}
        </div>

        {controlError && (
          <div className="flex items-center gap-2 bg-red-900/30 border border-red-500/40 rounded-lg px-3 py-2 text-xs text-red-300 mb-4">
            <AlertCircle size={13} className="shrink-0" /> {controlError}
          </div>
        )}

        {devices.length === 0 ? (
          <div className="flex items-center gap-2 text-slate-500 text-sm py-4">
            <Cpu size={16} /> No hay nodos registrados para esta aula.
          </div>
        ) : (
          <div className="space-y-3">
            {devices.map(device => (
              <div key={device.sensor_id} className="bg-slate-700/40 border border-slate-700 rounded-lg px-4 py-3">
                <div className="flex items-center gap-2 mb-3 pb-2 border-b border-slate-700/60">
                  <Radio size={13} className={device.is_active ? 'text-emerald-400' : 'text-slate-500'} />
                  <span className="font-mono text-xs font-semibold text-slate-200">{device.sensor_id}</span>
                  <span className="text-[10px] text-slate-500">Nodo ESP32</span>
                  {device._updating && (
                    <RefreshCw size={11} className="animate-spin text-slate-400 ml-auto" />
                  )}
                </div>
                <div className="divide-y divide-slate-700/40">
                  <Toggle
                    label="Recibir datos"
                    sublabel="El nodo publica telemetría y el sistema la registra"
                    checked={device.is_active}
                    disabled={isGuest || !!device._updating}
                    onChange={v => handleToggle(device.sensor_id, 'is_active', v)}
                  />
                  <Toggle
                    label="Controlar actuadores"
                    sublabel="El sistema puede comandar ventilador y PTC (si no, decisión DISABLED)"
                    checked={device.control_enabled}
                    disabled={isGuest || !!device._updating}
                    onChange={v => handleToggle(device.sensor_id, 'control_enabled', v)}
                  />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 24h Timeline */}
      <div className="bg-slate-800 rounded-xl p-5">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-slate-300 text-sm font-semibold uppercase tracking-wide">
            Línea de tiempo 24 h
          </h2>
          {timeline && (
            <span className="text-xs text-slate-500">
              Generado {new Date(timeline.generated_at).toLocaleTimeString('es')}
              {timelineSimPct != null && timelineSimPct > 0 && (
                <span className="text-amber-400"> · {timelineSimPct} % de las lecturas pasadas son simuladas</span>
              )}
            </span>
          )}
        </div>
        {timelineRows.length === 0 ? (
          <div className="h-72 flex items-center justify-center">
            <EmptyState
              icon={<LineChartIcon size={22} />}
              title="Sin línea de tiempo disponible"
              hint="La línea de tiempo se construye a partir de lecturas y reservas. Aparecerá en cuanto el aula registre actividad."
            />
          </div>
        ) : (
          <>
            <ResponsiveContainer width="100%" height={320}>
              <ComposedChart data={timelineRows} margin={{ top: 24, right: 8, left: 0, bottom: 8 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                <XAxis dataKey="time" stroke="#64748b" tick={{ fontSize: 11 }} interval="preserveStartEnd" minTickGap={32} />
                <YAxis yAxisId="t" stroke="#64748b" tick={{ fontSize: 11 }} domain={yDomain} allowDecimals={false} />
                <YAxis yAxisId="pwm" orientation="right" stroke="#64748b" tick={{ fontSize: 11 }} domain={[0, 100]} unit="%" />
                {tgt != null && (
                  <ReferenceArea
                    yAxisId="t"
                    y1={tgt - TARGET_TOL}
                    y2={tgt + TARGET_TOL}
                    fill="#22c55e"
                    fillOpacity={0.14}
                    stroke="#22c55e"
                    strokeOpacity={0.38}
                    ifOverflow="extendDomain"
                  />
                )}
                {tgt != null && (
                  <ReferenceLine
                    yAxisId="t"
                    y={tgt}
                    stroke="#22c55e"
                    strokeDasharray="2 4"
                    strokeOpacity={0.55}
                    label={{ value: `Objetivo ${tgt}°C`, fill: '#4ade80', position: 'insideTopRight', fontSize: 10 }}
                  />
                )}
                {reservationSpans.map((s, i) => (
                  <ReferenceArea
                    key={`res-${s.reservation.id}-${i}`}
                    yAxisId="t"
                    x1={s.x1}
                    x2={s.x2}
                    fill={s.isPast ? '#64748b' : '#6366f1'}
                    fillOpacity={s.isPast ? 0.07 : 0.14}
                    stroke={s.isPast ? '#64748b' : '#6366f1'}
                    strokeOpacity={s.isPast ? 0.3 : 0.38}
                    strokeDasharray="3 3"
                  />
                ))}
                <Tooltip content={<CustomTooltip />} cursor={{ stroke: '#475569', strokeDasharray: '2 2' }} />
                {nowLabel && (
                  <ReferenceLine
                    yAxisId="t"
                    x={nowLabel}
                    stroke="#eab308"
                    strokeDasharray="3 3"
                    label={{ value: 'AHORA', fill: '#eab308', position: 'top', fontSize: 11 }}
                  />
                )}
                {/* Pasado — temperatura medida + PWM promedio del ventilador */}
                <Area yAxisId="t" type="monotone" dataKey="temperatura_real" stroke="#38bdf8" fill="#38bdf8"
                  fillOpacity={0.15} strokeWidth={2} connectNulls={false} isAnimationActive={false} />
                <Line yAxisId="pwm" type="stepAfter" dataKey="fan_pwm_real" stroke="#22c55e" strokeWidth={1.5}
                  dot={false} connectNulls={false} isAnimationActive={false} />
                {/* Futuro — proyección del modelo diurno (simulada) + PWM planificado */}
                <Area yAxisId="t" type="monotone" dataKey="temperatura_proyectada" stroke="#f97316" fill="#f97316"
                  fillOpacity={0.12} strokeWidth={2} strokeDasharray="4 3" connectNulls={false} isAnimationActive={false} />
                <Line yAxisId="pwm" type="stepAfter" dataKey="fan_pwm_plan" stroke="#22c55e" strokeOpacity={0.6}
                  strokeDasharray="5 4" strokeWidth={1.5} dot={false} connectNulls={false} isAnimationActive={false} />
                <Scatter
                  yAxisId="t"
                  dataKey="reserva_icon"
                  shape={(props: { cx?: number; cy?: number }) => {
                    if (props.cx == null || props.cy == null) return <g />
                    return (
                      <g>
                        <circle cx={props.cx} cy={props.cy} r={9} fill="#1e1b4b" stroke="#6366f1" strokeWidth={1.5} />
                        <CalendarClock x={props.cx - 6} y={props.cy - 6} width={12} height={12} color="#818cf8" />
                      </g>
                    )
                  }}
                />
              </ComposedChart>
            </ResponsiveContainer>
            <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-slate-400 border-t border-slate-700 pt-3">
              <span className="flex items-center gap-2">
                <span className="inline-block w-4 h-2 rounded-sm bg-sky-400/20 border border-sky-400" />
                <span>Temperatura registrada (promedio horario; ver % simulada en el detalle)</span>
              </span>
              <span className="flex items-center gap-2">
                <span className="inline-block w-4 h-2 rounded-sm bg-orange-500/20 border border-dashed border-orange-500" />
                <span>Temperatura proyectada (modelo diurno, simulada)</span>
              </span>
              <span className="flex items-center gap-2">
                <span className="inline-block w-5 border-t-2 border-green-500" />
                <span>Ventilador PWM % (reportado por el nodo o comandado, eje derecho)</span>
              </span>
              <span className="flex items-center gap-2">
                <span className="inline-block w-5 border-t-2 border-dashed border-green-500/60" />
                <span>Ventilador PWM % (planificado)</span>
              </span>
              <span className="flex items-center gap-2">
                <span className="inline-block w-4 h-2 rounded-sm bg-green-500/20 border border-green-500/60" />
                <span>{tgt != null
                  ? `Banda de confort: objetivo configurado ±${TARGET_TOL}°C (bajo la banda = aula fría, no penaliza al ventilador)`
                  : 'Objetivo no configurado: sin banda de confort'}</span>
              </span>
              <span className="flex items-center gap-2">
                <CalendarClock size={13} className="text-indigo-400" />
                <span>Reserva (intervalo · esperada/cumplida)</span>
              </span>
              <span className="flex items-center gap-2 text-yellow-500/90">
                <span className="inline-block w-5 border-t border-dashed border-yellow-500" />
                <span>AHORA</span>
              </span>
            </div>
          </>
        )}
      </div>

      {/* Readings table */}
      <div className="bg-slate-800 rounded-xl p-5 overflow-x-auto">
        <h2 className="text-slate-300 text-sm font-semibold uppercase tracking-wide mb-4">Últimas lecturas</h2>
        {readings.length === 0 ? (
          <EmptyState
            icon={<Inbox size={22} />}
            title="Sin lecturas todavía"
            hint="Cuando el nodo de esta aula publique telemetría, las últimas lecturas aparecerán aquí."
            action={{ label: 'Enviar una lectura desde el Dashboard', onClick: () => navigate('/') }}
          />
        ) : (
          <table className="w-full min-w-[820px] text-sm">
            <thead>
              <tr className="text-slate-400 text-xs uppercase border-b border-slate-700">
                {['Nodo', 'Origen', 'Temp', 'Humedad', 'CO₂', 'CO', 'Ventilador', 'Decisión', 'Fecha y hora'].map(h => (
                  <th key={h} className="text-left pb-2 pr-4">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {readings.slice(0, 20).map(r => {
                const st = decisionOf(r.cognitive_action)
                const fp = fanPwmOf(r, r.cognitive_action)
                return (
                  <tr key={`${r.sensor_id}-${r.timestamp}`} className="border-b border-slate-700/50">
                    <td className="py-2 pr-4 font-mono text-slate-300 text-xs">{r.sensor_id}</td>
                    <td className="py-2 pr-4"><OriginBadge reading={r} compact /></td>
                    <td className={`py-2 pr-4 font-semibold ${(r.cognitive_action?.target ?? tgt) != null ? getColorTemp(r.temperature, (r.cognitive_action?.target ?? tgt) as number) : NEUTRAL_TEXT}`}>
                      {fmtNum(r.temperature, '°C')}
                    </td>
                    <td className={`py-2 pr-4 font-semibold ${getColorHumedad(r.humidity)}`}>{fmtNum(r.humidity, '%')}</td>
                    <td className={`py-2 pr-4 font-semibold ${r.co2_ppm != null ? getColorCO2(r.co2_ppm) : NEUTRAL_TEXT}`}>{fmtNum(r.co2_ppm, '', 0)}</td>
                    <td className={`py-2 pr-4 font-semibold ${r.co_ppm != null ? getColorCO(r.co_ppm) : NEUTRAL_TEXT}`}>
                      {fmtNum(r.co_ppm, ' ppm', 1)}
                    </td>
                    <td className="py-2 pr-4 text-slate-300 tabular-nums">
                      {fmtNum(fp.value, ' %', 0)}{fp.source === 'comandado' && <span className="text-[10px] text-slate-500"> cmd</span>}
                    </td>
                    <td className="py-2 pr-4"><DecisionBadge state={st} /></td>
                    <td className="py-2 text-slate-400 text-xs">{new Date(parseUtcMs(r.timestamp) as number).toLocaleString('es')}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>

      </>}
    </div>
  )
}
