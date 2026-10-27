import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, Legend, ResponsiveContainer,
} from 'recharts'
import {
  Thermometer, Droplets, Wind, AlertTriangle,
  CheckCircle, RefreshCw, Send, Clock, FlaskConical, CloudFog,
  BrainCircuit, Inbox, Cpu, LayoutDashboard, Fan, Flame, BellRing, Sigma,
  Activity, Building2, Clapperboard,
} from 'lucide-react'
import api, { getApiErrorDetail } from '../api/client'
import { useHealth, refreshHealth, useNow, ingestLabel } from '../utils/live'
import { useAuth } from '../context/AuthContext'
import { useEmergency } from '../context/EmergencyContext'
import type { CombinedReading, ReadingInput, StoredReading, NodeMetrics, OriginFilter, HealthInfo } from '../types'
import {
  MetricCard, StatusLegend, STATUS_TOKENS, type MetricStatus,
} from '../components/MetricCard'
import { EmptyState } from '../components/EmptyState'
import {
  getColorTemp, getColorHumedad, getColorCO2, getColorCO,
  levelTemp, levelHumedad, levelCO2, levelCO, getStatusLabel,
  LEVEL_TO_STATUS, levelTone, NEUTRAL_TEXT,
} from '../utils/sensorColors'
import {
  decisionOf, fanPwmOf, fmtNum, parseUtcMs, isSimulatedReading, CO_ALARM_PPM,
  mqttTopic, originAutoSwitch,
} from '../utils/node'
import {
  DecisionBadge, NodeLinkBadge, OriginBadge, OriginToggle, originSummary,
  NodeKpiGrid, AlarmOverrideBadge, overrideNote, OriginFallbackNotice, intervalOf,
} from '../components/NodeWidgets'
import SearchableSelect from '../components/SearchableSelect'

const SENSOR_IDS = ['SIM-sensor-001', 'SIM-sensor-002', 'SIM-sensor-003']
const SIM_PERIOD_S = 4      // periodo del simulador (umbral de antigüedad = máx(3 × 4 s, 30 s))
const MAX_POINTS = 40
const PILOT_ROOM = 'A403'   // único nodo físico (docs/hardware-spec.md)

const INPUT_CLS = "w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2.5 text-sm text-slate-100 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500/50 transition placeholder-slate-500"
const NUM_INPUT_CLS = `${INPUT_CLS} [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none`
const LABEL_CLS = "block text-xs font-medium text-slate-400 mb-1.5 uppercase tracking-wide"

interface RoomOpt { id: string; name: string; target_temp: number; max_capacity: number }

function timeLabel(ms: number) {
  return new Date(ms).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

// Sim buffer entry → same flat shape as a persisted reading.
function toStored(c: CombinedReading): StoredReading {
  return {
    ...c.input,
    anomaly_detected: c.output.anomaly_detected,
    timestamp: new Date(c.sentAt).toISOString(),
    cognitive_action: c.output.cognitive_action,
    power: c.output.power ?? null,
  }
}

function loadLabel(offset?: number | null): { text: string; status: MetricStatus } {
  if (offset == null) return { text: '—', status: 'normal' }
  const v = Math.abs(offset)
  if (v >= 1.5) return { text: 'Alta', status: 'elevated' }
  if (v >= 0.5) return { text: 'Media', status: 'warning' }
  return { text: 'Baja', status: 'normal' }
}

function StatTile({ label, value, valueClass = 'text-white' }: { label: string; value: React.ReactNode; valueClass?: string }) {
  return (
    <div className="bg-slate-900/50 border border-slate-700/50 rounded-lg p-3">
      <p className="text-xs text-slate-400 mb-1">{label}</p>
      <div className={`text-lg font-bold ${valueClass}`}>{value}</div>
    </div>
  )
}

function CognitivePanel({ reading, title }: { reading: StoredReading | null; title: string }) {
  const action = reading?.cognitive_action ?? null
  const state = decisionOf(action)
  const load = loadLabel(action?.thermal_load_offset)
  const fan = fanPwmOf(reading, action)
  const override = overrideNote(reading, action)
  return (
    <div className="bg-slate-800 border border-slate-700/60 rounded-xl p-5 flex flex-col gap-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="w-10 h-10 rounded-full ring-1 flex items-center justify-center shrink-0 bg-blue-500/15 ring-blue-500/40 text-blue-400">
            <Sigma size={20} />
          </span>
          <div>
            <p className="text-sm font-semibold text-white leading-tight">Decisión de la heurística</p>
            <p className="text-xs text-slate-400">{title}</p>
          </div>
        </div>
        <div className="flex flex-col items-end gap-1">
          <DecisionBadge state={state} />
          <AlarmOverrideBadge reading={reading} />
        </div>
      </div>
      {override && <p className="text-xs text-red-300 -mt-2">{override}</p>}
      <div className="grid grid-cols-2 gap-3">
        <StatTile label="Objetivo ajustado" value={fmtNum(action?.target, '°C')} valueClass="text-cyan-300" />
        <StatTile label="Carga térmica" value={load.text} valueClass={action?.thermal_load_offset == null ? NEUTRAL_TEXT : STATUS_TOKENS[load.status].icon} />
        <StatTile label="Ocupación (reserva / CO₂)" value={`${action?.expected_occupancy ?? '—'} / ${fmtNum(action?.actual_occupancy, '', 0)}`} />
        <StatTile label={`Ventilador (${fan.source})`} value={fmtNum(fan.value, ' %', 0)} valueClass="text-sky-300" />
      </div>
      <div className="flex items-start gap-2 bg-slate-900/40 border border-dashed border-violet-500/30 rounded-lg px-3 py-2">
        <BrainCircuit size={14} className="text-violet-400 shrink-0 mt-0.5" />
        <div className="text-xs text-slate-400 min-w-0">
          <span className="text-slate-300">ML en sombra: </span>
          {action?.ml_action
            ? <><DecisionBadge state={action.ml_action} className="ml-1" />{' '}
                {action.ml_action === action.heuristic_action ? <span className="text-emerald-400">coincide</span> : <span className="text-amber-300">diverge</span>}</>
            : <span className="text-slate-500">{action?.ml_reason ?? 'sin predicción'}</span>}
        </div>
      </div>
    </div>
  )
}

// ── Simulador por nodo (paseo aleatorio + escenarios) ─────────────────────────
type Scenario = 'normal' | 'llenando' | 'fuga_co' | 'sin_red'
const SCENARIOS: { value: Scenario; label: string; hint: string }[] = [
  { value: 'normal',   label: 'Operación normal',  hint: 'Deriva suave de T/HR/CO₂; el ventilador aplica el último comando' },
  { value: 'llenando', label: 'Aula llenándose',   hint: 'CO₂ y temperatura suben: se observa ON / PRE-COOLING y el PWM' },
  { value: 'fuga_co',  label: 'Fuga de CO',        hint: 'CO sube sobre 50 ppm: alarma local, buzzer/LED y ventilador 100 %' },
  { value: 'sin_red',  label: 'Nodo sin red',      hint: 'Simula pérdida de enlace: el nodo deja de publicar (hueco en la serie) y el badge pasa a fuera de línea por antigüedad (> 30 s); en el nodo, la alarma de CO sigue siendo local' },
]

interface SimState {
  temp: number; hum: number; co2: number; co: number
  fanCmd: number; uptime: number
}

function gauss(sd = 1) {
  const u = 1 - Math.random(), v = Math.random()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v) * sd
}
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x))
const r1 = (x: number, d = 1) => Number(x.toFixed(d))

