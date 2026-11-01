import { useEffect, useState, type ReactNode } from 'react'
import { ComposedChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine, ReferenceArea } from 'recharts'
import { Download, RefreshCw } from 'lucide-react'
import api, { getApiErrorDetail } from '../api/client'
import { fmt, parseUtc } from './ui'
import { AXIS } from './NodeLive'
import DayNav from './DayNav'

// "Historial" tab: what the room's node measured and did on one local day
// (GET /sensors/rooms/{id}/history): the day's numbers, temperature with the classes,
// the fan's power and the periods with the heater on.

interface Point { t: string; temp: number; hum: number; co2: number | null; co: number; fan: number; heat: number }
interface Interval { start: string; end: string | null; people?: number | null }
interface Summary {
  class_hours: number; pct_out_of_band: number | null; out_of_band_hours: number
  fan_hours: number; heater_hours: number; fan_kwh: number; heater_kwh: number
  manual_orders: number; co_alarms: number; readings: number
}
interface History {
  date: string | null; start?: string; end?: string; data_start?: string; data_end?: string
  equipment?: { label: string }
  series?: Point[]; classes?: Interval[]; heater?: Interval[]; fan?: (Interval & { level: number })[]; summary?: Summary
}

const BAND_LO = 23.5, SETPOINT = 24, BAND_HI = 24.5
const HOUR = 3_600_000
const TEMP_COLOR = '#38bdf8'
const FAN_COLOR = '#38bdf8'
const HEAT_COLOR = '#fb923c'
const CLASS_FILL = '#94a3b8'
const POLL_MS = 30_000


function duration(hours: number): string {
  const total = Math.round(hours * 60)
  const h = Math.floor(total / 60), m = total % 60
  return h && m ? `${h} h ${m} min` : h ? `${h} h` : `${m} min`
}

function Stat({ label, value, detail }: { label: string; value: ReactNode; detail: ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="text-xs text-slate-400">{label}</p>
      <p className="mt-0.5 text-xl font-semibold leading-7 tabular-nums text-white">{value}</p>
      <p className="truncate text-xs tabular-nums text-slate-400">{detail}</p>
    </div>
  )
}

