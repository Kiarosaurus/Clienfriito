import { useState, useEffect, useMemo, type ReactNode } from 'react'
import { useParams, Link, useSearchParams } from 'react-router-dom'
import {
  ComposedChart, LineChart, Area, Line, Scatter, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, ReferenceLine, ReferenceArea,
} from 'recharts'
import { ArrowLeft, RefreshCw, AlertTriangle, CalendarClock, Cpu, BrainCircuit } from 'lucide-react'
import api, { getApiErrorDetail } from '../api/client'
import { useAuth } from '../context/AuthContext'
import type { StoredReading } from '../types'
import { levelTemp, levelHumedad, levelCO2, levelCO, getStatusLabel } from '../utils/sensorColors'
import {
  Card, Chip, Kpi, Tabs, LEVEL_TONE, NODE_STATE, AI_STATE, MODEL_LABEL, LIVE_SECONDS, NODE_SETPOINT,
  fmt, parseUtc, timeAgo, clockTime, valueText, type Tone,
} from '../components/ui'

// ── Types ─────────────────────────────────────────────────────────────────────
interface RoomInfo {
  id: string
  name: string
  max_capacity: number
  target_temp: number
  control_policy: string   // auto | heuristic | manual
}

interface SensorDevice {
  sensor_id: string
  room_id: string
  is_active: boolean
  control_enabled: boolean
  _updating?: boolean
}

interface TimelineReservation {
  id: number
  username: string | null
  expected_occupancy: number
  start_time: string
  end_time: string
}

interface TimelinePoint {
  hour: string
  phase: 'past' | 'current' | 'future'
  reservation: TimelineReservation | null
  actual_temperature?: number | null
  readings_count?: number
  predicted_temperature?: number | null
  projected_temperature?: number | null
  expected_people?: number
  ac: { status: string | null; setpoint?: number | null; cooling_mode?: string | null }
}

interface TimelineResponse {
  target_temp: number
  generated_at: string
  timeline: TimelinePoint[]
}

interface TimelineRow {
  time: string
  phase: 'past' | 'current' | 'future'
  temperatura_real: number | null
  temperatura_sin_ac: number | null
  temperatura_con_ac: number | null
  ac_setpoint: number | null
  reserva_icon: number | null
  reservation: TimelineReservation | null
  ac_status: string | null
  cooling_mode: string | null
}

type Tab = 'actual' | 'historial' | 'config'

const POLL_MS = 5_000
const READINGS_LIMIT = 200
// Recent charts show a time window ending at the latest reading, so old sessions
// (e.g. seed data from another day) are never joined to the live line.
const WINDOW_MIN = 10
// Rooms without a live node only have sparse (e.g. hourly) readings: widen to 24 h.
const MIN_POINTS = 10
const FALLBACK_H = 24

// Node thresholds (hardware/firmware/src/sketch.ino): fan ON at T >= 24.5 °C,
// heater ON at T <= 23.5 °C, both OFF back at the 24.0 °C setpoint.
const NODE_COOL_ON = 24.5
const NODE_HEAT_ON = 23.5

const POLICIES: { value: string; label: string; desc: string }[] = [
  { value: 'auto', label: 'Automática', desc: 'Usa el modelo ML si está cargado; si no, la fórmula heurística. Recomendada.' },
  { value: 'heuristic', label: 'Solo heurística', desc: 'Siempre la fórmula de ocupación esperada y CO₂ medido. Más predecible.' },
  { value: 'manual', label: 'Manual', desc: 'El administrador fija el setpoint, sin adaptación. Para mantenimiento.' },
]

// ── Node vs AI ────────────────────────────────────────────────────────────────
// Both are reduced to "should the room be cooled?". The AI does not control the
// heater, so the node's HEATING counts as "no enfriar", like STANDBY.
type Intent = 'enfriar' | 'no-enfriar' | 'apagado'
function nodeIntent(accion?: string): Intent | null {
  if (!accion) return null
  if (accion === 'COOLING' || accion === 'PRE_COOLING') return 'enfriar'
  if (accion === 'DISABLED') return 'apagado'
  return 'no-enfriar'
}
function aiIntent(status?: string): Intent | null {
  if (!status) return null
  if (status === 'ON') return 'enfriar'
  if (status === 'DISABLED') return 'apagado'
  return 'no-enfriar'
}