// El simulador NO trae constantes de potencia propias: usa el modelo nominal que
// publica el backend en /health (power_model). Sin él, no inventa power_w.
function stepSim(s: SimState, scenario: Exclude<Scenario, 'sin_red'>, sensorId: string, pm: HealthInfo['power_model']): ReadingInput {
  const fanEffect = s.fanCmd / 100 * 0.12           // °C por paso que retira el ventilador
  if (scenario === 'llenando') {
    s.co2 = clamp(s.co2 + 40 + Math.random() * 40, 400, 1900)
    s.temp = clamp(s.temp + 0.12 - fanEffect + gauss(0.03), 16, 34)
    s.hum = clamp(s.hum + 0.3 + gauss(0.3), 30, 90)
  } else {
    s.co2 = clamp(s.co2 + gauss(15) - (s.co2 - 650) * 0.05, 400, 1900)
    s.temp = clamp(s.temp + (24 - s.temp) * 0.03 + 0.04 - fanEffect + gauss(0.05), 16, 34)
    s.hum = clamp(s.hum + gauss(0.4), 30, 90)
  }
  s.co = scenario === 'fuga_co'
    ? clamp(s.co + 12 + Math.random() * 8, 0, 160)
    : clamp(s.co * 0.6 + 1.5 + gauss(0.3), 0, 160)
  const alarm = s.co > CO_ALARM_PPM
  // Fail-safe local: CO alto → ventilador 100 % + buzzer/LED.
  const pwm = alarm ? 100 : s.fanCmd
  const busV = r1(12 + gauss(0.04), 2)
  // INA219 en la rama del actuador: mide solo el ventilador (la electrónica es nominal).
  const powerW = pm ? Math.max(0, pm.fan_max_power_w * pwm / 100 + gauss(0.02)) : null
  s.uptime += SIM_PERIOD_S
  return {
    sensor_id: sensorId,
    temperature: r1(s.temp),
    humidity: r1(s.hum),
    co2_ppm: Math.round(s.co2),
    co_ppm: r1(s.co),
    fan_pwm: r1(pwm, 0),
    heater_on: false,
    alarm_active: alarm,
    rssi_dbm: Math.round(-62 + gauss(4)),
    latency_ms: Math.round(clamp(700 + gauss(250), 250, 2600)),
    power_w: powerW == null ? null : r1(powerW, 3),
    bus_voltage_v: powerW == null ? null : busV,
    current_ma: powerW == null ? null : r1(powerW / busV * 1000, 0),
    uptime_s: s.uptime,
    data_origin: 'simulator',
  }
}

