import { useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import {
  ComposedChart, Area, Line, Scatter, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, ReferenceLine, ReferenceArea,
} from 'recharts'
import { CalendarClock } from 'lucide-react'
import {
  ArrowLeft, Building2, RefreshCw, AlertCircle,
  Zap, ZapOff, Cpu, Radio, SlidersHorizontal, WifiOff, CloudFog,
  Thermometer, BrainCircuit, Brain, Snowflake, Bot, Sigma,
  Inbox, LineChart as LineChartIcon, type LucideIcon,
} from 'lucide-react'
import api, { getApiErrorDetail } from '../api/client'
import { useAuth } from '../context/AuthContext'
import {
  MetricCard, STATUS_TOKENS, tempStatus, coStatus,
} from '../components/MetricCard'
import { EmptyState } from '../components/EmptyState'
import { getColorTemp, getColorHumedad, getColorCO2, getColorCO } from '../utils/sensorColors'

interface RoomInfo {
  id: number
  name: string
  max_capacity: number
  target_temp: number
  control_policy: string   // auto | heuristic | manual
}

// ── Cognitive-policy modes ────────────────────────────────────────────────────
// Backend enum: control_policy = auto | heuristic | manual. Rendered as selectable
// radio cards (icon + name + description) using the section's violet accent.
const POLICY_CARDS: { value: string; label: string; desc: string; Icon: LucideIcon }[] = [
  {
    value: 'auto',
    label: 'Automática',
    Icon: Bot,
    desc: 'Usa el modelo ML si está disponible y entrenado. Si no hay modelo cargado, cae automáticamente a la fórmula heurística. Recomendado para operación normal.',
  },
  {
    value: 'heuristic',
    label: 'Solo heurística',
    Icon: Sigma,
    desc: 'Aplica siempre la fórmula estática de temperatura objetivo basada en ocupación esperada y CO₂ medido. Más predecible y sin dependencia del modelo ML.',
  },
  {
    value: 'manual',
    label: 'Manual',
    Icon: SlidersHorizontal,
    desc: 'El administrador define el setpoint directamente, emitiendo acciones sin adaptación cognitiva, solo para mantenimiento o revisión.',
  },
]

// Selectable mode card — same action as the previous dropdown's onChange.
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

interface SensorReading {
  sensor_id: string
  temperature: number
  humidity: number
  co2_ppm: number | null
  co_ppm: number | null
  timestamp: string
  cognitive_action?: {
    ac_status: string
    cooling_mode: string | null
    target: number | null
    thermal_load_offset: number
    model: string
  }
}

function fmt(n: number | null | undefined, unit = '', dec = 1) {
  return n == null ? '—' : `${n.toFixed(dec)}${unit}`
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
}

interface TimelinePoint {
  hour: string
  phase: 'past' | 'current' | 'future'
  reservation: TimelineReservation | null
  actual_temperature?: number | null
  actual_humidity?: number | null
  actual_co_ppm?: number | null
  readings_count?: number
  predicted_temperature?: number | null
  projected_temperature?: number | null
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
  timeline: TimelinePoint[]
}

interface TimelineRow {
  time: string
  hour_iso: string
  phase: 'past' | 'current' | 'future'
  temperatura_real: number | null
  temperatura_sin_ac: number | null
  temperatura_con_ac: number | null
  ac_setpoint: number | null
  reserva_icon: number | null
  reservation: TimelineReservation | null
  expected_people: number
  readings_count: number
  ac_status: string | null
  cooling_mode: string | null
}

// One contiguous reservation interval, mapped to categorical X labels for ReferenceArea.
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

// Sensor reading timestamps are stored as naive UTC ("YYYY-MM-DDTHH:MM:SS.ffffff").
// Force UTC parse so the browser renders them in local (Lima) time — same rule as
// GlobalDashboard's parseTs.
const parseUtcTs = (ts: string) =>
  new Date(/(Z|[+-]\d\d:?\d\d)$/.test(ts) ? ts : `${ts}Z`)

function CustomTooltip({ active, payload }: { active?: boolean; payload?: Array<{ payload: TimelineRow }> }) {
  if (!active || !payload?.length) return null
  const row = payload[0].payload
  const phaseLabel = row.phase === 'past' ? 'Pasado' : row.phase === 'current' ? 'Ahora' : 'Futuro'
  const mitigation =
    row.temperatura_sin_ac != null && row.temperatura_con_ac != null
      ? row.temperatura_sin_ac - row.temperatura_con_ac
      : null
  return (
    <div className="bg-slate-900/95 border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-200 shadow-xl min-w-[210px]">
      <div className="flex items-center justify-between mb-1.5 pb-1.5 border-b border-slate-700/70">
        <span className="text-slate-100 font-semibold">{row.time}</span>
        <span className="text-[10px] uppercase tracking-wider text-slate-400">{phaseLabel}</span>
      </div>
      {row.temperatura_real != null && (
        <p>Real: <span className="text-blue-300 font-semibold">{row.temperatura_real.toFixed(2)}°C</span></p>
      )}
      {row.ac_setpoint != null && (
        <p>Setpoint AC: <span className="text-red-300 font-semibold">{row.ac_setpoint.toFixed(2)}°C</span></p>
      )}
      {row.temperatura_sin_ac != null && (
        <p>Sin AC: <span className="text-amber-300 font-semibold">{row.temperatura_sin_ac.toFixed(2)}°C</span></p>
      )}
      {row.temperatura_con_ac != null && (
        <p>Con AC: <span className="text-sky-300 font-semibold">{row.temperatura_con_ac.toFixed(2)}°C</span></p>
      )}
      {row.phase === 'future' && row.ac_status === 'ON' && (
        <p className="text-red-300">
          Acción AC: <span className="font-semibold">{row.cooling_mode ?? 'ON'}</span>
          {mitigation != null && mitigation > 0.05 && (
            <span className="text-emerald-300"> · mitiga {mitigation.toFixed(2)}°C</span>
          )}
        </p>
      )}
      {row.phase === 'future' && row.ac_status === 'STANDBY' && (
        <p className="text-slate-400">Acción AC: <span className="font-semibold">STANDBY</span></p>
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

export default function RoomDetail() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { user } = useAuth()
  const isGuest = user?.role === 'guest'

  const [room, setRoom] = useState<RoomInfo | null>(null)
  const [readings, setReadings] = useState<SensorReading[]>([])
  const [devices, setDevices] = useState<SensorDevice[]>([])
  const [timeline, setTimeline] = useState<TimelineResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [controlError, setControlError] = useState<string | null>(null)
  const [policySaving, setPolicySaving] = useState(false)

  useEffect(() => {
    if (!id) return
    setLoading(true)
    setError(null)

    const fallbackReadings = { data: [] as SensorReading[] }
    const fallbackDevices  = { data: [] as SensorDevice[] }
    const fallbackTimeline = { data: null as TimelineResponse | null }

    Promise.all([
      api.get<RoomInfo>(`/admin/rooms/${id}`),
      api.get<SensorReading[]>(`/sensors/?room_id=${id}&limit=40`).catch(() => fallbackReadings),
      api.get<SensorDevice[]>('/admin/devices').catch(() => fallbackDevices),
      api.get<TimelineResponse>(`/admin/rooms/${id}/timeline`).catch(() => fallbackTimeline),
    ])
      .then(([roomRes, readingsRes, devicesRes, timelineRes]) => {
        setRoom(roomRes.data)
        setReadings(readingsRes.data ?? [])
        setDevices((devicesRes.data ?? []).filter(d => d.room_id === id))
        setTimeline(timelineRes.data ?? null)
      })
      .catch(err => setError(getApiErrorDetail(err) ?? 'Error cargando datos del aula.'))
      .finally(() => setLoading(false))
  }, [id])

  async function handleToggle(
    sensorId: string,
    field: 'is_active' | 'control_enabled',
    value: boolean,
  ) {
    setControlError(null)

    // Optimistic update
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
      // Revert on failure
      setDevices(prev =>
        prev.map(d =>
          d.sensor_id === sensorId
            ? { ...d, is_active: device.is_active, control_enabled: device.control_enabled, _updating: false }
            : d
        )
      )
      const detail = getApiErrorDetail(err)
      setControlError(detail ?? 'Error al actualizar el sensor.')
    }
  }

  async function handlePolicyChange(value: string) {
    setControlError(null)
    const prev = room?.control_policy
    setRoom(r => (r ? { ...r, control_policy: value } : r))   // optimistic
    setPolicySaving(true)
    try {
      await api.put(`/admin/rooms/${id}/policy`, { control_policy: value })
    } catch (err: unknown) {
      setRoom(r => (r ? { ...r, control_policy: prev ?? 'auto' } : r))   // revert
      const detail = getApiErrorDetail(err)
      setControlError(detail ?? 'No se pudo cambiar la política de control.')
    } finally {
      setPolicySaving(false)
    }
  }

  const hasSensors = devices.length > 0 || readings.length > 0
  const policy = room?.control_policy ?? 'auto'

  const latest = (readings ?? [])[0] ?? null
  const isOn = latest?.cognitive_action?.ac_status === 'ON'

  // Modelo activo — distinguir fallback heurístico vs modelo ML cargado.
  const modelName = latest?.cognitive_action?.model
  const modelIsHeuristic = (modelName ?? '').toLowerCase() === 'heuristic'
  const modelIsMl = !!modelName && !['heuristic', 'none', ''].includes(modelName.toLowerCase())
  const modelContext = modelIsHeuristic
    ? 'ML no disponible · usando fórmula'
    : modelIsMl
      ? `Modelo ${modelName} · cargado`
      : `Sensor: ${latest?.sensor_id ?? '—'}`

  // Línea de estado bajo las tarjetas de política cognitiva.
  const policyStatus =
    policy === 'manual'
      ? `Modo manual · setpoint fijado en ${room?.target_temp ?? '—'}°C por admin`
      : policy === 'heuristic'
        ? 'Modo solo heurística · aplicando fórmula estática'
        : `Modo automático activo${
            modelName && modelName.toLowerCase() !== 'none'
              ? ` · usando ${modelName}${modelIsHeuristic ? ' (fallback)' : ''}`
              : ''
          }`

  // Build 24h ComposedChart rows from /timeline. Past hours carry the measured (with-AC)
  // reality; future hours carry both the sin-AC ambient and the con-AC projection.
  const timelineRows: TimelineRow[] = (timeline?.timeline ?? []).map(p => {
    const isPast = p.phase === 'past' || p.phase === 'current'
    const acOn = p.ac?.status === 'ON'
    return {
      time: formatHourLabel(p.hour),
      hour_iso: p.hour,
      phase: p.phase,
      temperatura_real: isPast ? (p.actual_temperature ?? null) : null,
      temperatura_sin_ac: !isPast ? (p.predicted_temperature ?? null) : null,
      temperatura_con_ac: !isPast ? (p.projected_temperature ?? null) : null,
      ac_setpoint: isPast && acOn ? (p.ac.setpoint ?? null) : null,
      reserva_icon: null,
      reservation: p.reservation,
      expected_people: p.expected_people ?? 0,
      readings_count: p.readings_count ?? 0,
      ac_status: p.ac?.status ?? null,
      cooling_mode: p.ac?.cooling_mode ?? null,
    }
  })

  // Comfort band around the configured target.
  const TARGET_TOL = 1.0
  const targetTemp = timeline?.target_temp ?? room?.target_temp ?? 25

  const tempPool = timelineRows
    .flatMap(r => [r.temperatura_real, r.temperatura_sin_ac, r.temperatura_con_ac, r.ac_setpoint])
    .filter((v): v is number => v != null)
    .concat([targetTemp - TARGET_TOL, targetTemp + TARGET_TOL])
  const minT = tempPool.length ? Math.min(...tempPool) : targetTemp - 3
  const maxT = tempPool.length ? Math.max(...tempPool) : targetTemp + 3
  // Reservation icons ride a fixed row just above the temperature ceiling.
  const reservaY = maxT + 1.5
  const yDomain: [number, number] = [Math.floor(minT - 1), Math.ceil(reservaY + 0.5)]

  // Collapse consecutive anchors sharing a reservation id into contiguous spans, and
  // pin one icon at each span's first hour (so single-hour reservations stay visible).
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

  return (
    <div className="space-y-6">
      {/* Header — always rendered */}
      <div className="flex items-center gap-4">
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
            <p className="text-xs text-slate-400">Cap: {room?.max_capacity} · Target: {room?.target_temp}°C</p>
          </div>
        </div>
      </div>

      {/* Fatal error loading room info */}
      {error && (
        <div className="flex items-center gap-2 bg-red-900/30 border border-red-500/40 rounded-lg px-4 py-3 text-sm text-red-300">
          <AlertCircle size={16} className="shrink-0" /> {error}
        </div>
      )}

      {/* No sensors — empty state inside main container */}
      {!error && !hasSensors && (
        <div className="flex flex-col items-center justify-center gap-5 bg-slate-800 border border-slate-700 rounded-xl px-8 py-16 text-center">
          <div className="w-16 h-16 rounded-full bg-slate-700/60 border border-slate-600 flex items-center justify-center">
            <WifiOff size={28} className="text-slate-500" />
          </div>
          <div className="space-y-2 max-w-sm">
            <h3 className="text-slate-200 font-semibold text-base">Aula sin sensores</h3>
            <p className="text-slate-400 text-sm leading-relaxed">
              No hay dispositivos de telemetría asignados a esta aula. Por favor, asigne un sensor desde el panel de administración para comenzar a recibir datos.
            </p>
          </div>
        </div>
      )}

      {/* Dashboard data — only when sensors exist */}
      {!error && hasSensors && <>

      {/* AC status + metrics */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* AC status — brand-blue card, same visual DNA as the metric cards */}
        <div className={`bg-slate-800/60 border border-slate-700/60 border-l-4 rounded-xl p-4 flex flex-col gap-3 ${isOn ? 'border-l-blue-500' : 'border-l-slate-600'}`}>
          <div className="flex items-start justify-between gap-2">
            <span className={`w-9 h-9 rounded-lg ring-1 flex items-center justify-center ${
              isOn ? 'bg-blue-500/10 ring-blue-500/30 text-blue-400' : 'bg-slate-700/40 ring-slate-600/40 text-slate-500'
            }`}>
              {isOn ? <Zap size={18} /> : <ZapOff size={18} />}
            </span>
            {/* Estado pill — verde Activo / rojo Apagado */}
            <span className={`inline-flex items-center gap-1.5 text-[11px] rounded-full px-[9px] py-[3px] border ${
              isOn ? 'bg-green-500/10 border-green-500/30 text-green-300' : 'bg-red-500/10 border-red-500/30 text-red-300'
            }`}>
              <span className={`w-1.5 h-1.5 rounded-full ${isOn ? 'bg-green-500' : 'bg-red-500'}`} />
              {isOn ? 'Activo' : 'Apagado'}
            </span>
          </div>
          <div>
            <p className="text-xs text-slate-400">AC Status</p>
            <p className={`text-2xl font-bold leading-tight ${isOn ? 'text-blue-300' : 'text-slate-400'}`}>
              {latest?.cognitive_action?.ac_status ?? '—'}
            </p>
          </div>
          {/* Modo de operación — pill con copo de nieve */}
          {latest?.cognitive_action?.cooling_mode ? (
            <span className="inline-flex items-center gap-1.5 self-start text-[11px] font-medium text-sky-400 bg-sky-400/10 border border-sky-400/30 rounded-full px-2.5 py-1">
              <Snowflake size={12} /> {latest.cognitive_action.cooling_mode}
            </span>
          ) : (
            <p className={`text-xs font-medium ${isOn ? 'text-sky-400' : 'text-slate-500'}`}>
              {isOn ? 'Enfriando' : 'En espera'}
            </p>
          )}
        </div>

        <MetricCard
          icon={<Thermometer size={18} />} label="Temperatura actual"
          value={fmt(latest?.temperature, '', 1)} unit={latest ? '°C' : undefined}
          status={tempStatus(latest?.temperature)}
          statusText={latest ? STATUS_TOKENS[tempStatus(latest.temperature)].label : undefined}
          sub={latest ? `Target ajustado: ${fmt(latest.cognitive_action?.target, '°C')}` : 'Sin datos'}
        />

        <MetricCard
          icon={<CloudFog size={18} />} label="Monóxido de CO"
          value={fmt(latest?.co_ppm, '', 1)} unit={latest ? 'ppm' : undefined}
          status={coStatus(latest?.co_ppm)}
          statusText={latest ? STATUS_TOKENS[coStatus(latest.co_ppm)].label : undefined}
          sub={latest ? 'Límite EPA: 50 ppm' : 'Sin datos'}
        />

        {/* Modelo activo — brand-purple card, same DNA */}
        <div className="relative bg-slate-800/60 border border-slate-700/60 border-l-4 border-l-purple-500 rounded-xl p-4 flex flex-col gap-3">
          {modelIsHeuristic && (
            <span className="absolute top-3 right-3 text-[11px] font-medium text-purple-400 bg-purple-500/10 border border-purple-500/30 rounded-[5px] px-2 py-0.5">
              Fallback
            </span>
          )}
          <span className="w-9 h-9 rounded-lg ring-1 bg-purple-500/10 ring-purple-500/30 text-purple-400 flex items-center justify-center">
            <Brain size={18} />
          </span>
          <div>
            <p className="text-xs text-slate-400">Modelo activo</p>
            <p className="text-2xl font-bold text-white capitalize leading-tight">{latest?.cognitive_action?.model ?? '—'}</p>
          </div>
          <p className="text-xs text-slate-500 truncate">{modelContext}</p>
        </div>
      </div>

      {/* Cognitive policy — per-room engine selection as radio cards */}
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

      {/* Sensor management card */}
      <div className="bg-slate-800 border border-slate-700 rounded-xl p-5">
        <div className="flex items-center justify-between mb-4">
          <h2 className="flex items-center gap-2 text-slate-300 text-sm font-semibold uppercase tracking-wide">
            <SlidersHorizontal size={15} className="text-blue-400" /> Gestión de Sensores
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
            <Cpu size={16} /> No hay sensores registrados para esta aula.
          </div>
        ) : (
          <div className="space-y-3">
            {devices.map(device => (
              <div key={device.sensor_id} className="bg-slate-700/40 border border-slate-700 rounded-lg px-4 py-3">
                {/* Sensor header */}
                <div className="flex items-center gap-2 mb-3 pb-2 border-b border-slate-700/60">
                  <Radio size={13} className={device.is_active ? 'text-emerald-400' : 'text-slate-500'} />
                  <span className="font-mono text-xs font-semibold text-slate-200">{device.sensor_id}</span>
                  {device._updating && (
                    <RefreshCw size={11} className="animate-spin text-slate-400 ml-auto" />
                  )}
                </div>

                {/* Toggles */}
                <div className="divide-y divide-slate-700/40">
                  <Toggle
                    label="Recibir Datos"
                    sublabel="El sensor envía telemetría al sistema"
                    checked={device.is_active}
                    disabled={isGuest || !!device._updating}
                    onChange={v => handleToggle(device.sensor_id, 'is_active', v)}
                  />
                  <Toggle
                    label="Controlar AC"
                    sublabel="El sistema puede emitir acciones cognitivas"
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

      {/* 24h Timeline ComposedChart */}
      <div className="bg-slate-800 rounded-xl p-5">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-slate-300 text-sm font-semibold uppercase tracking-wide">
            Línea de tiempo 24 h
          </h2>
          {timeline && (
            <span className="text-xs text-slate-500">
              Generado {new Date(timeline.generated_at).toLocaleTimeString('es')}
            </span>
          )}
        </div>
        {timelineRows.length === 0 ? (
          <div className="h-72 flex items-center justify-center">
            <EmptyState
              icon={<LineChartIcon size={22} />}
              title="Sin línea de tiempo disponible"
              hint="La proyección de 24 h se construye a partir de lecturas y reservas. Aparecerá en cuanto el aula registre actividad."
            />
          </div>
        ) : (
          <>
            <ResponsiveContainer width="100%" height={320}>
              <ComposedChart data={timelineRows} margin={{ top: 24, right: 16, left: 0, bottom: 8 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                <XAxis dataKey="time" stroke="#64748b" tick={{ fontSize: 11 }} interval="preserveStartEnd" minTickGap={32} />
                <YAxis
                  stroke="#64748b"
                  tick={{ fontSize: 11 }}
                  domain={yDomain}
                  allowDecimals={false}
                />
                {/* Comfort band around the configured target (drawn first → behind series) */}
                <ReferenceArea
                  y1={targetTemp - TARGET_TOL}
                  y2={targetTemp + TARGET_TOL}
                  fill="#22c55e"
                  fillOpacity={0.14}
                  stroke="#22c55e"
                  strokeOpacity={0.38}
                  ifOverflow="extendDomain"
                />
                <ReferenceLine
                  y={targetTemp}
                  stroke="#22c55e"
                  strokeDasharray="2 4"
                  strokeOpacity={0.55}
                  label={{ value: `Target ${targetTemp}°C`, fill: '#4ade80', position: 'insideTopRight', fontSize: 10 }}
                />
                {/* Reservation interval bands — índigo (esperada) / gris (cumplida) */}
                {reservationSpans.map((s, i) => (
                  <ReferenceArea
                    key={`res-${s.reservation.id}-${i}`}
                    x1={s.x1}
                    x2={s.x2}
                    fill={s.isPast ? '#64748b' : '#6366f1'}
                    fillOpacity={s.isPast ? 0.07 : 0.14}
                    stroke={s.isPast ? '#64748b' : '#6366f1'}
                    strokeOpacity={s.isPast ? 0.3 : 0.38}
                    strokeDasharray="3 3"
                  />
                ))}
                <Tooltip
                  content={<CustomTooltip />}
                  cursor={{ stroke: '#475569', strokeDasharray: '2 2' }}
                />
                {nowLabel && (
                  <ReferenceLine
                    x={nowLabel}
                    stroke="#eab308"
                    strokeDasharray="3 3"
                    label={{ value: 'AHORA', fill: '#eab308', position: 'top', fontSize: 11 }}
                  />
                )}
                {/* Past — real temperature area (celeste) + AC setpoint (rojo intermitente) */}
                <Area
                  type="monotone"
                  dataKey="temperatura_real"
                  stroke="#38bdf8"
                  fill="#38bdf8"
                  fillOpacity={0.15}
                  strokeWidth={2}
                  connectNulls={false}
                  isAnimationActive={false}
                />
                <Line
                  type="monotone"
                  dataKey="ac_setpoint"
                  stroke="#ef4444"
                  strokeDasharray="5 5"
                  strokeWidth={2}
                  dot={false}
                  connectNulls={false}
                  isAnimationActive={false}
                />
                {/* Future — sin-AC ambient (ámbar, lo que pasaría sin enfriar) vs
                    con-AC projection (azul, temperatura mitigada hacia el target) */}
                <Area
                  type="monotone"
                  dataKey="temperatura_sin_ac"
                  stroke="#f97316"
                  fill="#f97316"
                  fillOpacity={0.18}
                  strokeWidth={2}
                  strokeDasharray="4 3"
                  connectNulls={false}
                  isAnimationActive={false}
                />
                <Area
                  type="monotone"
                  dataKey="temperatura_con_ac"
                  stroke="#38bdf8"
                  strokeOpacity={0.45}
                  fill="#38bdf8"
                  fillOpacity={0.18}
                  strokeWidth={2}
                  connectNulls={false}
                  isAnimationActive={false}
                />
                {/* Reservation icon — calendar marker pinned above each span's first hour */}
                <Scatter
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
            {/* Minimalist Tailwind legend — gris y negro */}
            <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-slate-400 border-t border-slate-700 pt-3">
              <span className="flex items-center gap-2">
                <span className="inline-block w-4 h-2 rounded-sm bg-sky-400/20 border border-sky-400" />
                <span>Temperatura real</span>
              </span>
              <span className="flex items-center gap-2">
                <span className="inline-block w-4 h-2 rounded-sm bg-orange-500/20 border border-dashed border-orange-500" />
                <span>Temperatura sin AC (esperada)</span>
              </span>
              <span className="flex items-center gap-2">
                <span className="inline-block w-4 h-2 rounded-sm bg-sky-400/40 border border-sky-400" />
                <span>Temperatura con AC (proyectada)</span>
              </span>
              <span className="flex items-center gap-2">
                <span className="inline-block w-5 border-t border-dashed border-red-500" />
                <span>Setpoint AC (pasado)</span>
              </span>
              <span className="flex items-center gap-2">
                <span className="inline-block w-4 h-2 rounded-sm bg-green-500/20 border border-green-500/60" />
                <span>Banda Target ±{TARGET_TOL}°C</span>
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
            hint="Cuando el sensor de esta aula envíe telemetría, las últimas lecturas aparecerán aquí."
            action={{ label: 'Enviar una lectura desde el Dashboard', onClick: () => navigate('/') }}
          />
        ) : (
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="text-slate-400 text-xs uppercase border-b border-slate-700">
                {['Sensor', 'Temp', 'Humedad', 'CO₂', 'CO', 'AC', 'Timestamp'].map(h => (
                  <th key={h} className="text-left pb-2 pr-4">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {readings.slice(0, 20).map(r => (
                <tr key={`${r.sensor_id}-${r.timestamp}`} className="border-b border-slate-700/50">
                  <td className="py-2 pr-4 font-mono text-slate-300 text-xs">{r.sensor_id}</td>
                  <td className={`py-2 pr-4 font-semibold ${getColorTemp(r.temperature, r.cognitive_action?.target ?? targetTemp)}`}>
                    {fmt(r.temperature, '°C')}
                  </td>
                  <td className={`py-2 pr-4 font-semibold ${getColorHumedad(r.humidity)}`}>{fmt(r.humidity, '%')}</td>
                  <td className={`py-2 pr-4 font-semibold ${getColorCO2(r.co2_ppm ?? 0)}`}>{fmt(r.co2_ppm, '', 0)}</td>
                  <td className={`py-2 pr-4 font-semibold ${getColorCO(r.co_ppm ?? 0)}`}>
                    {fmt(r.co_ppm, ' ppm', 1)}
                  </td>
                  <td className="py-2 pr-4">
                    <span className={`text-xs font-bold px-2 py-0.5 rounded ${r.cognitive_action?.ac_status === 'ON' ? 'bg-blue-900/50 text-blue-300' : 'bg-slate-700 text-slate-400'}`}>
                      {r.cognitive_action?.ac_status ?? '—'}
                    </span>
                  </td>
                  <td className="py-2 text-slate-400 text-xs">{parseUtcTs(r.timestamp).toLocaleString('es')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      </>}
    </div>
  )
}
