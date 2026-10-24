import { useEffect, useState } from 'react'
import { Download, RefreshCw } from 'lucide-react'
import api, { getApiErrorDetail } from '../api/client'
import { AI_STATE, Chip, NODE_STATE, fmt, parseUtc } from './ui'

// RF-30 (coincidence recorded by the backend + divergences in context) and
// RF-31 (estimated energy of each strategy over the same window).

interface Divergence {
  timestamp: string
  temperature: number | null
  co2_ppm: number | null
  node_action: string | null
  node_reason: string | null
  ai_status: string | null
  ai_mode: string | null
  ai_target: number | null
  expected_occupancy: number | null
  actual_occupancy: number | null
}

interface Report {
  readings: number
  simulated_readings: number
  compared: number
  matches: number
  coincidence_pct: number | null
  excluded_co_alarm: number
  divergence_pairs: { node_action: string; ai_status: string; count: number }[]
  divergences: Divergence[]
  energy: { hours: number; node_fan_wh: number; ai_fan_wh: number; node_heater_wh: number; fan_power_w: number; heater_power_w: number }
}

const WINDOWS: { hours: number; label: string }[] = [
  { hours: 1, label: '1 h' },
  { hours: 24, label: '24 h' },
  { hours: 168, label: '7 días' },
]
const POLL_MS = 15_000

const nodeLabel = (a?: string | null) => (a ? NODE_STATE[a]?.label ?? a : '—')
const aiLabel = (s?: string | null) => (s ? AI_STATE[s]?.label ?? s : '—')

function Tile({ label, value, unit, hint }: { label: string; value: string; unit?: string; hint?: string }) {
  return (
    <div className="surface-inset flex h-[72px] flex-col justify-between px-3 py-2">
      <span className="text-xs text-slate-400">{label}</span>
      <p className="text-xl font-semibold leading-none text-white tabular-nums">
        {value}{unit && value !== '—' && <span className="ml-1 text-sm font-normal text-slate-400">{unit}</span>}
      </p>
      {hint && <span className="sr-only">{hint}</span>}
    </div>
  )
}

