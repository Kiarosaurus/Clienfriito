import { useState, useEffect, useCallback, useRef } from 'react'
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, Legend, ResponsiveContainer, ReferenceLine,
} from 'recharts'
import {
  Thermometer, Droplets, Wind, AlertTriangle,
  CheckCircle, RefreshCw, Send, Clock, FlaskConical, CloudFog,
  BrainCircuit, Inbox, Cpu, LayoutDashboard,
} from 'lucide-react'
import axios from 'axios'
import api, { getApiErrorDetail } from '../api/client'
import { useAuth } from '../context/AuthContext'
import { useEmergency } from '../context/EmergencyContext'
import type { CombinedReading, ReadingInput } from '../types'
import {
  MetricCard, StatusLegend, STATUS_TOKENS, type MetricStatus,
} from '../components/MetricCard'
import { EmptyState } from '../components/EmptyState'
import {
  getColorTemp, getColorHumedad, getColorCO2, getColorCO,
  levelTemp, levelHumedad, levelCO2, levelCO,
  sensorTokens, getStatusLabel, type SensorLevel,
} from '../utils/sensorColors'
import SearchableSelect from '../components/SearchableSelect'

const SENSOR_IDS = ['SIM-sensor-001', 'SIM-sensor-002', 'SIM-sensor-003']
const MAX_POINTS = 40

// Shared input aesthetics — mismas casillas que la ruta /reservations.
const INPUT_CLS = "w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2.5 text-sm text-slate-100 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500/50 transition placeholder-slate-500"
const NUM_INPUT_CLS = `${INPUT_CLS} [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none`
const LABEL_CLS = "block text-xs font-medium text-slate-400 mb-1.5 uppercase tracking-wide"

function fmt(n: number | null | undefined, unit = '', dec = 1) {
  return n == null ? '—' : `${n.toFixed(dec)}${unit}`
}
function timeLabel(ms: number) {
  return new Date(ms).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' })
}

// ── Real-mode persistence bridge ──────────────────────────────────────────────
// Flat Mongo reading doc as returned by GET /sensors/ (no input/output wrapper).
interface RawReading {
  sensor_id: string
  temperature: number
  humidity: number
  co2_ppm: number | null
  co_ppm: number | null
  is_simulated?: boolean
  anomaly_detected?: boolean
  timestamp: string
  cognitive_action?: CombinedReading['output']['cognitive_action']
}

// Stored timestamps are naive UTC ("YYYY-MM-DDTHH:MM:SS.ffffff"). Force UTC parse so the
// browser renders them in local time consistently.
function parseTs(ts: string): number {
  const iso = /(Z|[+-]\d\d:?\d\d)$/.test(ts) ? ts : `${ts}Z`
  const ms = Date.parse(iso)
  return Number.isNaN(ms) ? Date.now() : ms
}

// Map a persisted flat doc into the same {input, output, sentAt} shape the UI renders.
function normalizeDoc(d: RawReading): CombinedReading {
  return {
    input: {
      sensor_id: d.sensor_id,
      temperature: d.temperature,
      humidity: d.humidity,
      co2_ppm: d.co2_ppm ?? 0,
      co_ppm: d.co_ppm ?? 0,
    },
    output: {
      sensor_id: d.sensor_id,
      anomaly_detected: d.anomaly_detected ?? false,
      inserted_id: '',
      timestamp: d.timestamp,
      cognitive_action: d.cognitive_action ?? {
        ac_status: 'STANDBY', cooling_mode: null, target: null, thermal_load_offset: 0, model: 'none',
      },
    },
    sentAt: parseTs(d.timestamp),
  }
}

// Qualitative thermal-load label from the model's °C offset.
function loadLabel(offset?: number): { text: string; status: MetricStatus } {
  const v = Math.abs(offset ?? 0)
  if (v >= 1.5) return { text: 'Alta', status: 'elevated' }
  if (v >= 0.5) return { text: 'Media', status: 'warning' }
  return { text: 'Baja', status: 'normal' }
}