function ChartTooltip({ active, payload, heaterOn, fanAt }: {
  active?: boolean; payload?: Array<{ payload: { t: number; temp?: number } }>
  heaterOn: (t: number) => boolean; fanAt: (t: number) => number
}) {
  if (!active || !payload?.length) return null
  const r = payload[0].payload
  return (
    <div className="rounded-lg border border-slate-700 bg-slate-900 px-2.5 py-1.5 text-xs shadow-lg">
      <p className="mb-0.5 tabular-nums text-slate-400">{new Date(r.t).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' })}</p>
      {r.temp != null && <p className="tabular-nums text-slate-100">Temperatura: {fmt(r.temp, 1)} °C</p>}
      <p className="tabular-nums text-slate-100">Ventilador: {fanAt(r.t) > 0 ? `ON · ${fanAt(r.t)} %` : 'OFF'}</p>
      <p className="tabular-nums text-slate-100">Calefactor: {heaterOn(r.t) ? 'ON' : 'OFF'}</p>
    </div>
  )
}

export default function RoomHistory({ roomId }: { roomId: string }) {
  const [day, setDay] = useState<string | null>(null)
  const [data, setData] = useState<History | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [downloading, setDownloading] = useState(false)

  useEffect(() => {
    let cancelled = false
    const q = day ? `?date=${day}` : ''
    const load = () => api.get<History>(`/sensors/rooms/${encodeURIComponent(roomId)}/history${q}`)
      .then(r => { if (!cancelled) { setData(r.data); setError(null) } })
      .catch(err => { if (!cancelled) setError(getApiErrorDetail(err) ?? 'No se pudo cargar el historial.') })
    load()
    const t = setInterval(load, POLL_MS)
    return () => { cancelled = true; clearInterval(t) }
  }, [roomId, day])

  async function downloadCsv() {
    if (!data?.date) return
    setDownloading(true)
    try {
      const { data: blob } = await api.get(`/sensors/rooms/${encodeURIComponent(roomId)}/history?date=${data.date}&format=csv`, { responseType: 'blob' })
      const url = URL.createObjectURL(blob as Blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `historial_${roomId}_${data.date}.csv`
      a.click()
      URL.revokeObjectURL(url)
    } finally { setDownloading(false) }
  }

  if (error) return <p className="text-sm text-red-300">{error}</p>
  if (!data) return null
  if (!data.date || !data.start || !data.end) return <p className="text-sm text-slate-400">Esta aula todavía no tiene lecturas del nodo.</p>

  const start = parseUtc(data.start).getTime(), end = parseUtc(data.end).getTime()
  const rows = (data.series ?? []).map(p => ({ t: parseUtc(p.t).getTime(), temp: p.temp, fan: p.fan }))
  const classes = (data.classes ?? []).map(c => ({ from: parseUtc(c.start).getTime(), to: c.end ? parseUtc(c.end).getTime() : end, people: c.people }))
  const heater = (data.heater ?? []).map(h => ({ from: parseUtc(h.start).getTime(), to: h.end ? parseUtc(h.end).getTime() : end }))
  // A 5-min point counts as "heater on" if any heater period touches it.
  const heaterOn = (t: number) => heater.some(h => h.from < t + 5 * 60_000 && h.to > t)
  // Fan periods at their real power level; a 5-min point shows the highest level it touches.
  const fanRuns = (data.fan ?? []).map(f => ({ from: parseUtc(f.start).getTime(), to: f.end ? parseUtc(f.end).getTime() : end, level: f.level }))
  const fanAt = (t: number) => Math.max(0, ...fanRuns.filter(f => f.from < t + 5 * 60_000 && f.to > t).map(f => f.level))
  const temps = rows.map(r => r.temp)
  const lo = Math.min(22, temps.length ? 2 * Math.floor(Math.min(...temps) / 2) : 22)
  const hi = Math.max(26, temps.length ? 2 * Math.ceil(Math.max(...temps) / 2) : 26)
  const tempTicks = Array.from({ length: (hi - lo) / 2 + 1 }, (_, k) => lo + 2 * k)
  const xTicks = Array.from({ length: 9 }, (_, k) => start + k * 3 * HOUR)
  const xFormat = (ms: number) => (ms >= end ? '24:00' : new Date(ms).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' }))
  const s = data.summary

  const classAreas = classes.map(c => (
    <ReferenceArea key={c.from} x1={Math.max(c.from, start)} x2={Math.min(c.to - 2 * 60_000, end)} fill={CLASS_FILL} fillOpacity={0.12} stroke="none" />
  ))

  return (
    <div className="flex flex-col gap-3 lg:min-h-0 lg:flex-1">
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-3">
        <DayNav date={data.date} start={data.start} end={data.end} dataStart={data.data_start} dataEnd={data.data_end} onChange={setDay} />
        <button className="btn btn-secondary text-xs" onClick={downloadCsv} disabled={downloading || !s?.readings}>
          {downloading ? <RefreshCw size={13} className="animate-spin" /> : <Download size={13} />} CSV del día
        </button>
      </div>

      {/* The day in three numbers */}
      <section className="surface grid shrink-0 grid-cols-1 gap-4 rounded-xl px-5 py-3 sm:grid-cols-3">
        <Stat label="Clase fuera del rango ideal"
          value={s && s.class_hours > 0 && s.pct_out_of_band != null ? `${fmt(s.pct_out_of_band, 1)} %` : '—'}
          detail={s && s.class_hours > 0 ? `${duration(s.out_of_band_hours)} de ${duration(s.class_hours)} de clase` : 'Sin clases este día'} />
        <Stat label="Ventilador encendido" value={s ? duration(s.fan_hours) : '—'} detail={s ? `${fmt(s.fan_kwh, s.fan_kwh < 1 ? 2 : 1)} kWh` : ''} />
        <Stat label="Calefactor encendido" value={s ? duration(s.heater_hours) : '—'} detail={s ? `${fmt(s.heater_kwh, s.heater_kwh < 1 ? 2 : 1)} kWh` : ''} />
      </section>

      {/* Temperature, then what the actuators did */}
      <section className="surface flex flex-col rounded-xl px-2 pb-2 pt-3 lg:min-h-[300px] lg:flex-[3]">
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-x-4 gap-y-1 px-4 pb-1 text-xs text-slate-400">
          <span className="flex items-center gap-1.5"><span className="h-0.5 w-3" style={{ background: TEMP_COLOR }} />Temperatura</span>
          <span className="flex items-center gap-1.5"><span className="w-3 border-t border-dashed border-slate-400" />Rango ideal {BAND_LO}–{BAND_HI} °C</span>
          <span className="flex items-center gap-1.5"><span className="h-2.5 w-3 rounded-sm" style={{ background: CLASS_FILL, opacity: 0.25 }} />Con estudiantes</span>
          <span className="flex items-center gap-1.5"><span className="h-2.5 w-3 rounded-sm" style={{ background: FAN_COLOR, opacity: 0.5 }} />Potencia del ventilador</span>
          <span className="flex items-center gap-1.5"><span className="h-2.5 w-3 rounded-sm" style={{ background: HEAT_COLOR, opacity: 0.75 }} />Calefactor encendido</span>
        </div>
        <div className="min-h-[150px] flex-1">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={rows} syncId="history" margin={{ top: 6, right: 22, left: 4, bottom: 10 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
              <XAxis dataKey="t" type="number" scale="time" domain={[start, end]} allowDataOverflow ticks={xTicks} interval={0} tickFormatter={xFormat} {...AXIS} hide />
              <YAxis domain={[lo, hi]} ticks={tempTicks} allowDataOverflow width={46} interval={0} {...AXIS}
                label={{ value: 'Temperatura (°C)', angle: -90, position: 'insideLeft', offset: 4, style: { textAnchor: 'middle' }, fill: '#94a3b8', fontSize: 11 }} />
              <Tooltip content={<ChartTooltip heaterOn={heaterOn} fanAt={fanAt} />} cursor={{ stroke: '#475569', strokeDasharray: '2 2' }} />
              {classAreas}
              <ReferenceLine y={BAND_HI} stroke="#94a3b8" strokeDasharray="4 4" strokeOpacity={0.5} />
              <ReferenceLine y={SETPOINT} stroke="#34d399" strokeDasharray="4 4" strokeOpacity={0.5} />
              <ReferenceLine y={BAND_LO} stroke="#94a3b8" strokeDasharray="4 4" strokeOpacity={0.5} />
              <Line type="monotone" dataKey="temp" stroke={TEMP_COLOR} strokeWidth={1.75} dot={false} isAnimationActive={false} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
        {/* Fan: the power it ran at */}
        <div className="h-16 shrink-0">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={rows} syncId="history" margin={{ top: 4, right: 22, left: 4, bottom: 0 }}>
              <XAxis dataKey="t" type="number" scale="time" domain={[start, end]} allowDataOverflow ticks={xTicks} interval={0} hide />
              <YAxis domain={[0, 100]} allowDataOverflow ticks={[0, 100]} width={46} tickFormatter={v => `${v}%`} {...AXIS}
                label={{ value: 'Ventilador', angle: -90, position: 'insideLeft', offset: 4, style: { textAnchor: 'middle' }, fill: '#94a3b8', fontSize: 10 }} />
              {/* Only the temperature chart shows the tooltip; the synced strips just mark the hour. */}
              <Tooltip content={() => null} cursor={{ stroke: '#475569', strokeDasharray: '2 2' }} />
              {classAreas}
              {fanRuns.map(f => (
                <ReferenceArea key={f.from} x1={Math.max(f.from, start)} x2={Math.min(f.to, end)} y1={0} y2={f.level} fill={FAN_COLOR} fillOpacity={0.6} stroke="none" />
              ))}
              <Line dataKey="fan" stroke="none" dot={false} activeDot={false} isAnimationActive={false} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
        {/* Heater: on or off, no power level — exact periods */}
        <div className="h-[76px] shrink-0">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={rows} syncId="history" margin={{ top: 2, right: 22, left: 4, bottom: 14 }}>
              <XAxis dataKey="t" type="number" scale="time" domain={[start, end]} allowDataOverflow ticks={xTicks} interval={0} tickFormatter={xFormat} {...AXIS}
                label={{ value: 'Hora', position: 'insideBottom', offset: -10, fill: '#94a3b8', fontSize: 11 }} />
              <YAxis domain={[0, 1]} allowDataOverflow ticks={[0.5]} width={46} tickFormatter={() => 'Calef.'} axisLine={false} tickLine={false} {...{ tick: AXIS.tick }} />
              {/* Only the temperature chart shows the tooltip; the synced strips just mark the hour. */}
              <Tooltip content={() => null} cursor={{ stroke: '#475569', strokeDasharray: '2 2' }} />
              {heater.map(h => (
                <ReferenceArea key={h.from} x1={Math.max(h.from, start)} x2={Math.min(h.to, end)} y1={0.15} y2={0.85} fill={HEAT_COLOR} fillOpacity={0.75} stroke="none" />
              ))}
              <Line dataKey="temp" stroke="none" dot={false} activeDot={false} isAnimationActive={false} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </section>

    </div>
  )
}