export default function GlobalDashboard() {
  const { data: health, online: apiOnline } = useHealth()
  const now = useNow(5_000)
  const [reloadingModel, setReloadingModel] = useState(false)
  const { user } = useAuth()
  const isAdmin = user?.role === 'admin'
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [form, setForm] = useState<{ sensor_id: string; temperature: number; humidity: number; co2_ppm: number; co_ppm: number }>(
    { sensor_id: SENSOR_IDS[0], temperature: 24.5, humidity: 55, co2_ppm: 800, co_ppm: 0 })
  const [autoMode, setAutoMode] = useState(false)
  const [scenario, setScenario] = useState<Scenario>('normal')
  const [mode, setMode] = useState<'real' | 'sim'>('real')

  // Real mode — rooms + latest reading per room + selected room series.
  const [rooms, setRooms] = useState<RoomOpt[]>([])
  const [roomLatest, setRoomLatest] = useState<Record<string, StoredReading | null>>({})
  const [selectedRoom, setSelectedRoom] = useState<string>('')
  const [roomReadings, setRoomReadings] = useState<StoredReading[]>([])
  const [metrics, setMetrics] = useState<NodeMetrics | null>(null)
  const [originFilter, setOriginFilter] = useState<OriginFilter>('node')
  const [originTouched, setOriginTouched] = useState(false)
  const [originFallback, setOriginFallback] = useState(false)
  const changeOrigin = useCallback((v: OriginFilter) => {
    setOriginTouched(true); setOriginFallback(false); setOriginFilter(v)
  }, [])
  const powerModelRef = useRef<HealthInfo['power_model']>(undefined)
  useEffect(() => { powerModelRef.current = health?.power_model }, [health])

  // Sim mode — local buffer of synthetic readings (all sim nodes).
  const [simBuffer, setSimBuffer] = useState<CombinedReading[]>([])
  const [selectedSim, setSelectedSim] = useState<string>(SENSOR_IDS[0])
  const simState = useRef<Record<string, SimState>>({})
  const scenarioRef = useRef(scenario)
  useEffect(() => { scenarioRef.current = scenario }, [scenario])
  const formSensorRef = useRef(form.sensor_id)
  useEffect(() => { formSensorRef.current = form.sensor_id }, [form.sensor_id])

  const reloadModel = useCallback(async () => {
    setReloadingModel(true)
    try {
      await api.post('/admin/model/reload')
      await refreshHealth()
    } catch { /* surfaced via the unchanged badge */ }
    finally { setReloadingModel(false) }
  }, [])

  // Al cambiar de aula: KPI solo del nodo físico en el aula piloto; todas en las demás.
  useEffect(() => {
    setOriginFilter(selectedRoom === PILOT_ROOM ? 'node' : 'all')
    setOriginTouched(false); setOriginFallback(false)
  }, [selectedRoom])

  // Rooms list (once) — default selection = aula piloto con nodo físico.
  useEffect(() => {
    api.get<RoomOpt[]>('/admin/rooms')
      .then(res => {
        const list = res.data ?? []
        setRooms(list)
        setSelectedRoom(prev => prev || (list.find(r => r.id === PILOT_ROOM)?.id ?? list[0]?.id ?? ''))
      })
      .catch(() => setRooms([]))
  }, [])

  // Real mode: overview (latest per room) every 10 s.
  useEffect(() => {
    if (mode !== 'real' || rooms.length === 0) return
    let cancelled = false
    const fetchOverview = async () => {
      const entries = await Promise.all(rooms.map(async r => {
        try {
          const { data } = await api.get<StoredReading[]>(`/sensors/?room_id=${encodeURIComponent(r.id)}&limit=1`)
          const last = (data ?? []).find(d => parseUtcMs(d.timestamp) != null) ?? null
          return [r.id, last] as const
        } catch { return [r.id, null] as const }
      }))
      if (!cancelled) setRoomLatest(Object.fromEntries(entries))
    }
    fetchOverview()
    const t = setInterval(fetchOverview, 10_000)
    return () => { cancelled = true; clearInterval(t) }
  }, [mode, rooms])

  // Real mode: selected room series (5 s) + derived metrics (30 s).
  useEffect(() => {
    if (mode !== 'real' || !selectedRoom) return
    let cancelled = false
    const fetchRoom = async () => {
      try {
        const { data } = await api.get<StoredReading[]>(`/sensors/?room_id=${encodeURIComponent(selectedRoom)}&limit=${MAX_POINTS}`)
        if (cancelled) return
        // Discard readings with invalid timestamps — never map them to "now".
        setRoomReadings((data ?? []).filter(d => parseUtcMs(d.timestamp) != null)
          .sort((a, b) => (parseUtcMs(a.timestamp)! - parseUtcMs(b.timestamp)!)))
        setError(null)
      } catch (err: unknown) {
        if (!cancelled) setError(String(getApiErrorDetail(err) ?? 'Error cargando lecturas'))
      }
    }
    const fetchMetrics = async () => {
      try {
        const { data } = await api.get<NodeMetrics>('/reports/node-metrics', { params: { room_id: selectedRoom, hours: 24, origin: originFilter } })
        if (cancelled) return
        // Sin lecturas del nodo físico → "Todas" con aviso (nunca KPI vacíos en silencio).
        const sw = data ? originAutoSwitch({ filter: originFilter, touched: originTouched, fallback: originFallback, samples: data.samples, countsAll: data.origin_counts_all }) : null
        if (sw) { setOriginFallback(sw === 'all'); setOriginFilter(sw); return }
        setMetrics(data ?? null)
      } catch { if (!cancelled) setMetrics(null) }
    }
    fetchRoom(); fetchMetrics()
    const t1 = setInterval(fetchRoom, 5_000)
    const t2 = setInterval(fetchMetrics, 30_000)
    return () => { cancelled = true; clearInterval(t1); clearInterval(t2) }
  }, [mode, selectedRoom, originFilter, originTouched, originFallback])

  const sendReading = useCallback(async (input: ReadingInput) => {
    // Never post NaN/empty values (a cleared input would send NaN).
    const nums = [input.temperature, input.humidity, input.co2_ppm, input.co_ppm]
    if (nums.some(v => v == null || Number.isNaN(v))) {
      setError('Completa temperatura, humedad, CO₂ y CO con valores numéricos.')
      return
    }
    setSending(true); setError(null)
    try {
      const { data } = await api.post('/sensors/', { ...input, is_simulated: true, timestamp: new Date().toISOString() })
      // The node applies the last command on its next cycle (retained cmd topic).
      const st = simState.current[input.sensor_id]
      const cmd = data?.cognitive_action?.fan_pwm
      if (st && typeof cmd === 'number') st.fanCmd = cmd
      setSimBuffer(prev => [...prev.slice(-(MAX_POINTS * SENSOR_IDS.length - 1)), { input, output: data, sentAt: Date.now() }])
    } catch (err: unknown) {
      setError(String(getApiErrorDetail(err) ?? 'Error desconocido'))
    } finally { setSending(false) }
  }, [])

  const simInput = useCallback((sensorId: string, sc: Scenario): ReadingInput => {
    if (!simState.current[sensorId]) {
      simState.current[sensorId] = { temp: 23 + Math.random() * 2, hum: 58, co2: 600, co: 1.5, fanCmd: 0, uptime: 0 }
    }
    return stepSim(simState.current[sensorId], sc === 'sin_red' ? 'normal' : sc, sensorId, powerModelRef.current)
  }, [])

  // Sim mode: every 4 s, one reading per simulated node; the scenario applies to
  // the node chosen in the form, the rest stay in normal operation.
  useEffect(() => {
    if (mode !== 'sim' || !autoMode) return
    const interval = setInterval(() => {
      for (const sid of SENSOR_IDS) {
        const sc = sid === formSensorRef.current ? scenarioRef.current : 'normal'
        // "Nodo sin red": un nodo sin enlace no entrega lecturas (hueco); no se publica nada.
        if (sc === 'sin_red') continue
        sendReading(simInput(sid, sc))
      }
    }, SIM_PERIOD_S * 1000)
    return () => clearInterval(interval)
  }, [mode, autoMode, sendReading, simInput])

  const { clearSimulated } = useEmergency()
  const purgeSimulated = useCallback(() => {
    api.delete('/sensors/simulated').catch(() => {})
    clearSimulated()
  }, [clearSimulated])

  const modeRef = useRef(mode)
  useEffect(() => { modeRef.current = mode }, [mode])
  useEffect(() => () => {
    if (modeRef.current === 'sim') purgeSimulated()
  }, [purgeSimulated])

  const switchMode = useCallback((next: 'real' | 'sim') => {
    if (next === mode) return
    setMode(next)
    setSimBuffer([])
    simState.current = {}
    if (next === 'real') {
      setAutoMode(false)
      purgeSimulated()
    }
  }, [mode, purgeSimulated])

  const handleManualSend = useCallback(() => {
    if (scenario === 'sin_red') {
      setError('Escenario "Nodo sin red": el nodo no publica lecturas. Elige otro escenario para enviar una lectura.')
      return
    }
    if (mode !== 'sim') { setMode('sim'); setSimBuffer([]) }
    const base = simInput(form.sensor_id, scenario)
    setSelectedSim(form.sensor_id)
    sendReading({ ...base, temperature: form.temperature, humidity: form.humidity, co2_ppm: form.co2_ppm, co_ppm: form.co_ppm })
  }, [mode, form, scenario, sendReading, simInput])

  const toggleAuto = useCallback(() => {
    if (!autoMode && mode !== 'sim') { setMode('sim'); setSimBuffer([]) }
    setAutoMode(v => !v)
  }, [autoMode, mode])

  // ── Selected node view (same shape for real and sim) ────────────────────────
  const selectedReadings: StoredReading[] = useMemo(() => (
    mode === 'real'
      ? roomReadings
      : simBuffer.filter(c => c.input.sensor_id === selectedSim).map(toStored).slice(-MAX_POINTS)
  ), [mode, roomReadings, simBuffer, selectedSim])

  const latest = selectedReadings[selectedReadings.length - 1] ?? null
  const selectedRoomInfo = rooms.find(r => r.id === selectedRoom)
  const selectedTitle = mode === 'real'
    ? (selectedRoomInfo?.name ?? (selectedRoom || 'Sin aula'))
    : `${selectedSim} (simulado)`
  // Solo cuentan lecturas con anomalía persistida (booleano); null = sin dato, no "0".
  const anomalyKnown = selectedReadings.filter(r => typeof r.anomaly_detected === 'boolean')
  const anomalyCount = anomalyKnown.filter(r => r.anomaly_detected === true).length
  const seriesSimulated = selectedReadings.length > 0 && selectedReadings.every(isSimulatedReading)

  const chartData = selectedReadings.map(r => ({
    time: timeLabel(parseUtcMs(r.timestamp)!),
    temperature: r.temperature,
    humidity: r.humidity,
    target: r.cognitive_action?.target ?? null,
    fan: fanPwmOf(r, r.cognitive_action).value,
  }))

  const tempTarget = latest?.cognitive_action?.target ?? selectedRoomInfo?.target_temp ?? null
  const tempLvl = latest && tempTarget != null ? levelTemp(latest.temperature, tempTarget) : null
  const humLvl  = latest ? levelHumedad(latest.humidity) : null
  const co2Lvl  = latest?.co2_ppm != null ? levelCO2(latest.co2_ppm) : null
  const coLvl   = latest?.co_ppm != null ? levelCO(latest.co_ppm) : null

  // Overview cards: real → one per room; sim → one per simulated node.
  const overview = mode === 'real'
    ? rooms.map(r => ({ key: r.id, title: r.name, reading: roomLatest[r.id] ?? null, topic: mqttTopic(r.id) }))
    : SENSOR_IDS.map(sid => {
        const last = [...simBuffer].reverse().find(c => c.input.sensor_id === sid)
        return { key: sid, title: sid, reading: last ? toStored(last) : null, topic: mqttTopic(sid) }
      })
  const selectedKey = mode === 'real' ? selectedRoom : selectedSim
  const selectKey = (k: string) => (mode === 'real' ? setSelectedRoom(k) : setSelectedSim(k))

  const mlLoaded = health?.ml_loaded ?? (health?.engine ? health.engine === 'ml' : null)
  const controller = health?.active_controller ?? (health ? 'heuristic' : null)

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <LayoutDashboard size={22} className="text-blue-400" />
          <div>
            <h1 className="text-xl font-bold text-white">Dashboard Global</h1>
            <p className="text-sm text-slate-400">Nodos ESP32 por aula · {ingestLabel(health)}</p>
          </div>
        </div>
        <div className="flex items-center gap-3 flex-wrap">
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
          <div className="flex items-center gap-2 text-sm flex-wrap">
            {health && (
              <span
                title="La heurística comanda el ventilador; el modelo ML se ejecuta en paralelo solo para comparar (modo sombra)."
                className="flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full border text-slate-300 bg-slate-700/50 border-slate-600/60"
              >
                {controller === 'ml' ? <BrainCircuit size={12} /> : <Sigma size={12} />}
                Control: {controller === 'ml' ? 'ML' : 'heurística'} · ML: {mlLoaded == null ? '—' : mlLoaded ? (health.ml_shadow === false ? 'activo' : 'sombra (cargado)') : 'sombra (no cargado)'}
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
          </div>
        </div>
      </div>

      {error && <div className="bg-orange-900/40 border border-orange-500/50 rounded-xl px-4 py-3 text-sm text-orange-300">⚠ {error}</div>}

      {/* ── Vista general por aula / nodo ─────────────────────────────────── */}
      <div>
        <h2 className="flex items-center gap-2 text-slate-300 text-sm font-semibold uppercase tracking-wide mb-3">
          <Building2 size={15} className="text-blue-400" /> {mode === 'real' ? 'Aulas y nodos' : 'Nodos simulados'}
        </h2>
        {overview.length === 0 ? (
          <p className="text-sm text-slate-500">{mode === 'real' ? 'No hay aulas registradas.' : 'Sin nodos simulados.'}</p>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
            {overview.map(o => {
              const r = o.reading
              const st = decisionOf(r?.cognitive_action)
              const fp = fanPwmOf(r, r?.cognitive_action)
              const alarm = r?.alarm_active === true || (r?.co_ppm != null && r.co_ppm > CO_ALARM_PPM)
              const sel = o.key === selectedKey
              return (
                <button
                  key={o.key}
                  onClick={() => selectKey(o.key)}
                  className={`text-left rounded-xl border p-4 transition-colors ${
                    alarm ? 'border-red-500/60 bg-red-950/30'
                      : sel ? 'border-blue-500/60 bg-blue-500/5' : 'border-slate-700 bg-slate-800 hover:border-slate-600'
                  }`}
                >
                  <div className="flex items-start justify-between gap-2 mb-2">
                    <p className="text-sm font-semibold text-slate-100 truncate">{o.title}</p>
                    <div className="flex flex-col items-end gap-1">
                      <DecisionBadge state={r ? st : null} />
                      <AlarmOverrideBadge reading={r} />
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5 mb-3">
                    <NodeLinkBadge reading={r} now={now} roomId={mode === 'real' ? o.key : null} intervalS={mode === 'sim' ? SIM_PERIOD_S : null} />
                    {/* "Nodo físico" solo si la última lectura lo declara (data_origin='node'). */}
                    <OriginBadge reading={r} compact />
                  </div>
                  <div className="grid grid-cols-3 gap-2 text-xs">
                    <div>
                      <p className="flex items-center gap-1 text-slate-500"><Fan size={11} /> Vent.</p>
                      <p className="font-semibold text-slate-200 tabular-nums">{fmtNum(fp.value, ' %', 0)}</p>
                    </div>
                    <div>
                      <p className="flex items-center gap-1 text-slate-500"><Flame size={11} /> PTC</p>
                      <p className="font-semibold text-slate-200">{r?.heater_on == null ? '—' : r.heater_on ? 'ON' : 'OFF'}</p>
                    </div>
                    <div>
                      <p className="flex items-center gap-1 text-slate-500"><BellRing size={11} /> CO</p>
                      <p className={`font-semibold tabular-nums ${alarm ? 'text-red-300' : 'text-slate-200'}`}>
                        {alarm ? 'ALARMA' : fmtNum(r?.co_ppm, ' ppm', 1)}
                      </p>
                    </div>
                  </div>
                  <p className="mt-2 text-[10px] font-mono text-slate-500 truncate" title="Topic MQTT previsto para el nodo de esta aula">{o.topic}</p>
                </button>
              )
            })}
          </div>
        )}
      </div>

      {/* ── Nodo seleccionado ──────────────────────────────────────────────── */}
      <div className="flex items-end justify-between gap-3 flex-wrap border-t border-slate-700/60 pt-5">
        <div>
          <p className="text-xs text-slate-500 uppercase tracking-wide">Nodo seleccionado</p>
          <h2 className="text-lg font-bold text-white flex items-center gap-2 flex-wrap">
            {selectedTitle}
            <NodeLinkBadge
              reading={latest} now={now}
              roomId={mode === 'real' ? selectedRoom : null}
              intervalS={mode === 'sim' ? SIM_PERIOD_S : intervalOf(metrics)}
            />
            <OriginBadge reading={latest} compact />
          </h2>
        </div>
        <div className="flex items-center gap-3">
          {mode === 'real' && rooms.length > 0 && (
            <div className="w-56">
              <SearchableSelect
                options={rooms.map(r => ({ value: r.id, label: r.name }))}
                value={selectedRoom}
                onChange={setSelectedRoom}
                placeholder="Selecciona un aula…"
                icon={<Building2 size={16} />}
              />
            </div>
          )}
          <span className="flex items-center gap-1 text-xs text-slate-500 tabular-nums"><Clock size={12} />{latest ? timeLabel(parseUtcMs(latest.timestamp)!) : '—'}</span>
        </div>
      </div>

      {latest && (latest.alarm_active === true || (latest.co_ppm != null && latest.co_ppm > CO_ALARM_PPM)) && (
        <div className="bg-red-900/40 border border-red-500/50 rounded-xl px-4 py-3 flex items-center gap-3">
          <AlertTriangle size={20} className="text-red-400 shrink-0" />
          <span className="text-sm text-red-200">
            {latest.alarm_active
              ? <><strong>Alarma local activa en el nodo</strong> · buzzer y LED · ventilador al 100 % (override: decisión del servidor {decisionOf(latest.cognitive_action) ?? 'sin decisión'} ignorada)</>
              : <><strong>CO sobre {CO_ALARM_PPM} ppm detectado por el servidor</strong></>}
            {' '}· CO {fmtNum(latest.co_ppm, ' ppm', 1)}
          </span>
        </div>
      )}

      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
        <MetricCard
          icon={<Thermometer size={18} />} label="Temperatura"
          value={fmtNum(latest?.temperature, '', 1)} unit={latest ? '°C' : undefined}
          status={tempLvl ? LEVEL_TO_STATUS[tempLvl] : 'normal'}
          tone={tempLvl ? levelTone(tempLvl) : undefined}
          statusText={tempLvl ? getStatusLabel(tempLvl) : undefined}
          sub={latest ? `Objetivo: ${fmtNum(tempTarget, '°C')}` : 'Sin datos'}
        />
        <MetricCard
          icon={<Droplets size={18} />} label="Humedad"
          value={fmtNum(latest?.humidity, '', 0)} unit={latest ? '%' : undefined}
          status={humLvl ? LEVEL_TO_STATUS[humLvl] : 'normal'}
          tone={humLvl ? levelTone(humLvl) : undefined}
          statusText={humLvl ? getStatusLabel(humLvl) : undefined}
          sub={latest ? 'DHT11' : 'Sin datos'}
        />
        <MetricCard
          icon={<Wind size={18} />} label="CO₂ (relativo)"
          value={fmtNum(latest?.co2_ppm, '', 0)} unit={latest?.co2_ppm != null ? 'ppm' : undefined}
          status={co2Lvl ? LEVEL_TO_STATUS[co2Lvl] : 'normal'}
          tone={co2Lvl ? levelTone(co2Lvl) : undefined}
          statusText={co2Lvl ? getStatusLabel(co2Lvl) : undefined}
          sub={latest ? (latest.co2_ppm != null ? 'MQ-135' : 'Sin dato') : 'Sin datos'}
        />
        <MetricCard
          icon={<CloudFog size={18} />} label="CO"
          value={fmtNum(latest?.co_ppm, '', 1)} unit={latest?.co_ppm != null ? 'ppm' : undefined}
          status={coLvl ? LEVEL_TO_STATUS[coLvl] : 'normal'}
          tone={coLvl ? levelTone(coLvl) : undefined}
          statusText={coLvl ? getStatusLabel(coLvl) : undefined}
          sub={latest ? (latest.co_ppm != null ? `MQ-7 · alarma > ${CO_ALARM_PPM} ppm` : 'Sin dato') : 'Sin datos'}
        />
        <MetricCard
          icon={anomalyCount > 0 ? <AlertTriangle size={18} /> : <CheckCircle size={18} />} label="Anomalías"
          value={anomalyKnown.length === 0 ? '—' : String(anomalyCount)}
          status={anomalyCount > 0 ? 'alert' : 'normal'}
          statusIcon={null}
          sub={anomalyKnown.length === 0
            ? 'sin dato: las lecturas no registran anomaly_detected'
            : `de ${anomalyKnown.length} lecturas evaluadas${anomalyKnown.length < selectedReadings.length ? ` (${selectedReadings.length - anomalyKnown.length} sin dato)` : ''}`}
        />
      </div>

      {/* Indicadores derivados (resumen) */}
      <div className="bg-slate-800 border border-slate-700 rounded-xl p-5">
        <div className="flex items-center justify-between gap-3 mb-4 flex-wrap">
          <h2 className="flex items-center gap-2 text-slate-300 text-sm font-semibold uppercase tracking-wide">
            <Activity size={15} className="text-emerald-400" /> Indicadores de funcionamiento · 24 h
          </h2>
          {mode === 'real' && <OriginToggle value={originFilter} onChange={changeOrigin} />}
        </div>
        {mode === 'real' && <OriginFallbackNotice active={originFallback && originFilter === 'all'} />}
        {mode === 'real' && metrics && <p className="text-[11px] text-slate-500 -mt-2 mb-3">{originSummary(metrics)}</p>}
        {mode === 'real'
          ? <NodeKpiGrid metrics={metrics} compact />
          : <p className="text-xs text-slate-500">Los indicadores se calculan sobre lecturas persistidas: cambia a “Tiempo real”. Las lecturas simuladas se purgan a los 15 s.</p>}
      </div>

      <div className="bg-slate-800/40 border border-slate-700/50 rounded-xl px-4 py-3">
        <p className="text-xs text-slate-500 uppercase tracking-wide mb-2">Sistema de colores de estado</p>
        <StatusLegend />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 bg-slate-800 rounded-xl p-5">
          <h2 className="text-slate-300 text-sm font-semibold uppercase tracking-wide mb-4">
            Historial del nodo (últimas {MAX_POINTS})
            {(mode === 'sim' || seriesSimulated) && <span className="ml-2 normal-case text-[11px] font-medium text-amber-400">· serie simulada</span>}
          </h2>
          {chartData.length === 0
            ? <div className="h-64 flex items-center justify-center">
                <EmptyState
                  icon={<Inbox size={22} />}
                  title={mode === 'real' ? 'Sin lecturas para esta aula' : 'Aún no hay datos'}
                  hint={mode === 'real'
                    ? `Cuando el nodo envíe telemetría (${health?.mqtt === 'connected' ? 'MQTT ccs/<aula>/telemetry' : 'POST /api/v1/sensors/'}) verás aquí su historial.`
                    : 'Genera lecturas sintéticas para ver la decisión de la heurística y el ventilador.'}
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
                  <YAxis
                    yAxisId="left"
                    stroke="#64748b"
                    tick={{ fontSize: 11 }}
                    domain={['dataMin - 1', 'dataMax + 1']}
                    allowDecimals={false}
                    label={{ value: '°C', angle: -90, position: 'insideLeft', fill: '#64748b', fontSize: 11 }}
                  />
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
                  <Line yAxisId="left" type="monotone" dataKey="temperature" name="Temperatura (°C)" stroke="#38bdf8" strokeWidth={2} dot={false} activeDot={{ r: 4 }} isAnimationActive={false} />
                  <Line yAxisId="left" type="monotone" dataKey="target" name="Temperatura objetivo (°C)" stroke="#22c55e" strokeWidth={1.5} strokeDasharray="5 3" dot={false} isAnimationActive={false} />
                  <Line yAxisId="right" type="monotone" dataKey="humidity" name="Humedad (%)" stroke="#a855f7" strokeWidth={1.5} dot={false} isAnimationActive={false} />
                  <Line yAxisId="right" type="stepAfter" dataKey="fan" name="Ventilador PWM (%)" stroke="#f59e0b" strokeWidth={1.5} dot={false} isAnimationActive={false} />
                </LineChart>
              </ResponsiveContainer>
            )}
        </div>
        <CognitivePanel reading={latest} title={selectedTitle} />
      </div>

      {/* Recent table */}
      <div className="bg-slate-800 rounded-xl p-5 overflow-x-auto">
        <h2 className="text-slate-300 text-sm font-semibold uppercase tracking-wide mb-4">Lecturas recientes · {selectedTitle}</h2>
        {selectedReadings.length === 0
          ? <EmptyState
              icon={<Inbox size={22} />}
              title={mode === 'real' ? 'Sin lecturas registradas' : 'Sin lecturas todavía'}
              hint={mode === 'real'
                ? 'Las lecturas que publique el nodo aparecerán aquí en tiempo real.'
                : 'Envía una lectura de prueba para poblar la tabla.'}
              action={mode === 'real'
                ? { label: 'Probar en simulación', onClick: () => switchMode('sim') }
                : { label: 'Enviar lectura de prueba', onClick: handleManualSend }}
            />
          : (
            <table className="w-full min-w-[780px] text-sm">
              <thead>
                <tr className="text-slate-400 text-xs uppercase border-b border-slate-700">
                  {['Nodo', 'Temp', 'Humedad', 'CO₂', 'CO', 'Ventilador', 'Decisión', 'Anomalía', 'Hora'].map(h => (
                    <th key={h} className="text-left pb-2 pr-4 last:text-right">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {[...selectedReadings].reverse().slice(0, 15).map(r => (
                  <tr key={`${r.sensor_id}-${r.timestamp}`} className={`border-b border-slate-700/50 ${r.anomaly_detected ? 'bg-red-900/10' : ''}`}>
                    <td className="py-2 pr-4 font-mono text-slate-300 text-xs">
                      <span className="mr-1">{r.sensor_id}</span><OriginBadge reading={r} compact />
                    </td>
                    <td className={`py-2 pr-4 font-semibold ${getColorTemp(r.temperature, r.cognitive_action?.target ?? r.temperature)}`}>{fmtNum(r.temperature, '°C')}</td>
                    <td className={`py-2 pr-4 font-semibold ${getColorHumedad(r.humidity)}`}>{fmtNum(r.humidity, '%')}</td>
                    <td className={`py-2 pr-4 font-semibold ${r.co2_ppm != null ? getColorCO2(r.co2_ppm) : NEUTRAL_TEXT}`}>{fmtNum(r.co2_ppm, '', 0)}</td>
                    <td className={`py-2 pr-4 font-semibold ${r.co_ppm != null ? getColorCO(r.co_ppm) : NEUTRAL_TEXT}`}>{fmtNum(r.co_ppm, ' ppm', 1)}</td>
                    <td className="py-2 pr-4 text-slate-300 tabular-nums">{fmtNum(fanPwmOf(r, r.cognitive_action).value, ' %', 0)}</td>
                    <td className="py-2 pr-4"><DecisionBadge state={decisionOf(r.cognitive_action)} /></td>
                    <td className="py-2 pr-4 text-center">
                      {r.anomaly_detected == null
                        ? <span className="text-slate-600">—</span>
                        : r.anomaly_detected ? <AlertTriangle size={14} className="text-red-400 inline" /> : <CheckCircle size={14} className="text-emerald-400 inline" />}
                    </td>
                    <td className="py-2 text-right text-slate-400 text-xs">{timeLabel(parseUtcMs(r.timestamp)!)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
      </div>

      {/* Dev tools — synthetic data generator */}
      <div className="border-2 border-dashed border-amber-600/40 bg-amber-950/10 rounded-xl overflow-hidden">
        <div className="flex items-center gap-2 bg-amber-900/25 border-b border-amber-600/30 px-4 py-2.5">
          <FlaskConical size={15} className="text-amber-400 shrink-0" />
          <span className="text-xs font-semibold text-amber-300 uppercase tracking-wider">
            Herramientas de Desarrollador · Simulador de nodos ESP32
          </span>
        </div>

        <div className="p-5">
          <p className="text-xs text-amber-500/80 mb-5">
            Zona exclusiva para pruebas. Cada nodo simulado sigue un paseo aleatorio y aplica el último comando de
            ventilador recibido (como el topic cmd retenido). Todas las lecturas se marcan como simuladas.
          </p>

          <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
            <h2 className="text-slate-400 text-xs font-semibold uppercase tracking-wide">
              Escenario y lectura manual
            </h2>
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <span className="text-xs text-slate-400">Auto-simular ({SIM_PERIOD_S} s, todos los nodos)</span>
              <div
                onClick={toggleAuto}
                className={`w-10 h-5 rounded-full transition-colors relative ${autoMode ? 'bg-amber-600' : 'bg-slate-600'}`}
              >
                <div className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${autoMode ? 'translate-x-5' : 'translate-x-0.5'}`} />
              </div>
            </label>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-4">
            {SCENARIOS.map(s => (
              <button
                key={s.value}
                type="button"
                onClick={() => setScenario(s.value)}
                className={`text-left rounded-lg border px-3 py-2 transition-colors ${
                  scenario === s.value ? 'border-amber-500/60 bg-amber-500/10' : 'border-slate-700 bg-slate-800/50 hover:border-slate-600'
                }`}
              >
                <p className="flex items-center gap-1.5 text-xs font-semibold text-slate-200"><Clapperboard size={12} className="text-amber-400" /> {s.label}</p>
                <p className="text-[11px] text-slate-500 mt-0.5 leading-snug">{s.hint}</p>
              </button>
            ))}
          </div>

          <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-4">
            <SearchableSelect
              options={SENSOR_IDS.map(s => ({ value: s, label: s }))}
              value={form.sensor_id}
              onChange={v => setForm(f => ({ ...f, sensor_id: v }))}
              placeholder="Selecciona un nodo…"
              label="Nodo (escenario)"
              icon={<Cpu size={16} />}
              maxVisibleItems={3}
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
                  value={Number.isNaN(form[field]) ? '' : form[field]}
                  onChange={e => setForm(f => ({ ...f, [field]: e.target.value === '' ? Number.NaN : parseFloat(e.target.value) }))}
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
