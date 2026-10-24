import { useCallback, useEffect, useRef, useState } from 'react'
import axios from 'axios'
import { RefreshCw, Send, Trash2 } from 'lucide-react'
import api, { getApiErrorDetail } from '../api/client'
import { useEmergency } from '../context/EmergencyContext'
import type { ReadingInput, SensorReadingResponse } from '../types'
import { levelTemp, levelHumedad, levelCO2, levelCO } from '../utils/sensorColors'
import {
  Card, Chip, Kpi, PageHeader, AI_STATE, LEVEL_TONE, MODEL_LABEL, fmt, clockTime, toneText,
} from '../components/ui'

const SENSOR_IDS = ['SIM-sensor-001', 'SIM-sensor-002', 'SIM-sensor-003']
const AUTO_MS = 4_000
const MAX_ROWS = 15

interface Sent { input: ReadingInput; output: SensorReadingResponse; at: Date }

const INPUT_CLS = 'w-full rounded-lg border border-slate-700 bg-slate-900/60 px-3 py-1.5 text-sm text-slate-100 focus:border-blue-500 focus:outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none'

const FIELDS: { key: keyof Omit<ReadingInput, 'sensor_id' | 'is_simulated'>; label: string; step: string }[] = [
  { key: 'temperature', label: 'Temperatura (°C)', step: '0.1' },
  { key: 'humidity', label: 'Humedad (%)', step: '0.1' },
  { key: 'co2_ppm', label: 'CO₂ (ppm)', step: '1' },
  { key: 'co_ppm', label: 'CO (ppm)', step: '0.1' },
]

function randomReading(): ReadingInput {
  return {
    sensor_id: SENSOR_IDS[Math.floor(Math.random() * SENSOR_IDS.length)],
    temperature: +(15 + Math.random() * 30).toFixed(1),
    humidity: +(30 + Math.random() * 65).toFixed(1),
    co2_ppm: +(350 + Math.random() * 1500).toFixed(0),
    co_ppm: +(Math.random() < 0.1 ? 55 + Math.random() * 95 : Math.random() * 10).toFixed(1),
  }
}