export default function StrategyComparison({ roomId }: { roomId: string }) {
  const [hours, setHours] = useState(24)
  const [report, setReport] = useState<Report | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [exporting, setExporting] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    const load = () => api.get<Report>(`/sensors/comparison?room_id=${encodeURIComponent(roomId)}&hours=${hours}`)
      .then(r => { if (!cancelled) { setReport(r.data); setError(null) } })
      .catch(err => { if (!cancelled) setError(getApiErrorDetail(err) ?? 'No se pudo cargar la comparación.') })
      .finally(() => { if (!cancelled) setLoading(false) })
    load()
    const t = setInterval(load, POLL_MS)
    return () => { cancelled = true; clearInterval(t) }
  }, [roomId, hours])

  async function exportCsv() {
    setExporting(true)
    try {
      const { data } = await api.get(`/sensors/comparison?room_id=${encodeURIComponent(roomId)}&hours=${hours}&format=csv`, { responseType: 'blob' })
      const url = URL.createObjectURL(data as Blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `comparacion_${roomId}_${hours}h.csv`
      a.click()
      URL.revokeObjectURL(url)
    } finally { setExporting(false) }
  }

  const e = report?.energy
  const diff = e && e.node_fan_wh > 0 ? ((e.ai_fan_wh - e.node_fan_wh) / e.node_fan_wh) * 100 : null

  return (
    <div className="mt-4 border-t border-slate-800 pt-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <p className="section-title">Comparación registrada</p>
        <div className="flex items-center gap-2">
          <div className="segmented p-0.5">
            {WINDOWS.map(w => (
              <button key={w.hours} className={`segmented-item text-xs ${hours === w.hours ? 'segmented-item-active' : ''}`} onClick={() => setHours(w.hours)}>
                {w.label}
              </button>
            ))}
          </div>
          <button className="btn btn-secondary py-1.5 text-xs" onClick={exportCsv} disabled={exporting || !report?.readings}>
            {exporting ? <RefreshCw size={13} className="animate-spin" /> : <Download size={13} />} CSV
          </button>
        </div>
      </div>

      {error ? <p className="text-sm text-red-300">{error}</p>
        : loading && !report ? <p className="flex items-center gap-2 text-sm text-slate-400"><RefreshCw size={14} className="animate-spin" /> Calculando…</p>
        : !report || report.readings === 0 ? (
          <p className="text-sm text-slate-400">No hay lecturas del nodo en esta ventana.</p>
        ) : <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Tile label="Coincidencia" value={report.coincidence_pct != null ? fmt(report.coincidence_pct, 1) : '—'} unit="%" />
            <Tile label="Lecturas comparadas" value={String(report.compared)} unit={`de ${report.readings}`} />
            <Tile label="Ventilador · nodo" value={fmt(e!.node_fan_wh, 2)} unit="Wh" />
            <Tile label="Ventilador · IA" value={fmt(e!.ai_fan_wh, 2)} unit="Wh" />
          </div>
          <p className="mt-2 text-xs text-slate-400">
            En {fmt(e!.hours * 60, 0)} min de funcionamiento,{' '}
            {diff == null
              ? `el nodo no encendió el ventilador${e!.ai_fan_wh > 0 ? ' y la IA lo habría encendido' : ''}.`
              : Math.abs(diff) < 1
                ? 'ambas estrategias habrían gastado lo mismo en el ventilador.'
                : <>la IA habría gastado <b className="text-slate-200">{fmt(Math.abs(diff), 0)} % {diff < 0 ? 'menos' : 'más'}</b> que el nodo en el ventilador.</>}
            {e!.node_heater_wh > 0 && <> El nodo además usó {fmt(e!.node_heater_wh, 2)} Wh de calefactor, que la IA no controla.</>}
            {' '}Estimado con ventilador de {e!.fan_power_w} W × nivel de cada decisión × tiempo.
            {report.excluded_co_alarm > 0 && <> Se excluyen {report.excluded_co_alarm} lecturas con alarma de CO.</>}
            {report.simulated_readings > 0 && <> {report.simulated_readings === report.readings ? 'Todas las lecturas' : `${report.simulated_readings} lecturas`} vienen del nodo simulado en Wokwi.</>}
          </p>

          {report.divergence_pairs.length > 0 && (
            <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
              <div>
                <p className="mb-1 text-xs text-slate-400">En qué difieren</p>
                <ul className="divide-y divide-slate-800 rounded-lg border border-slate-800 text-sm">
                  {report.divergence_pairs.slice(0, 5).map(p => (
                    <li key={`${p.node_action}-${p.ai_status}`} className="flex items-center justify-between gap-2 px-3 py-1.5">
                      <span className="text-slate-300">Nodo {nodeLabel(p.node_action).toLowerCase()} · IA {aiLabel(p.ai_status).toLowerCase()}</span>
                      <span className="text-xs tabular-nums text-slate-400">{p.count}</span>
                    </li>
                  ))}
                </ul>
              </div>
              <div className="lg:col-span-2">
                <p className="mb-1 text-xs text-slate-400">Últimas divergencias, con su contexto</p>
                <div className="overflow-x-auto rounded-lg border border-slate-800">
                  <table className="w-full min-w-[560px] text-sm">
                    <thead>
                      <tr className="table-head">
                        {['Hora', 'Temp.', 'CO₂', 'Personas esp./medidas', 'Nodo', 'IA'].map(h => <th key={h} className="px-3 py-1.5 font-normal">{h}</th>)}
                      </tr>
                    </thead>
                    <tbody>
                      {report.divergences.slice(0, 6).map(d => (
                        <tr key={d.timestamp} className="table-row" title={d.node_reason ?? undefined}>
                          <td className="px-3 py-1.5 text-xs tabular-nums text-slate-400">{parseUtc(d.timestamp).toLocaleTimeString('es')}</td>
                          <td className="px-3 py-1.5 tabular-nums text-slate-200">{fmt(d.temperature)} °C</td>
                          <td className="px-3 py-1.5 tabular-nums text-slate-200">{fmt(d.co2_ppm, 0)}</td>
                          <td className="px-3 py-1.5 tabular-nums text-slate-300">{d.expected_occupancy ?? '—'} / {d.actual_occupancy ?? '—'}</td>
                          <td className="px-3 py-1.5"><Chip tone={NODE_STATE[d.node_action ?? '']?.tone ?? 'muted'}>{nodeLabel(d.node_action)}</Chip></td>
                          <td className="px-3 py-1.5"><Chip tone={AI_STATE[d.ai_status ?? '']?.tone ?? 'muted'}>{aiLabel(d.ai_status)}</Chip>{d.ai_target != null && <span className="ml-1 text-xs text-slate-500">→ {fmt(d.ai_target)} °C</span>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}
        </>}
    </div>
  )
}