// ── Small pieces ──────────────────────────────────────────────────────────────
const tickTime = (ms: number) => new Date(ms).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
const formatHour = (iso: string) => new Date(iso).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' })
const formatClock = (iso: string) =>
  new Date(iso).toLocaleString('es', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' })

const AXIS = { stroke: '#475569', tick: { fontSize: 11, fill: '#94a3b8' } }
// Chart palette: one data color (sky), slate for comparisons, status colors only for thresholds.
const C = { data: '#38bdf8', compare: '#94a3b8', grid: '#1e293b', ok: '#34d399', warn: '#fbbf24', high: '#fb923c', alert: '#f87171' }
const TOOLTIP_STYLE = { backgroundColor: '#0f172a', border: '1px solid #1e293b', borderRadius: 8, fontSize: 12, color: '#e2e8f0' }

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1 text-sm">
      <span className="text-slate-400">{label}</span>
      <span className="text-right text-slate-100">{children}</span>
    </div>
  )
}

function Toggle({ checked, onChange, disabled, label }: {
  checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label: string
}) {
  return (
    <label className={`flex items-center gap-2 text-xs text-slate-300 ${disabled ? 'opacity-50' : 'cursor-pointer'}`}>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${checked ? 'bg-blue-600' : 'bg-slate-700'}`}
      >
        <span className={`absolute left-0 top-0.5 h-4 w-4 rounded-full bg-white transition-transform ${checked ? 'translate-x-4' : 'translate-x-0.5'}`} />
      </button>
      {label}
    </label>
  )
}

// One chart per magnitude: same height, time axis and tooltip.
function MiniChart({ title, data, dataKey, unit, color, domain, refs = [] }: {
  title: string
  data: { t: number }[]
  dataKey: string
  unit: string
  color: string
  domain?: [number | string, number | string]
  refs?: { y: number; label: string; color: string; pos?: 'insideTopRight' | 'insideBottomRight' | 'insideTopLeft' | 'insideBottomLeft' }[]
}) {
  // Seconds only matter for short windows.
  const sparse = data.length < 30
  const spanMs = data.length > 1 ? data[data.length - 1].t - data[0].t : 0
  const tickFmt = (ms: number) => spanMs > 3_600_000
    ? new Date(ms).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' })
    : tickTime(ms)
  return (
    <Card title={title}>
      <ResponsiveContainer width="100%" height={150}>
        <LineChart data={data} margin={{ top: 4, right: 8, left: -12, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={C.grid} />
          <XAxis dataKey="t" type="number" scale="time" domain={['dataMin', 'dataMax']} tickFormatter={tickFmt} minTickGap={48} {...AXIS} />
          <YAxis domain={domain ?? ['auto', 'auto']} width={48} tickFormatter={v => `${+Number(v).toFixed(1)}`} {...AXIS} />
          <Tooltip
            contentStyle={TOOLTIP_STYLE}
            labelFormatter={v => tickTime(Number(v))}
            formatter={(v: number) => [`${v.toFixed(1)} ${unit}`, title]}
          />
          {refs.map(r => (
            <ReferenceLine key={r.label} y={r.y} stroke={r.color} strokeDasharray="4 4" strokeOpacity={0.7} ifOverflow="extendDomain"
              label={{ value: r.label, fill: r.color, fontSize: 10, position: r.pos ?? 'insideTopRight' }} />
          ))}
          <Line type={sparse ? 'linear' : 'monotone'} dataKey={dataKey} stroke={color} strokeWidth={2} dot={sparse ? { r: 2 } : false} isAnimationActive={false} connectNulls />
        </LineChart>
      </ResponsiveContainer>
    </Card>
  )
}

function TimelineTooltip({ active, payload }: { active?: boolean; payload?: Array<{ payload: TimelineRow }> }) {
  if (!active || !payload?.length) return null
  const row = payload[0].payload
  const phase = row.phase === 'past' ? 'Medido' : row.phase === 'current' ? 'Ahora' : 'Proyección'
  return (
    <div className="surface min-w-[200px] px-3 py-2 text-xs text-slate-200 shadow-xl">
      <div className="mb-1 flex justify-between border-b border-slate-800 pb-1">
        <span className="font-semibold">{row.time}</span>
        <span className="text-slate-400">{phase}</span>
      </div>
      {row.temperatura_real != null && <p>Temperatura medida: <b className="text-white">{row.temperatura_real.toFixed(1)} °C</b></p>}
      {row.ac_setpoint != null && <p>Setpoint del aire: <b className="text-white">{row.ac_setpoint.toFixed(1)} °C</b></p>}
      {row.temperatura_sin_ac != null && <p>Sin aire: <b className="text-white">{row.temperatura_sin_ac.toFixed(1)} °C</b></p>}
      {row.temperatura_con_ac != null && <p>Con aire: <b className="text-white">{row.temperatura_con_ac.toFixed(1)} °C</b></p>}
      {row.phase === 'future' && row.ac_status && (
        <p className="text-slate-400">Decisión prevista: <b className="text-slate-200">{AI_STATE[row.ac_status]?.label ?? row.ac_status}</b></p>
      )}
      {row.reservation && (
        <p className="mt-1 border-t border-slate-800 pt-1 text-slate-300">
          Reserva de {row.reservation.username ?? '—'} · {row.reservation.expected_occupancy} personas<br />
          {formatClock(row.reservation.start_time)} → {formatClock(row.reservation.end_time)}
        </p>
      )}
    </div>
  )
}

function LegendItem({ className, children }: { className: string; children: ReactNode }) {
  return <span className="flex items-center gap-1.5"><span className={className} />{children}</span>
}

// ── View ──────────────────────────────────────────────────────────────────────
export default function RoomDetail() {
  const { id } = useParams<{ id: string }>()
  const { user } = useAuth()
  const isGuest = user?.role === 'guest'
  const [params, setParams] = useSearchParams()
  const tab = (params.get('tab') as Tab) || 'actual'
  const setTab = (t: Tab) => setParams(t === 'actual' ? {} : { tab: t }, { replace: true })

  const [room, setRoom] = useState<RoomInfo | null>(null)
  const [readings, setReadings] = useState<StoredReading[]>([])
  const [devices, setDevices] = useState<SensorDevice[]>([])
  const [timeline, setTimeline] = useState<TimelineResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [controlError, setControlError] = useState<string | null>(null)
  const [policySaving, setPolicySaving] = useState(false)
  const [now, setNow] = useState(Date.now())

  // Room, devices and 24 h timeline: once per room.
  useEffect(() => {
    if (!id) return
    setLoading(true); setError(null)
    Promise.all([
      api.get<RoomInfo>(`/admin/rooms/${id}`),
      api.get<SensorDevice[]>('/admin/devices').catch(() => ({ data: [] as SensorDevice[] })),
      api.get<TimelineResponse>(`/admin/rooms/${id}/timeline`).catch(() => ({ data: null })),
    ])
      .then(([r, d, t]) => {
        setRoom(r.data)
        setDevices((d.data ?? []).filter(x => x.room_id === id))
        setTimeline(t.data ?? null)
      })
      .catch(err => setError(getApiErrorDetail(err) ?? 'No se pudo cargar el aula.'))
      .finally(() => setLoading(false))
  }, [id])

  // Readings: polled so the view follows the node live.
  useEffect(() => {
    if (!id) return
    let cancelled = false
    const load = () => api.get<StoredReading[]>(`/sensors/?room_id=${id}&limit=${READINGS_LIMIT}`)
      .then(r => { if (!cancelled) { setReadings(r.data ?? []); setNow(Date.now()) } })
      .catch(() => {})
    load()
    const t = setInterval(load, POLL_MS)
    return () => { cancelled = true; clearInterval(t) }
  }, [id])

  async function handleToggle(sensorId: string, field: 'is_active' | 'control_enabled', value: boolean) {
    setControlError(null)
    const device = devices.find(d => d.sensor_id === sensorId)
    if (!device) return
    setDevices(prev => prev.map(d => d.sensor_id === sensorId ? { ...d, [field]: value, _updating: true } : d))
    try {
      const { data } = await api.put<SensorDevice>(`/sensors/${sensorId}/control`, {
        is_active: field === 'is_active' ? value : device.is_active,
        control_enabled: field === 'control_enabled' ? value : device.control_enabled,
      })
      setDevices(prev => prev.map(d => d.sensor_id === sensorId ? { ...d, ...data, _updating: false } : d))
    } catch (err) {
      setDevices(prev => prev.map(d => d.sensor_id === sensorId ? { ...device, _updating: false } : d))
      setControlError(getApiErrorDetail(err) ?? 'No se pudo actualizar el sensor.')
    }
  }

  async function handlePolicyChange(value: string) {
    setControlError(null)
    const prev = room?.control_policy
    setRoom(r => (r ? { ...r, control_policy: value } : r))
    setPolicySaving(true)
    try {
      await api.put(`/admin/rooms/${id}/policy`, { control_policy: value })
    } catch (err) {
      setRoom(r => (r ? { ...r, control_policy: prev ?? 'auto' } : r))
      setControlError(getApiErrorDetail(err) ?? 'No se pudo cambiar la política de control.')
    } finally { setPolicySaving(false) }
  }

  // ── Derived data ────────────────────────────────────────────────────────────
  const latest = readings[0] ?? null
  const ageS = latest ? (now - parseUtc(latest.timestamp).getTime()) / 1000 : Infinity
  const live = ageS < LIVE_SECONDS
  const hasNode = readings.some(r => r.node_state?.accion)
  const target = latest?.node_state?.accion ? NODE_SETPOINT : (latest?.cognitive_action?.target ?? room?.target_temp ?? NODE_SETPOINT)
  const sensorIds = [...new Set([...devices.map(d => d.sensor_id), ...readings.slice(0, 20).map(r => r.sensor_id)])]

  const series = useMemo(() => {
    const all = [...readings].reverse().map(r => ({
      t: parseUtc(r.timestamp).getTime(),
      temperature: r.temperature,
      humidity: r.humidity,
      co2: r.co2_ppm,
      co: r.co_ppm,
    }))
    const end = all.length ? all[all.length - 1].t : 0
    const recent = all.filter(p => p.t >= end - WINDOW_MIN * 60_000)
    if (recent.length >= MIN_POINTS) return { points: recent, window: `${WINDOW_MIN} min` }
    return { points: all.filter(p => p.t >= end - FALLBACK_H * 3_600_000), window: `${FALLBACK_H} h` }
  }, [readings])
  const spanLabel = series.points.length > 0
    ? `${series.window === `${WINDOW_MIN} min` ? 'últimos' : 'últimas'} ${series.window} hasta la última lectura · ${series.points.length} lecturas desde ${new Date(series.points[0].t).toLocaleString('es', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}`
    : 'sin lecturas'
  const chartData = series.points

  const comparison = useMemo(() => {
    const pairs = readings
      .map(r => ({ ts: r.timestamp, node: nodeIntent(r.node_state?.accion), ai: aiIntent(r.cognitive_action?.ac_status) }))
      .filter((p): p is { ts: string; node: Intent; ai: Intent } => p.node != null && p.ai != null)
    const matches = pairs.filter(p => p.node === p.ai).length
    return { pairs: pairs.slice(0, 60).reverse(), total: pairs.length, matches, pct: pairs.length ? Math.round((matches / pairs.length) * 100) : null }
  }, [readings])

  const timelineRows: TimelineRow[] = (timeline?.timeline ?? []).map(p => {
    const isPast = p.phase === 'past' || p.phase === 'current'
    return {
      time: formatHour(p.hour),
      phase: p.phase,
      temperatura_real: isPast ? (p.actual_temperature ?? null) : null,
      temperatura_sin_ac: !isPast ? (p.predicted_temperature ?? null) : null,
      temperatura_con_ac: !isPast ? (p.projected_temperature ?? null) : null,
      ac_setpoint: isPast && p.ac?.status === 'ON' ? (p.ac.setpoint ?? null) : null,
      reserva_icon: null,
      reservation: p.reservation,
      ac_status: p.ac?.status ?? null,
      cooling_mode: p.ac?.cooling_mode ?? null,
    }
  })
  const tlTarget = timeline?.target_temp ?? room?.target_temp ?? 24
  const tlPool = timelineRows
    .flatMap(r => [r.temperatura_real, r.temperatura_sin_ac, r.temperatura_con_ac, r.ac_setpoint])
    .filter((v): v is number => v != null)
    .concat([tlTarget - 1, tlTarget + 1])
  const tlMax = Math.max(...tlPool)
  const reservaY = tlMax + 1.5
  const tlDomain: [number, number] = [Math.floor(Math.min(...tlPool) - 1), Math.ceil(reservaY + 0.5)]
  const reservationSpans: { id: number; x1: string; x2: string; past: boolean }[] = []
  const genMs = timeline ? new Date(timeline.generated_at).getTime() : now
  for (const row of timelineRows) {
    const res = row.reservation
    if (!res) continue
    const last = reservationSpans[reservationSpans.length - 1]
    if (last && last.id === res.id) last.x2 = row.time
    else {
      row.reserva_icon = reservaY
      reservationSpans.push({ id: res.id, x1: row.time, x2: row.time, past: new Date(res.end_time).getTime() <= genMs })
    }
  }
  const nowLabel = timelineRows.find(r => r.phase === 'current')?.time

  if (loading) {
    return <p className="flex items-center justify-center gap-2 py-12 text-sm text-slate-400"><RefreshCw size={14} className="animate-spin" /> Cargando aula…</p>
  }

  const name = room ? (room.name.startsWith(room.id) ? room.name.slice(room.id.length).trim() : room.name) : ''
  const policy = POLICIES.find(p => p.value === room?.control_policy) ?? POLICIES[0]
  const nodeState = latest?.node_state
  const node = nodeState?.alarma_co
    ? { label: 'Alarma CO', tone: 'alert' as Tone }
    : nodeState?.accion ? (NODE_STATE[nodeState.accion] ?? { label: nodeState.accion, tone: 'muted' as Tone }) : null
  const action = latest?.cognitive_action
  const ai = action ? (AI_STATE[action.ac_status] ?? { label: action.ac_status, tone: 'muted' as Tone }) : null
  const coAlert = latest && levelCO(latest.co_ppm ?? 0) === 'alerta'

  return (
    <div className="space-y-4">
      {/* ── Context header ── */}
      <div className="flex flex-wrap items-start gap-3">
        <Link to="/" className="btn btn-ghost mt-0.5 px-2" aria-label="Volver al resumen">
          <ArrowLeft size={18} />
        </Link>
        <div className="min-w-0 flex-1">
          <h1 className="page-title">
            {room?.id} <span className="text-sm font-normal text-slate-400">{name}</span>
          </h1>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-400">
            {latest
              ? <Chip tone={live ? 'ok' : 'muted'} dot pulse={live}>{live ? 'En vivo' : `Última lectura ${timeAgo(latest.timestamp, now)}`}</Chip>
              : <Chip dot>Sin lecturas</Chip>}
            {latest && <Chip tone={latest.is_simulated ? 'warn' : 'muted'}>{latest.is_simulated ? 'Datos simulados' : 'Datos reales'}</Chip>}
            {hasNode && <Chip tone="info">Nodo ESP32</Chip>}
            <span>Sensor {sensorIds.join(', ') || '—'}</span>
            <span>·</span>
            <span>Capacidad {room?.max_capacity}</span>
            <span>·</span>
            <span>Setpoint {room?.target_temp} °C</span>
            <span>·</span>
            <span>Política {policy.label.toLowerCase()}</span>
          </div>
        </div>
      </div>

      {error && <Card className="border-red-500/40 text-sm text-red-300">{error}</Card>}

      {coAlert && (
        <Card className="border-red-500/50">
          <p className="flex items-center gap-2 text-sm text-red-200">
            <AlertTriangle size={16} className="text-red-400" />
            <b>CO en {fmt(latest?.co_ppm)} ppm.</b> Supera el límite de 50 ppm: ventilar y evacuar el aula.
          </p>
        </Card>
      )}

      <Tabs<Tab>
        value={tab}
        onChange={setTab}
        items={[
          { value: 'actual', label: 'Estado actual' },
          { value: 'historial', label: 'Historial' },
          { value: 'config', label: 'Configuración' },
        ]}
      />

      {/* ── Estado actual ── */}
      {tab === 'actual' && (!latest ? (
        <Card><p className="py-8 text-center text-sm text-slate-400">Esta aula todavía no recibió lecturas. Revisa en Configuración que tenga un sensor activo.</p></Card>
      ) : <>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
          <Kpi label="Temperatura" value={fmt(latest.temperature)} unit="°C"
            tone={LEVEL_TONE[levelTemp(latest.temperature, target)]} status={getStatusLabel(levelTemp(latest.temperature, target))}
            hint={`Comparada con el setpoint de ${fmt(target)} °C`} />
          <Kpi label="Humedad" value={fmt(latest.humidity, 0)} unit="%"
            tone={LEVEL_TONE[levelHumedad(latest.humidity)]} status={getStatusLabel(levelHumedad(latest.humidity))} />
          <Kpi label="CO₂" value={fmt(latest.co2_ppm, 0)} unit="ppm"
            tone={LEVEL_TONE[levelCO2(latest.co2_ppm ?? 0)]} status={getStatusLabel(levelCO2(latest.co2_ppm ?? 0))} />
          <Kpi label="CO" value={fmt(latest.co_ppm)} unit="ppm"
            tone={LEVEL_TONE[levelCO(latest.co_ppm ?? 0)]} status={getStatusLabel(levelCO(latest.co_ppm ?? 0))}
            hint="Límite de alarma: 50 ppm" />
          <Kpi label="Ocupación estimada" value={fmt(action?.actual_occupancy, 0)} unit={`/ ${room?.max_capacity ?? '—'}`}
            hint="Estimada a partir del CO₂: (CO₂ − 420) / 25" />
          <Kpi label="Setpoint de la IA" value={fmt(action?.target)} unit="°C" />
        </div>

        {/* Node vs AI */}
        <Card
          title="Nodo vs IA"
          aside={comparison.pct != null && (
            <span>Coinciden en <b className="text-slate-100">{comparison.pct}%</b> de {comparison.total} lecturas</span>
          )}
        >
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div>
              <p className="mb-2 flex items-center gap-2 text-xs text-slate-400"><Cpu size={14} /> Nodo ESP32 · decide y actúa</p>
              {node ? <>
                <Row label="Decisión"><Chip tone={node.tone}>{node.label}</Chip></Row>
                <Row label="Motivo"><span className="text-xs">{nodeState?.motivo ?? '—'}</span></Row>
                <Row label="Ventilador">{nodeState?.ventilador_pwm != null ? `${Math.round((nodeState.ventilador_pwm / 255) * 100)} %` : '—'}</Row>
                <Row label="Calefactor">{nodeState?.calefactor ? 'Encendido' : 'Apagado'}</Row>
                {!!nodeState?.bloqueo_s && (
                  <Row label="Histéresis">
                    <Chip tone="warn">Pasa a {NODE_STATE[nodeState.pendiente ?? '']?.label ?? nodeState.pendiente} en {nodeState.bloqueo_s} s</Chip>
                  </Row>
                )}
              </> : (
                <p className="text-sm text-slate-400">Esta aula no tiene nodo: las lecturas llegan por la API, sin decisión local.</p>
              )}
            </div>
            <div className="md:border-l md:border-slate-800 md:pl-4">
              <p className="mb-2 flex items-center gap-2 text-xs text-slate-400"><BrainCircuit size={14} /> Backend · {hasNode ? 'en sombra, no actúa' : 'decide'}</p>
              <Row label="Decisión">{ai ? <Chip tone={ai.tone}>{ai.label}</Chip> : '—'}</Row>
              <Row label="Motor">{MODEL_LABEL[action?.model ?? 'none'] ?? action?.model}</Row>
              <Row label="Setpoint">{fmt(action?.target)} °C</Row>
              <Row label="Modo">{action?.cooling_mode ?? '—'}</Row>
            </div>
          </div>

          {comparison.total > 0 && (
            <div className="mt-4 border-t border-slate-800 pt-3">
              <div className="flex h-4 gap-px" role="img" aria-label={`Coincidencia en las últimas ${comparison.pairs.length} lecturas`}>
                {comparison.pairs.map((p, i) => (
                  <span
                    key={i}
                    title={`${clockTime(p.ts)} · nodo: ${p.node} · IA: ${p.ai}`}
                    className={`flex-1 rounded-sm ${p.node === p.ai ? 'bg-emerald-500/50' : 'bg-amber-400/80'}`}
                  />
                ))}
              </div>
              <p className="mt-1 text-xs text-slate-400">
                Una barra por lectura, de la más antigua a la más reciente. Las ámbar son lecturas en que el nodo y la IA no coinciden
                en si enfriar. La IA no controla el calefactor, así que «Calentando» cuenta como «no enfriar».
              </p>
            </div>
          )}
        </Card>

        {/* One chart per magnitude */}
        <div>
          <p className="mb-2 text-xs text-slate-400">Recientes: {spanLabel}</p>
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            <MiniChart title="Temperatura (°C)" data={chartData} dataKey="temperature" unit="°C" color={C.data}
              refs={hasNode
                ? [
                    { y: NODE_COOL_ON, label: 'enfría ≥ 24.5', color: C.compare, pos: 'insideTopLeft' },
                    { y: NODE_SETPOINT, label: 'setpoint 24.0', color: C.ok, pos: 'insideTopRight' },
                    { y: NODE_HEAT_ON, label: 'calienta ≤ 23.5', color: C.compare, pos: 'insideBottomLeft' },
                  ]
                : [{ y: target, label: 'setpoint', color: C.ok }]} />
            <MiniChart title="Humedad (%)" data={chartData} dataKey="humidity" unit="%" color={C.data} />
            <MiniChart title="CO₂ (ppm)" data={chartData} dataKey="co2" unit="ppm" color={C.data}
              refs={[{ y: 800, label: 'atención', color: C.warn }]} />
            <MiniChart title="CO (ppm)" data={chartData} dataKey="co" unit="ppm" color={C.data}
              refs={[{ y: 50, label: 'alarma', color: C.alert }]} />
          </div>
        </div>
      </>)}

      {/* ── Historial ── */}
      {tab === 'historial' && <>
        <Card
          title="Últimas 24 h y proyección"
          aside={timelineRows.length > 0 && <>
            <LegendItem className="h-2 w-3 rounded-sm bg-sky-400/30 ring-1 ring-sky-400">medida / con aire</LegendItem>
            <LegendItem className="w-3 border-t border-dashed border-slate-400">sin aire</LegendItem>
            <LegendItem className="w-3 border-t border-dotted border-slate-200">setpoint del aire</LegendItem>
            <LegendItem className="h-2 w-3 rounded-sm bg-emerald-500/15 ring-1 ring-emerald-500/50">±1 °C del objetivo</LegendItem>
            <span className="flex items-center gap-1.5"><CalendarClock size={12} className="text-slate-400" />reserva</span>
          </>}
        >
          {timelineRows.length === 0 ? (
            <p className="py-8 text-center text-sm text-slate-400">Sin datos para la línea de tiempo. Aparece cuando el aula registra lecturas o reservas.</p>
          ) : (
            <ResponsiveContainer width="100%" height={280}>
              <ComposedChart data={timelineRows} margin={{ top: 16, right: 8, left: -12, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={C.grid} />
                <XAxis dataKey="time" interval="preserveStartEnd" minTickGap={32} {...AXIS} />
                <YAxis domain={tlDomain} allowDecimals={false} width={44} {...AXIS} />
                <ReferenceArea y1={tlTarget - 1} y2={tlTarget + 1} fill={C.ok} fillOpacity={0.08} stroke={C.ok} strokeOpacity={0.3} ifOverflow="extendDomain" />
                {reservationSpans.map((s, i) => (
                  <ReferenceArea key={`${s.id}-${i}`} x1={s.x1} x2={s.x2}
                    fill="#94a3b8" fillOpacity={s.past ? 0.04 : 0.1}
                    stroke="#94a3b8" strokeOpacity={0.25} strokeDasharray="3 3" />
                ))}
                <Tooltip content={<TimelineTooltip />} cursor={{ stroke: '#475569', strokeDasharray: '2 2' }} />
                {nowLabel && <ReferenceLine x={nowLabel} stroke="#e2e8f0" strokeDasharray="3 3" label={{ value: 'ahora', fill: '#e2e8f0', position: 'top', fontSize: 11 }} />}
                <Area type="monotone" dataKey="temperatura_real" stroke={C.data} fill={C.data} fillOpacity={0.15} strokeWidth={2} isAnimationActive={false} />
                <Line type="monotone" dataKey="ac_setpoint" stroke="#e2e8f0" strokeDasharray="2 4" strokeWidth={2} dot={false} isAnimationActive={false} />
                <Area type="monotone" dataKey="temperatura_sin_ac" stroke={C.compare} fill={C.compare} fillOpacity={0.06} strokeWidth={2} strokeDasharray="4 3" isAnimationActive={false} />
                <Area type="monotone" dataKey="temperatura_con_ac" stroke={C.data} strokeOpacity={0.5} fill={C.data} fillOpacity={0.12} strokeWidth={2} isAnimationActive={false} />
                <Scatter
                  dataKey="reserva_icon"
                  shape={(props: { cx?: number; cy?: number }) => props.cx == null || props.cy == null ? <g /> : (
                    <g>
                      <circle cx={props.cx} cy={props.cy} r={9} fill="#0f172a" stroke="#64748b" strokeWidth={1.5} />
                      <CalendarClock x={props.cx - 6} y={props.cy - 6} width={12} height={12} color="#cbd5e1" />
                    </g>
                  )}
                />
              </ComposedChart>
            </ResponsiveContainer>
          )}
        </Card>

        <Card title="Lecturas" aside={<span>las 20 más recientes</span>}>
          {readings.length === 0 ? (
            <p className="py-6 text-center text-sm text-slate-400">Sin lecturas todavía.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] text-sm">
                <thead>
                  <tr className="table-head">
                    {['Hora', 'Sensor', 'Temp.', 'Humedad', 'CO₂', 'CO', 'Nodo', 'IA'].map(h => <th key={h} className="pb-2 pr-4 font-normal">{h}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {readings.slice(0, 20).map(r => {
                    const t = r.cognitive_action?.target ?? target
                    const n = r.node_state?.accion ? NODE_STATE[r.node_state.accion] : null
                    const a = r.cognitive_action ? AI_STATE[r.cognitive_action.ac_status] : null
                    return (
                      <tr key={`${r.sensor_id}-${r.timestamp}`} className="table-row">
                        <td className="py-1.5 pr-4 text-xs text-slate-400 tabular-nums">{parseUtc(r.timestamp).toLocaleString('es', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })}</td>
                        <td className="py-1.5 pr-4 font-mono text-xs text-slate-300">{r.sensor_id}</td>
                        <td className={`py-1.5 pr-4 tabular-nums ${valueText(levelTemp(r.temperature, t))}`}>{fmt(r.temperature)} °C</td>
                        <td className={`py-1.5 pr-4 tabular-nums ${valueText(levelHumedad(r.humidity))}`}>{fmt(r.humidity, 0)} %</td>
                        <td className={`py-1.5 pr-4 tabular-nums ${valueText(levelCO2(r.co2_ppm ?? 0))}`}>{fmt(r.co2_ppm, 0)}</td>
                        <td className={`py-1.5 pr-4 tabular-nums ${valueText(levelCO(r.co_ppm ?? 0))}`}>{fmt(r.co_ppm)}</td>
                        <td className="py-1.5 pr-4">{n ? <Chip tone={n.tone}>{n.label}</Chip> : <span className="text-xs text-slate-500">—</span>}</td>
                        <td className="py-1.5">{a ? <Chip tone={a.tone}>{a.label}</Chip> : <span className="text-xs text-slate-500">—</span>}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </>}

      {/* ── Configuración ── */}
      {tab === 'config' && <>
        {isGuest && <p className="text-xs text-amber-300">Solo lectura: tu rol no puede cambiar la configuración.</p>}
        {controlError && <Card className="border-red-500/40 text-sm text-red-300">{controlError}</Card>}

        <Card title="Política de control" aside={policySaving && <RefreshCw size={12} className="animate-spin" />}>
          <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
            {POLICIES.map(p => {
              const selected = room?.control_policy === p.value
              return (
                <button
                  key={p.value}
                  type="button"
                  disabled={isGuest || policySaving}
                  onClick={() => handlePolicyChange(p.value)}
                  className={`rounded-lg border p-3 text-left transition-colors disabled:cursor-not-allowed ${
                    selected ? 'border-blue-500/60 bg-blue-500/5' : 'border-slate-800 hover:border-slate-600'
                  }`}
                >
                  <p className="flex items-center justify-between text-sm font-medium text-slate-100">
                    {p.label} {selected && <Chip tone="info">Activa</Chip>}
                  </p>
                  <p className="mt-1 text-xs text-slate-400">{p.desc}</p>
                </button>
              )
            })}
          </div>
        </Card>

        <Card title="Sensores del aula">
          {devices.length === 0 ? (
            <p className="py-4 text-sm text-slate-400">No hay sensores asignados. Asígnalos desde Infraestructura.</p>
          ) : (
            <div className="divide-y divide-slate-800">
              {devices.map(d => (
                <div key={d.sensor_id} className="flex flex-wrap items-center justify-between gap-3 py-2">
                  <span className="flex items-center gap-2 font-mono text-sm text-slate-200">
                    <span className={`h-1.5 w-1.5 rounded-full ${d.is_active ? 'bg-emerald-400' : 'bg-slate-500'}`} />
                    {d.sensor_id}
                    {d._updating && <RefreshCw size={12} className="animate-spin text-slate-400" />}
                  </span>
                  <div className="flex flex-wrap gap-4">
                    <Toggle label="Recibir datos" checked={d.is_active} disabled={isGuest || d._updating}
                      onChange={v => handleToggle(d.sensor_id, 'is_active', v)} />
                    <Toggle label="Controlar el aire" checked={d.control_enabled} disabled={isGuest || d._updating}
                      onChange={v => handleToggle(d.sensor_id, 'control_enabled', v)} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </>}
    </div>
  )
}