export default function Simulation() {
  const [engine, setEngine] = useState<'ml' | 'heuristic' | null>(null)
  const [reloading, setReloading] = useState(false)
  const [form, setForm] = useState<ReadingInput>({ sensor_id: SENSOR_IDS[0], temperature: 24.5, humidity: 55, co2_ppm: 800, co_ppm: 0 })
  const [sent, setSent] = useState<Sent[]>([])
  const [sending, setSending] = useState(false)
  const [auto, setAuto] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { clearSimulated } = useEmergency()

  useEffect(() => {
    axios.get<{ engine?: 'ml' | 'heuristic' }>('/health')
      .then(r => setEngine(r.data?.engine ?? null))
      .catch(() => setEngine(null))
  }, [])

  const reloadModel = async () => {
    setReloading(true)
    try {
      const { data } = await api.post<{ engine?: 'ml' | 'heuristic' }>('/admin/model/reload')
      setEngine(data?.engine ?? null)
    } catch (err) {
      setError(getApiErrorDetail(err) ?? 'No se pudo recargar el modelo.')
    } finally { setReloading(false) }
  }

  const send = useCallback(async (input: ReadingInput) => {
    setSending(true); setError(null)
    try {
      const { data } = await api.post<SensorReadingResponse>('/sensors/', {
        ...input, is_simulated: true, timestamp: new Date().toISOString(),
      })
      setSent(prev => [{ input, output: data, at: new Date() }, ...prev].slice(0, MAX_ROWS))
    } catch (err) {
      setError(getApiErrorDetail(err) ?? 'No se pudo enviar la lectura.')
    } finally { setSending(false) }
  }, [])

  useEffect(() => {
    if (!auto) return
    const t = setInterval(() => send(randomReading()), AUTO_MS)
    return () => clearInterval(t)
  }, [auto, send])

  // Simulated readings are wiped when leaving the page, so they never linger in
  // /emergencies or get mixed with real data.
  const purge = useCallback(() => {
    api.delete('/sensors/simulated').catch(() => {})
    clearSimulated()
    setSent([])
  }, [clearSimulated])
  const sentRef = useRef(0)
  useEffect(() => { sentRef.current = sent.length }, [sent])
  useEffect(() => () => { if (sentRef.current > 0) purge() }, [purge])

  const last = sent[0]
  const action = last?.output.cognitive_action
  const ai = action ? AI_STATE[action.ac_status] : null

  return (
    <div className="space-y-4">
      <PageHeader
        title="Simulación"
        subtitle="Envía lecturas de prueba y mira cómo responde el motor cognitivo. Se marcan como simuladas y se borran al salir de esta página."
      />

      {error && <Card className="border-red-500/40 text-sm text-red-300">{error}</Card>}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {/* Motor */}
        <Card title="Motor cognitivo">
          <div className="flex items-center justify-between gap-2">
            <div>
              <p className="text-sm text-slate-100">{engine ? MODEL_LABEL[engine] : 'Desconocido'}</p>
              <p className="text-xs text-slate-400">
                {engine === 'ml' ? 'Predice la carga térmica con el modelo entrenado.' : 'Sin modelo entrenado: usa la fórmula personas × carga.'}
              </p>
            </div>
            <button
              onClick={reloadModel}
              disabled={reloading}
              title="Vuelve a leer el modelo desde disco después de reentrenarlo"
              className="flex shrink-0 items-center gap-1.5 rounded-lg border border-slate-600 px-3 py-1.5 text-xs text-slate-200 hover:bg-slate-700 disabled:opacity-50"
            >
              <RefreshCw size={12} className={reloading ? 'animate-spin' : ''} />
              {reloading ? 'Recargando…' : 'Recargar modelo'}
            </button>
          </div>
        </Card>

        {/* Form */}
        <Card
          title="Enviar lectura"
          className="lg:col-span-2"
          aside={
            <label className="flex cursor-pointer select-none items-center gap-2">
              Automático cada {AUTO_MS / 1000} s
              <button
                role="switch"
                aria-checked={auto}
                onClick={() => setAuto(a => !a)}
                className={`relative h-5 w-9 rounded-full transition-colors ${auto ? 'bg-amber-500' : 'bg-slate-600'}`}
              >
                <span className={`absolute left-0 top-0.5 h-4 w-4 rounded-full bg-white transition-transform ${auto ? 'translate-x-4' : 'translate-x-0.5'}`} />
              </button>
            </label>
          }
        >
          <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
            <label className="block">
              <span className="mb-1 block text-xs text-slate-400">Sensor</span>
              <select
                value={form.sensor_id}
                onChange={e => setForm(f => ({ ...f, sensor_id: e.target.value }))}
                className={INPUT_CLS}
              >
                {SENSOR_IDS.map(s => <option key={s} value={s}>{s.replace('SIM-sensor-00', 'Simulado ')}</option>)}
              </select>
            </label>
            {FIELDS.map(f => (
              <label key={f.key} className="block">
                <span className="mb-1 block text-xs text-slate-400">{f.label}</span>
                <input
                  type="number"
                  step={f.step}
                  value={form[f.key]}
                  onChange={e => setForm(p => ({ ...p, [f.key]: parseFloat(e.target.value) }))}
                  className={INPUT_CLS}
                />
              </label>
            ))}
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              onClick={() => send(form)}
              disabled={sending || auto}
              className="flex items-center gap-1.5 rounded-lg bg-amber-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-amber-500 disabled:opacity-50"
            >
              {sending ? <RefreshCw size={14} className="animate-spin" /> : <Send size={14} />} Enviar
            </button>
            <button
              onClick={() => { setAuto(false); purge() }}
              disabled={sent.length === 0}
              className="flex items-center gap-1.5 rounded-lg border border-slate-600 px-3 py-1.5 text-sm text-slate-300 hover:bg-slate-700 disabled:opacity-40"
            >
              <Trash2 size={14} /> Borrar simuladas
            </button>
          </div>
        </Card>
      </div>

      {/* Response */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Kpi label="Decisión de la IA" value={ai?.label ?? '—'} />
        <Kpi label="Setpoint ajustado" value={fmt(action?.target)} unit="°C" />
        <Kpi label="Ocupación estimada" value={fmt(action?.effective_occupancy, 0)} unit="personas" />
        <Kpi label="Modo de enfriamiento" value={action?.cooling_mode ?? '—'} />
      </div>

      <Card title="Lecturas enviadas" aside={<span>{sent.length} de las últimas {MAX_ROWS}</span>}>
        {sent.length === 0 ? (
          <p className="py-6 text-center text-sm text-slate-400">Todavía no enviaste lecturas.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="border-b border-slate-700 text-left text-xs text-slate-400">
                  {['Hora', 'Sensor', 'Temp.', 'Humedad', 'CO₂', 'CO', 'Decisión IA', 'Anomalía'].map(h => <th key={h} className="pb-2 pr-4 font-normal">{h}</th>)}
                </tr>
              </thead>
              <tbody>
                {sent.map(s => {
                  const t = s.output.cognitive_action?.target ?? s.input.temperature
                  const a = AI_STATE[s.output.cognitive_action?.ac_status ?? '']
                  return (
                    <tr key={s.output.inserted_id || s.at.getTime()} className="border-b border-slate-700/40">
                      <td className="py-1.5 pr-4 text-xs text-slate-400 tabular-nums">{clockTime(s.at)}</td>
                      <td className="py-1.5 pr-4 font-mono text-xs text-slate-300">{s.input.sensor_id}</td>
                      <td className={`py-1.5 pr-4 tabular-nums ${toneText(LEVEL_TONE[levelTemp(s.input.temperature, t)])}`}>{fmt(s.input.temperature)} °C</td>
                      <td className={`py-1.5 pr-4 tabular-nums ${toneText(LEVEL_TONE[levelHumedad(s.input.humidity)])}`}>{fmt(s.input.humidity, 0)} %</td>
                      <td className={`py-1.5 pr-4 tabular-nums ${toneText(LEVEL_TONE[levelCO2(s.input.co2_ppm)])}`}>{fmt(s.input.co2_ppm, 0)}</td>
                      <td className={`py-1.5 pr-4 tabular-nums ${toneText(LEVEL_TONE[levelCO(s.input.co_ppm)])}`}>{fmt(s.input.co_ppm)}</td>
                      <td className="py-1.5 pr-4">{a ? <Chip tone={a.tone}>{a.label}</Chip> : '—'}</td>
                      <td className="py-1.5">{s.output.anomaly_detected ? <Chip tone="alert">Sí</Chip> : <span className="text-xs text-slate-500">No</span>}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  )
}