// Map a shared threshold level → MetricCard status (drives default glyph) and →
// the exact card accent tokens (border / icon chip / text) from the shared palette.
const LEVEL_TO_STATUS: Record<SensorLevel, MetricStatus> = {
  normal: 'normal', atencion: 'warning', elevado: 'elevated', alerta: 'alert',
}
// Non-normal levels → exact threshold palette; normal → undefined so the card
// falls back to STATUS_TOKENS.normal (verde esmeralda del "sistema de colores de estado").
function levelTone(level: SensorLevel) {
  if (level === 'normal') return undefined
  const tk = sensorTokens(level)
  return { bar: tk.bar, ring: tk.ring, icon: tk.text }
}

// One stat tile inside the cognitive panel grid.
function StatTile({ label, value, valueClass = 'text-white' }: {
  label: string; value: string; valueClass?: string
}) {
  return (
    <div className="bg-slate-900/50 border border-slate-700/50 rounded-lg p-3">
      <p className="text-xs text-slate-400 mb-1">{label}</p>
      <p className={`text-lg font-bold ${valueClass}`}>{value}</p>
    </div>
  )
}

function CognitivePanel({ reading }: { reading: CombinedReading | null }) {
  const action = reading?.output.cognitive_action
  const room = reading?.output.room_context
  const isOn = action?.ac_status === 'ON'
  const load = loadLabel(action?.thermal_load_offset)
  const acText = isOn ? (action?.cooling_mode ?? 'Enfriar') : 'En espera'

  return (
    <div className="bg-slate-800 border border-slate-700/60 rounded-xl p-5 flex flex-col gap-4">
      {/* Header — icon chip, title/subtitle, model badge */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className={`w-10 h-10 rounded-full ring-1 flex items-center justify-center shrink-0 ${
            isOn ? 'bg-purple-500/15 ring-purple-500/40 text-purple-400' : 'bg-slate-700/50 ring-slate-600/50 text-slate-400'
          }`}>
            <BrainCircuit size={20} />
          </span>
          <div>
            <p className="text-sm font-semibold text-white leading-tight">
              {isOn ? 'Predicción activa' : 'Acción cognitiva'}
            </p>
            <p className="text-xs text-slate-400">
              {room?.room_name ?? reading?.output.sensor_id ?? 'Sin contexto'}
            </p>
          </div>
        </div>
        {action?.model && action.model !== 'none' && (
          <span className="text-xs font-medium text-violet-300 bg-violet-500/10 border border-violet-500/30 px-2.5 py-1 rounded-full capitalize shrink-0">
            {action.model}
          </span>
        )}
      </div>

      {/* 2×2 stat grid */}
      <div className="grid grid-cols-2 gap-3">
        <StatTile label="Target ajustado" value={fmt(action?.target, '°C')} valueClass="text-cyan-300" />
        <StatTile label="Carga térmica" value={load.text} valueClass={STATUS_TOKENS[load.status].icon} />
        <StatTile
          label="Personas esperadas"
          value={room ? `${room.expected_people ?? '—'} / ${room.max_capacity}` : '—'}
        />
        {/* Acción AC — badge compacto en una sola línea (no rompe en dos) */}
        <div className="bg-slate-900/50 border border-slate-700/50 rounded-lg p-3">
          <p className="text-xs text-slate-400 mb-1">Acción AC</p>
          <span className={`inline-flex items-center whitespace-nowrap rounded-full px-[10px] py-[3px] text-[12px] font-semibold border ${
            isOn
              ? 'bg-green-500/10 border-green-500/30 text-green-500'
              : 'bg-slate-700/40 border-slate-600/40 text-slate-400'
          }`}>
            {acText}
          </span>
        </div>
      </div>
    </div>
  )
}

export default function GlobalDashboard() {
  const [readings, setReadings] = useState<CombinedReading[]>([])
  const [apiOnline, setApiOnline] = useState<boolean | null>(null)
  const [engine, setEngine] = useState<'ml' | 'heuristic' | null>(null)
  const [reloadingModel, setReloadingModel] = useState(false)
  const { user } = useAuth()
  const isAdmin = user?.role === 'admin'
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [form, setForm] = useState<ReadingInput>({ sensor_id: SENSOR_IDS[0], temperature: 24.5, humidity: 55, co2_ppm: 800, co_ppm: 0 })
  const [autoMode, setAutoMode] = useState(false)
  // 'real' = persisted sensor readings polled from Mongo; 'sim' = synthetic buffer (this tab only)
  const [mode, setMode] = useState<'real' | 'sim'>('real')

  const checkHealth = useCallback(async () => {
    try {
      const { data } = await axios.get<{ engine?: 'ml' | 'heuristic' }>('/health')
      setApiOnline(true)
      setEngine(data?.engine ?? null)
    } catch { setApiOnline(false) }
  }, [])

  // Pick up a freshly trained model.joblib without restarting the backend.
  const reloadModel = useCallback(async () => {
    setReloadingModel(true)
    try {
      const { data } = await api.post<{ engine?: 'ml' | 'heuristic' }>('/admin/model/reload')
      setEngine(data?.engine ?? null)
    } catch { /* surfaced via the unchanged badge */ }
    finally { setReloadingModel(false) }
  }, [])

  useEffect(() => {
    checkHealth()
    const t = setInterval(checkHealth, 30_000)
    return () => clearInterval(t)
  }, [checkHealth])

  const sendReading = useCallback(async (input: ReadingInput) => {
    setSending(true); setError(null)
    try {
      console.log('[FRONTEND-SIM] POST /sensors/', { sensor_id: input.sensor_id, co_ppm: input.co_ppm, source: 'GlobalDashboard' })
      const { data } = await api.post('/sensors/', { ...input, is_simulated: true, timestamp: new Date().toISOString() })
      setReadings(prev => [...prev.slice(-(MAX_POINTS - 1)), { input, output: data, sentAt: Date.now() }])
    } catch (err: unknown) {
      const msg = getApiErrorDetail(err)
        ?? 'Error desconocido'
      setError(String(msg))
    } finally { setSending(false) }
  }, [])

  // Real mode: poll persisted readings, drop simulated ones, render chronologically.
  useEffect(() => {
    if (mode !== 'real') return
    let cancelled = false
    const fetchReal = async () => {
      try {
        const { data } = await api.get<RawReading[]>('/sensors/?limit=200')
        if (cancelled) return
        const norm = (data ?? [])
          .filter(d => !d.is_simulated)
          .map(normalizeDoc)
          .sort((a, b) => a.sentAt - b.sentAt)
          .slice(-MAX_POINTS)
        setReadings(norm)
        setError(null)
      } catch (err: unknown) {
        if (cancelled) return
        const msg = getApiErrorDetail(err)
          ?? 'Error cargando lecturas reales'
        setError(String(msg))
      }
    }
    fetchReal()
    const t = setInterval(fetchReal, 5_000)
    return () => { cancelled = true; clearInterval(t) }
  }, [mode])

  // Sim mode: auto-generate synthetic readings every 4s while the toggle is on.
  useEffect(() => {
    if (mode !== 'sim' || !autoMode) return   // guard: only runs in sim mode with auto on

    const interval = setInterval(() => {
      sendReading({
        sensor_id: SENSOR_IDS[Math.floor(Math.random() * SENSOR_IDS.length)],
        temperature: parseFloat((15 + Math.random() * 30).toFixed(1)),
        humidity: parseFloat((30 + Math.random() * 65).toFixed(1)),
        co2_ppm: parseFloat((350 + Math.random() * 1500).toFixed(0)),
        co_ppm: parseFloat(
          (Math.random() < 0.1 ? 55 + Math.random() * 95 : Math.random() * 10).toFixed(1)
        ),
      })
    }, 4_000)

    return () => clearInterval(interval)
  }, [mode, autoMode, sendReading])

  // Wipe synthetic data server-side (DELETE /sensors/simulated) and drop the
  // orange emergency state locally — leaving sim mode must not keep feeding
  // /emergencies for up to 15 s until the backend purge window expires.
  const { clearSimulated } = useEmergency()
  const purgeSimulated = useCallback(() => {
    api.delete('/sensors/simulated').catch(() => {})
    clearSimulated()
  }, [clearSimulated])

  // On unmount (navigating to any other page) while in sim mode: same purge.
  const modeRef = useRef(mode)
  useEffect(() => { modeRef.current = mode }, [mode])
  useEffect(() => () => {
    if (modeRef.current === 'sim') purgeSimulated()
  }, [purgeSimulated])

  // Switch source. Never mix real and synthetic buffers — clear on every transition.
  const switchMode = useCallback((next: 'real' | 'sim') => {
    if (next === mode) return
    setMode(next)
    setReadings([])
    if (next === 'real') {
      setAutoMode(false)
      purgeSimulated()
    }
  }, [mode, purgeSimulated])

  // Manual send forces Simulación (sending test data is inherently a sim action).
  const handleManualSend = useCallback(() => {
    if (mode !== 'sim') { setMode('sim'); setReadings([]) }
    sendReading(form)
  }, [mode, form, sendReading])

  // Enabling auto-simulate also forces Simulación.
  const toggleAuto = useCallback(() => {
    if (!autoMode && mode !== 'sim') { setMode('sim'); setReadings([]) }
    setAutoMode(v => !v)
  }, [autoMode, mode])

  const latest = readings[readings.length - 1] ?? null
  const anomalyCount = readings.filter(r => r.output.anomaly_detected).length
  const chartData = readings.map(r => ({
    time: timeLabel(r.sentAt),
    temperature: r.input.temperature,
    humidity: r.input.humidity,
    target: r.output.cognitive_action?.target ?? null,
  }))

  // Threshold levels for the metric cards (shared palette). Temp compared vs the
  // adjusted target; without one, fall back to the reading itself → diff 0 → normal.
  const tempTarget = latest?.output.cognitive_action?.target ?? latest?.input.temperature ?? 0
  const tempLvl = latest ? levelTemp(latest.input.temperature, tempTarget) : null
  const humLvl  = latest ? levelHumedad(latest.input.humidity) : null
  const co2Lvl  = latest ? levelCO2(latest.input.co2_ppm) : null
  const coLvl   = latest ? levelCO(latest.input.co_ppm) : null

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <LayoutDashboard size={22} className="text-blue-400" />
          <div>
            <h1 className="text-xl font-bold text-white">Dashboard Global</h1>
            <p className="text-sm text-slate-400">Monitoreo en tiempo real</p>
          </div>
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          {/* Data source toggle: persisted real readings vs synthetic buffer */}
          <div className="flex items-center gap-0.5 bg-slate-800 border border-slate-700 rounded-lg p-0.5">
            <button
              onClick={() => switchMode('real')}
              className={`flex items-center gap-1.5 px-3 py-1 rounded-md text-xs font-medium transition-colors ${
                mode === 'real' ? 'bg-blue-600 text-white' : 'text-slate-400 hover:text-slate-100'
              }`}
            >
              <span className={`w-1.5 h-1.5 rounded-full ${mode === 'real' ? 'bg-emerald-300 animate-pulse' : 'bg-slate-500'}`} />
              Tiempo real
            </button>
            <button
              onClick={() => switchMode('sim')}
              className={`flex items-center gap-1.5 px-3 py-1 rounded-md text-xs font-medium transition-colors ${
                mode === 'sim' ? 'bg-amber-600 text-white' : 'text-slate-400 hover:text-slate-100'
              }`}
            >
              <FlaskConical size={12} />
              Simulación
            </button>
          </div>
          <div className="flex items-center gap-2 text-sm">
            {engine && (
              <span
                title={engine === 'ml'
                  ? 'Modelo ML cargado — predicción de carga térmica entrenada'
                  : 'Sin modelo entrenado — fallback heurístico (personas × carga)'}
                className={`flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full border ${
                  engine === 'ml'
                    ? 'text-violet-300 bg-violet-500/10 border-violet-500/30'
                    : 'text-slate-300 bg-slate-700/50 border-slate-600/60'
                }`}
              >
                {engine === 'ml' ? <BrainCircuit size={12} /> : <Cpu size={12} />}
                Motor: {engine === 'ml' ? 'ML' : 'Heurístico'}
              </span>
            )}
            {isAdmin && (
              <button
                onClick={reloadModel}
                disabled={reloadingModel}
                title="Recargar modelo ML desde disco (tras reentrenar)"
                className="flex items-center gap-1 text-xs text-slate-400 hover:text-slate-100 disabled:opacity-50 border border-slate-700 hover:border-slate-600 rounded-full px-2 py-0.5 transition-colors"
              >
                <RefreshCw size={12} className={reloadingModel ? 'animate-spin' : ''} />
                {reloadingModel ? 'Recargando…' : 'Recargar modelo'}
              </button>
            )}
            {apiOnline === null
              ? <span className="flex items-center gap-1 text-slate-400"><RefreshCw size={13} className="animate-spin" /> Verificando…</span>
              : apiOnline
                ? <span className="flex items-center gap-1 text-emerald-400">● API en línea</span>
                : <span className="flex items-center gap-1 text-red-400">● API sin conexión</span>}
            <span className="flex items-center gap-1 text-xs text-slate-500 tabular-nums min-w-[52px] justify-end"><Clock size={12} />{latest ? timeLabel(latest.sentAt) : '—'}</span>
          </div>
        </div>
      </div>

      {latest?.output.anomaly_detected && (
        <div className="bg-red-900/40 border border-red-500/50 rounded-xl px-4 py-3 flex items-center gap-3">
          <AlertTriangle size={20} className="text-red-400 shrink-0" />
          <span className="font-semibold text-red-300">Anomalía — </span>
          <span className="text-slate-300 text-sm">
            {latest.output.sensor_id} · {fmt(latest.input.temperature, '°C')} · {fmt(latest.input.humidity, '% HR')}
            {latest.input.co_ppm > 50 && ` · CO: ${fmt(latest.input.co_ppm, ' ppm', 1)} ⚠`}
          </span>
        </div>
      )}
      {error && <div className="bg-orange-900/40 border border-orange-500/50 rounded-xl px-4 py-3 text-sm text-orange-300">⚠ {error}</div>}

      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
        <MetricCard
          icon={<Thermometer size={18} />} label="Temperatura"
          value={fmt(latest?.input.temperature, '', 1)} unit={latest ? '°C' : undefined}
          status={tempLvl ? LEVEL_TO_STATUS[tempLvl] : 'normal'}
          tone={tempLvl ? levelTone(tempLvl) : undefined}
          statusText={tempLvl ? getStatusLabel(tempLvl) : undefined}
          sub={latest ? undefined : 'Sin datos'}
        />
        <MetricCard
          icon={<Droplets size={18} />} label="Humedad"
          value={fmt(latest?.input.humidity, '', 0)} unit={latest ? '%' : undefined}
          status={humLvl ? LEVEL_TO_STATUS[humLvl] : 'normal'}
          tone={humLvl ? levelTone(humLvl) : undefined}
          statusText={humLvl ? getStatusLabel(humLvl) : undefined}
          sub={latest ? undefined : 'Sin datos'}
        />
        <MetricCard
          icon={<Wind size={18} />} label="CO₂"
          value={fmt(latest?.input.co2_ppm, '', 0)} unit={latest ? 'ppm' : undefined}
          status={co2Lvl ? LEVEL_TO_STATUS[co2Lvl] : 'normal'}
          tone={co2Lvl ? levelTone(co2Lvl) : undefined}
          statusText={co2Lvl ? getStatusLabel(co2Lvl) : undefined}
          sub={latest ? undefined : 'Sin datos'}
        />
        <MetricCard
          icon={<CloudFog size={18} />} label="CO"
          value={fmt(latest?.input.co_ppm, '', 1)} unit={latest ? 'ppm' : undefined}
          status={coLvl ? LEVEL_TO_STATUS[coLvl] : 'normal'}
          tone={coLvl ? levelTone(coLvl) : undefined}
          statusText={coLvl ? getStatusLabel(coLvl) : undefined}
          sub={latest ? 'Límite EPA: 50 ppm' : 'Sin datos'}
        />
        <MetricCard
          icon={anomalyCount > 0 ? <AlertTriangle size={18} /> : <CheckCircle size={18} />} label="Anomalías"
          value={String(anomalyCount)}
          status={anomalyCount > 0 ? 'alert' : 'normal'}
          statusIcon={null}
          sub={`de ${readings.length} lecturas`}
        />
      </div>

      <div className="bg-slate-800/40 border border-slate-700/50 rounded-xl px-4 py-3">
        <p className="text-xs text-slate-500 uppercase tracking-wide mb-2">Sistema de colores de estado</p>
        <StatusLegend />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 bg-slate-800 rounded-xl p-5">
          <h2 className="text-slate-300 text-sm font-semibold uppercase tracking-wide mb-4">Historial (últimas {MAX_POINTS})</h2>
          {chartData.length === 0
            ? <div className="h-64 flex items-center justify-center">
                <EmptyState
                  icon={<Inbox size={22} />}
                  title={mode === 'real' ? 'Sin lecturas reales todavía' : 'Aún no hay datos'}
                  hint={mode === 'real'
                    ? 'Conecta un sensor o publica en POST /api/v1/sensors/ para ver el historial.'
                    : 'Genera tu primera lectura sintética para ver el modelo cognitivo en acción.'}
                  action={mode === 'real'
                    ? { label: 'Probar en simulación', onClick: () => switchMode('sim') }
                    : { label: 'Enviar lectura de prueba', onClick: handleManualSend }}
                />
              </div>
            : (
              <ResponsiveContainer width="100%" height={280}>
                <LineChart data={chartData} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                  <XAxis dataKey="time" stroke="#64748b" tick={{ fontSize: 11 }} interval="preserveStartEnd" minTickGap={32} />
                  {/* Eje izquierdo → °C (temperatura + target). Tope a 42 para mostrar el límite de 40°C. */}
                  <YAxis
                    yAxisId="left"
                    stroke="#64748b"
                    tick={{ fontSize: 11 }}
                    domain={[15, 42]}
                    label={{ value: '°C', angle: -90, position: 'insideLeft', fill: '#64748b', fontSize: 11 }}
                  />
                  {/* Eje derecho → % humedad relativa. */}
                  <YAxis
                    yAxisId="right"
                    orientation="right"
                    stroke="#64748b"
                    tick={{ fontSize: 11 }}
                    domain={[0, 100]}
                    label={{ value: '%', angle: 90, position: 'insideRight', fill: '#64748b', fontSize: 11 }}
                  />
                  <Tooltip contentStyle={{ backgroundColor: '#1e293b', border: '1px solid #334155', borderRadius: '8px', color: '#e2e8f0' }} />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <ReferenceLine yAxisId="left" y={40} stroke="#ef4444" strokeOpacity={0.6} strokeDasharray="4 2" label={{ value: 'Límite temp (40°C)', fill: '#ef4444', fontSize: 10 }} />
                  <Line yAxisId="left" type="monotone" dataKey="temperature" name="Temperatura (°C)" stroke="#38bdf8" strokeWidth={2} dot={false} activeDot={{ r: 4 }} />
                  <Line yAxisId="right" type="monotone" dataKey="humidity" name="Humedad (%)" stroke="#a855f7" strokeWidth={2} dot={false} activeDot={{ r: 4 }} />
                  <Line yAxisId="left" type="monotone" dataKey="target" name="Target AC (°C)" stroke="#22c55e" strokeWidth={1.5} strokeDasharray="5 3" dot={false} />
                </LineChart>
              </ResponsiveContainer>
            )}
        </div>
        <CognitivePanel reading={latest} />
      </div>

      {/* Recent table */}
      <div className="bg-slate-800 rounded-xl p-5 overflow-x-auto">
        <h2 className="text-slate-300 text-sm font-semibold uppercase tracking-wide mb-4">Lecturas Recientes</h2>
        {readings.length === 0
          ? <EmptyState
              icon={<Inbox size={22} />}
              title={mode === 'real' ? 'Sin lecturas reales registradas' : 'Sin lecturas todavía'}
              hint={mode === 'real'
                ? 'Las lecturas publicadas en la API aparecerán aquí en tiempo real.'
                : 'Envía una lectura de prueba para poblar la tabla.'}
              action={mode === 'real'
                ? { label: 'Probar en simulación', onClick: () => switchMode('sim') }
                : { label: 'Enviar lectura de prueba', onClick: handleManualSend }}
            />
          : (
            <table className="w-full min-w-[680px] text-sm">
              <thead>
                <tr className="text-slate-400 text-xs uppercase border-b border-slate-700">
                  {['Sensor', 'Temp', 'Humedad', 'CO₂', 'CO', 'AC', 'Anomalía', 'Hora'].map(h => (
                    <th key={h} className="text-left pb-2 pr-4 last:text-right">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {[...readings].reverse().slice(0, 15).map(r => (
                  <tr key={r.output.inserted_id || r.sentAt} className={`border-b border-slate-700/50 ${r.output.anomaly_detected ? 'bg-red-900/10' : ''}`}>
                    <td className="py-2 pr-4 font-mono text-slate-300">{r.output.sensor_id}</td>
                    <td className={`py-2 pr-4 font-semibold ${getColorTemp(r.input.temperature, r.output.cognitive_action?.target ?? r.input.temperature)}`}>{fmt(r.input.temperature, '°C')}</td>
                    <td className={`py-2 pr-4 font-semibold ${getColorHumedad(r.input.humidity)}`}>{fmt(r.input.humidity, '%')}</td>
                    <td className={`py-2 pr-4 font-semibold ${getColorCO2(r.input.co2_ppm)}`}>{fmt(r.input.co2_ppm, '', 0)}</td>
                    <td className={`py-2 pr-4 font-semibold ${getColorCO(r.input.co_ppm)}`}>
                      {fmt(r.input.co_ppm, ' ppm', 1)}
                    </td>
                    <td className="py-2 pr-4">
                      <span className={`text-xs font-bold px-2 py-0.5 rounded ${r.output.cognitive_action?.ac_status === 'ON' ? 'bg-blue-900/50 text-blue-300' : 'bg-slate-700 text-slate-400'}`}>
                        {r.output.cognitive_action?.ac_status ?? '—'}
                      </span>
                    </td>
                    <td className="py-2 pr-4 text-center">
                      {r.output.anomaly_detected ? <AlertTriangle size={14} className="text-red-400 inline" /> : <CheckCircle size={14} className="text-emerald-400 inline" />}
                    </td>
                    <td className="py-2 text-right text-slate-400 text-xs">{timeLabel(r.sentAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
      </div>

      {/* Dev tools — synthetic data generator */}
      <div className="border-2 border-dashed border-amber-600/40 bg-amber-950/10 rounded-xl overflow-hidden">
        {/* Banner */}
        <div className="flex items-center gap-2 bg-amber-900/25 border-b border-amber-600/30 px-4 py-2.5">
          <FlaskConical size={15} className="text-amber-400 shrink-0" />
          <span className="text-xs font-semibold text-amber-300 uppercase tracking-wider">
            Herramientas de Desarrollador · Generador de Datos Sintéticos
          </span>
        </div>

        <div className="p-5">
          <p className="text-xs text-amber-500/80 mb-5">
            Esta zona es exclusiva para pruebas. Los datos enviados aquí simulan lecturas de sensores
            reales y permiten observar la reacción del modelo de Inteligencia Artificial cognitivo
            sin necesidad de hardware físico.
          </p>

          <div className="flex items-center justify-between mb-4">
            <h2 className="text-slate-400 text-xs font-semibold uppercase tracking-wide">
              Enviar Lectura Manual
            </h2>
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <span className="text-xs text-slate-400">Auto-simular (4s)</span>
              <div
                onClick={toggleAuto}
                className={`w-10 h-5 rounded-full transition-colors relative ${autoMode ? 'bg-amber-600' : 'bg-slate-600'}`}
              >
                <div className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${autoMode ? 'translate-x-5' : 'translate-x-0.5'}`} />
              </div>
            </label>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-4">
            <SearchableSelect
              options={SENSOR_IDS.map(s => ({ value: s, label: s }))}
              value={form.sensor_id}
              onChange={v => setForm(f => ({ ...f, sensor_id: v }))}
              placeholder="Selecciona un sensor…"
              label="Sensor ID"
              icon={<Cpu size={16} />}
              maxVisibleItems={2}
            />
            {(['temperature', 'humidity', 'co2_ppm', 'co_ppm'] as const).map(field => (
              <div key={field}>
                <label className={LABEL_CLS}>
                  {field === 'temperature' ? 'Temperatura (°C)'
                    : field === 'humidity' ? 'Humedad (%)'
                    : field === 'co2_ppm' ? 'CO₂ (ppm)'
                    : 'CO (ppm)'}
                </label>
                <input
                  type="number"
                  step={field === 'co2_ppm' ? '1' : '0.1'}
                  value={form[field]}
                  onChange={e => setForm(f => ({ ...f, [field]: parseFloat(e.target.value) }))}
                  className={NUM_INPUT_CLS}
                />
              </div>
            ))}
          </div>

          <button
            onClick={handleManualSend}
            disabled={sending || autoMode}
            className="flex items-center gap-2 bg-amber-700 hover:bg-amber-600 disabled:bg-slate-600 disabled:cursor-not-allowed text-white text-sm font-semibold px-5 py-2 rounded-lg transition-colors"
          >
            {sending
              ? <><RefreshCw size={14} className="animate-spin" /> Enviando…</>
              : <><Send size={14} /> Enviar lectura de prueba</>}
          </button>
        </div>
      </div>
    </div>
  )
}
