import { useState, useEffect, useCallback } from 'react'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, Legend, ResponsiveContainer,
} from 'recharts'
import {
  Zap, RefreshCw, AlertCircle, FlaskConical, Clock, Coins, Gauge,
  Sigma, BrainCircuit, Info, PlugZap, DoorOpen,
} from 'lucide-react'
import api, { getApiErrorDetail } from '../api/client'
import SearchableSelect from '../components/SearchableSelect'
import { OriginToggle, OriginFallbackNotice } from '../components/NodeWidgets'
import { originAutoSwitch } from '../utils/node'
import type { OriginCounts, OriginFilter } from '../types'

// Vista "Consumo del nodo" (ruta /roi conservada). Muestra SOLO lo que gasta el
// propio nodo ESP32 + sensores + ventilador. Regla dura del proyecto: sin
// comparación contra aire acondicionado.
// Potencia = rama del actuador (INA219, medida) + electrónica (nominal / η buck,
// estimada). Sin INA219 todo es estimado. Con varias aulas: promedio por nodo.

type PowerSource = 'medido' | 'medido + estimado' | 'mixto' | 'estimado' | 'sin dato'

interface CostBlock {
  avg_power_w: number
  kwh_day: number
  kwh_month: number
  kwh_year: number
  cost_day: number
  cost_month: number
  cost_year: number
}

interface TrendDay {
  date: string
  node_kwh: number | null
  measured_pct: number
  readings: number
  heuristic_kwh: number | null
  ml_shadow_kwh: number | null
}

interface NodeConsumption {
  window_days: number
  room_id: string | null
  total_readings: number
  measured_readings: number
  simulated_readings: number
  total_hours_analyzed?: number
  power_source: PowerSource
  node: CostBlock | null
  breakdown?: {
    actuator_avg_w: number | null
    actuator_source: string
    logic_avg_w: number | null
    logic_source: string
  } | null
  nodes?: number
  simulated_nodes?: number
  per_node?: { sensor_id: string; readings: number; avg_power_w: number | null; origin: string; power_source: string }[]
  origin_counts?: OriginCounts
  origin_counts_all?: OriginCounts
  origin_filter?: OriginFilter
  upper_bound: (CostBlock & { label: string }) | null
  heuristic_vs_ml: {
    samples: number
    heuristic_kwh_day: number
    ml_shadow_kwh_day: number
    source: string
  } | null
  trend_data: TrendDay[]
  assumptions: {
    node_idle_power_w: number
    buck_efficiency?: number
    logic_power_w?: number
    ina219_scope?: 'actuator' | 'node'
    fan_max_power_w: number
    heater_power_w: number
    cost_per_kwh: number
    currency: string
    tariff_confirmed: boolean
    tariff_label?: string
    method: string
  }
  simulated: boolean
}

interface RoomOpt { id: string; name: string }

function fmt(n: number | null | undefined, dec = 2) {
  return n == null || Number.isNaN(n) ? '—' : n.toFixed(dec)
}

function money(n: number | null | undefined, currency: string, dec = 2) {
  if (n == null || Number.isNaN(n)) return '—'
  const symbol = currency === 'PEN' ? 'S/ ' : currency === 'USD' ? '$' : `${currency} `
  return `${symbol}${n.toFixed(dec)}`
}

function shortDate(iso: string) {
  const [, month, day] = iso.split('-')
  return `${day}/${month}`
}

const SOURCE_LABEL: Record<PowerSource, { text: string; cls: string }> = {
  medido:              { text: 'Medido (INA219 en la entrada de 12 V)', cls: 'text-emerald-300 bg-emerald-500/10 border-emerald-500/30' },
  'medido + estimado': { text: 'Medido + estimado: rama actuador (INA219) + electrónica nominal', cls: 'text-sky-300 bg-sky-500/10 border-sky-500/30' },
  mixto:               { text: 'Mixto: parte de las lecturas sin INA219', cls: 'text-amber-300 bg-amber-500/10 border-amber-500/30' },
  estimado:            { text: 'Estimado (potencias nominales)', cls: 'text-amber-300 bg-amber-500/10 border-amber-500/30' },
  'sin dato':          { text: 'Sin lecturas', cls: 'text-slate-400 bg-slate-700/50 border-slate-600' },
}

function PeriodCard({ label, kwh, cost, currency, accent }: {
  label: string; kwh: number | null | undefined; cost: number | null | undefined; currency: string; accent: string
}) {
  return (
    <div className={`bg-slate-800/60 border border-slate-700/60 border-l-4 ${accent} rounded-xl p-4`}>
      <p className="text-xs text-slate-400 uppercase tracking-wide mb-1">{label}</p>
      <p className="text-2xl font-bold text-white tabular-nums leading-tight">{money(cost, currency, cost != null && cost < 1 ? 3 : 2)}</p>
      <p className="text-xs text-slate-500 mt-1 tabular-nums">{fmt(kwh, kwh != null && kwh < 1 ? 3 : 2)} kWh</p>
    </div>
  )
}

const TOOLTIP_STYLE = {
  backgroundColor: '#0f172a',
  border: '1px solid #334155',
  borderRadius: '10px',
  color: '#e2e8f0',
  fontSize: 12,
  boxShadow: '0 4px 24px rgba(0,0,0,0.6)',
}

export default function ROIReport() {
  const [data, setData]       = useState<NodeConsumption | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState<string | null>(null)
  const [rooms, setRooms]     = useState<RoomOpt[]>([])
  const [roomId, setRoomId]   = useState<string>('')
  const [origin, setOrigin]   = useState<OriginFilter>('all')
  const [originTouched, setOriginTouched] = useState(false)
  const [originFallback, setOriginFallback] = useState(false)
  const changeOrigin = useCallback((v: OriginFilter) => {
    setOriginTouched(true); setOriginFallback(false); setOrigin(v)
  }, [])
  const changeRoom = useCallback((v: string) => {
    setRoomId(v); setOriginTouched(false); setOriginFallback(false)
  }, [])

  useEffect(() => {
    api.get<RoomOpt[]>('/admin/rooms')
      .then(res => {
        const list = res.data ?? []
        setRooms(list)
        // Aula piloto con el nodo físico por defecto (solo lecturas marcadas como nodo).
        if (list.some(r => r.id === 'A403')) { setRoomId('A403'); setOrigin('node') }
      })
      .catch(() => setRooms([]))
  }, [])

  const fetchConsumption = useCallback(() => {
    setLoading(true)
    setError(null)
    api.get<NodeConsumption>('/reports/roi', { params: { ...(roomId ? { room_id: roomId } : {}), origin } })
      .then(res => {
        const d = res.data
        // Sin lecturas del nodo físico → "Todas" con aviso; nunca la cota en silencio (FE-3-03).
        const sw = d ? originAutoSwitch({ filter: origin, touched: originTouched, fallback: originFallback, samples: d.total_readings, countsAll: d.origin_counts_all }) : null
        if (sw) { setOriginFallback(sw === 'all'); setOrigin(sw); return }
        setData(d)
      })
      .catch(err => setError(getApiErrorDetail(err) ?? 'Error calculando el consumo del nodo.'))
      .finally(() => setLoading(false))
  }, [roomId, origin, originTouched, originFallback])

  useEffect(() => { fetchConsumption() }, [fetchConsumption])

  const currency = data?.assumptions.currency ?? 'PEN'
  const block = data?.node ?? null
  const shown = block ?? data?.upper_bound ?? null
  const usingUpperBound = !block && !!data?.upper_bound
  const nodes = data?.nodes ?? (block ? 1 : 0)
  const multiNode = nodes > 1
  const bd = data?.breakdown ?? null

  const chartData = data?.trend_data.map(d => ({
    date: shortDate(d.date),
    'Nodo (kWh/día)': d.node_kwh,
    'Heurística': d.heuristic_kwh,
    'ML en sombra': d.ml_shadow_kwh,
  })) ?? []
  const hasShadowSeries = data?.trend_data.some(d => d.ml_shadow_kwh != null) ?? false

  const roomOptions = [{ value: '', label: 'Todas las aulas' }, ...rooms.map(r => ({ value: r.id, label: r.name }))]

  return (
    <div className="space-y-6">

      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <PlugZap size={22} className="text-emerald-400" />
          <div>
            <h1 className="text-xl font-bold text-white">Consumo del nodo</h1>
            <p className="text-sm text-slate-400">Energía y costo del propio nodo ESP32 (sensores + ventilador)</p>
          </div>
        </div>
        <div className="flex items-end gap-3 flex-wrap">
          <OriginToggle value={origin} onChange={changeOrigin} />
          <div className="w-60">
            <SearchableSelect
              options={roomOptions}
              value={roomId}
              onChange={changeRoom}
              placeholder="Selecciona un aula…"
              label="Aula / nodo"
              icon={<DoorOpen size={16} />}
            />
          </div>
          <button
            onClick={fetchConsumption}
            disabled={loading}
            className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-slate-100 bg-slate-700 hover:bg-slate-600 px-3 py-2 rounded-lg transition-colors"
          >
            <RefreshCw size={13} className={loading ? 'animate-spin' : ''} /> Recalcular
          </button>
        </div>
      </div>

      <OriginFallbackNotice active={originFallback && origin === 'all'} />

      {/* Sin lecturas → cota máxima nominal */}
      {data && usingUpperBound && (
        <div className="flex items-start gap-2 bg-amber-900/30 border border-amber-500/40 rounded-xl px-4 py-3 text-sm text-amber-300">
          <FlaskConical size={15} className="shrink-0 mt-0.5" />
          <span>
            <strong>Sin lecturas{origin === 'node' ? ' marcadas como nodo físico' : ''} en los últimos {data.window_days} días.</strong> Se muestra la{' '}
            <strong>cota máxima estimada</strong> ({data.upper_bound?.label}) con las potencias nominales del nodo.
            No es una medición.
          </span>
        </div>
      )}
      {data && !usingUpperBound && data.simulated_readings > 0 && (
        <div className="flex items-center gap-2 bg-amber-900/20 border border-amber-500/30 rounded-xl px-4 py-2.5 text-xs text-amber-300">
          <FlaskConical size={13} className="shrink-0" />
          {data.simulated_readings} de {data.total_readings} lecturas de la ventana son simuladas (no provienen del nodo físico).
        </div>
      )}
      {data && origin === 'node' && data.origin_counts_all && (data.origin_counts_all.simulado + data.origin_counts_all.desconocido) > 0 && (
        <div className="flex items-center gap-2 bg-slate-800 border border-slate-600 rounded-xl px-4 py-2.5 text-xs text-slate-400">
          <Info size={13} className="shrink-0" />
          Filtro “Solo nodo físico”: se excluyen {data.origin_counts_all.simulado} lecturas simuladas y {data.origin_counts_all.desconocido} sin origen declarado.
        </div>
      )}

      {error && (
        <div className="flex items-center gap-2 bg-red-900/30 border border-red-500/40 rounded-xl px-4 py-3 text-sm text-red-300">
          <AlertCircle size={16} className="shrink-0" /> {error}
        </div>
      )}

      {loading && (
        <div className="flex items-center justify-center gap-2 text-slate-400 text-sm py-20">
          <RefreshCw size={16} className="animate-spin" />
          Calculando consumo…
        </div>
      )}

      {!loading && data && shown && (
        <>
          {/* ── Mensaje principal ─────────────────────────────────────────── */}
          <div className="bg-gradient-to-r from-emerald-900/30 to-slate-800 border border-emerald-500/30 rounded-xl p-5 flex flex-wrap items-center gap-5">
            <div className="w-12 h-12 rounded-xl bg-emerald-600/20 border border-emerald-500/30 flex items-center justify-center shrink-0">
              <Coins size={22} className="text-emerald-300" />
            </div>
            <div className="flex-1 min-w-[220px]">
              <p className="text-emerald-200 text-lg font-semibold leading-snug">
                El gasto es tan poco que ni se siente.
              </p>
              <p className="text-sm text-slate-300 mt-1">
                {multiNode
                  ? <>Promedio por nodo ({nodes} nodos{data.simulated_nodes ? `, ${data.simulated_nodes} simulados` : ''}): mantener <em>un</em> nodo encendido todo el año cuesta{' '}</>
                  : <>Mantener el nodo encendido todo el año cuesta{' '}</>}
                <strong className="text-white">{money(shown.cost_year, currency)}</strong>
                {' '}({fmt(shown.kwh_year, 2)} kWh/año), con una potencia media de{' '}
                <strong className="text-white">{fmt(shown.avg_power_w, 2)} W</strong>.
              </p>
            </div>
            <span className={`text-xs font-medium border rounded-full px-3 py-1 ${SOURCE_LABEL[usingUpperBound ? 'estimado' : data.power_source].cls}`}>
              {usingUpperBound ? 'Cota máxima estimada' : SOURCE_LABEL[data.power_source].text}
            </span>
          </div>

          {/* ── Día / mes / año ───────────────────────────────────────────── */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="bg-slate-800/60 border border-slate-700/60 border-l-4 border-l-yellow-500 rounded-xl p-4">
              <p className="flex items-center gap-1.5 text-xs text-slate-400 uppercase tracking-wide mb-1"><Gauge size={13} /> Potencia media{multiNode ? ' por nodo' : ''}</p>
              <p className="text-2xl font-bold text-white tabular-nums leading-tight">{fmt(shown.avg_power_w, 2)} W</p>
              <p className="text-xs text-slate-500 mt-1">
                {usingUpperBound
                  ? 'nominal, ventilador al 100 %'
                  : `${data.measured_readings}/${data.total_readings} lecturas con INA219 · ponderada por tiempo`}
              </p>
              {!usingUpperBound && bd && (
                <p className="text-[11px] text-slate-400 mt-1 tabular-nums leading-snug">
                  Rama actuador {fmt(bd.actuator_avg_w, 2)} W <span className="text-slate-500">({bd.actuator_source})</span>
                  {' '}+ electrónica {fmt(bd.logic_avg_w, 2)} W <span className="text-amber-400/80">({bd.logic_source})</span>
                </p>
              )}
            </div>
            <PeriodCard label="Por día"  kwh={shown.kwh_day}   cost={shown.cost_day}   currency={currency} accent="border-l-emerald-500" />
            <PeriodCard label="Por mes"  kwh={shown.kwh_month} cost={shown.cost_month} currency={currency} accent="border-l-teal-500" />
            <PeriodCard label="Por año"  kwh={shown.kwh_year}  cost={shown.cost_year}  currency={currency} accent="border-l-cyan-500" />
          </div>

          {/* ── Tendencia diaria ──────────────────────────────────────────── */}
          <div className="bg-slate-800 border border-slate-700 rounded-xl p-5">
            <h2 className="text-slate-300 text-sm font-semibold uppercase tracking-wide mb-1">
              Consumo diario del nodo — últimos {data.window_days} días (kWh/día)
            </h2>
            <p className="text-xs text-slate-500 mb-5">
              Potencia media de cada día × 24 h. {hasShadowSeries
                ? 'Se compara la energía si actuara la heurística (activa) frente al ML en sombra, en la misma ventana.'
                : 'El ML en sombra aún no tiene predicciones en esta ventana.'}
            </p>
            {chartData.length === 0 ? (
              <div className="h-64 flex items-center justify-center text-slate-500 text-sm">
                Sin lecturas para graficar
              </div>
            ) : (
              <ResponsiveContainer width="100%" height={280}>
                <BarChart data={chartData} margin={{ top: 5, right: 10, left: 0, bottom: 5 }} barCategoryGap="25%">
                  <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                  <XAxis dataKey="date" stroke="#64748b" tick={{ fontSize: 11 }} />
                  <YAxis stroke="#64748b" tick={{ fontSize: 11 }} unit=" kWh" width={72} />
                  <Tooltip contentStyle={TOOLTIP_STYLE} cursor={{ fill: 'transparent' }} />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Bar dataKey="Nodo (kWh/día)" fill="#34d399" radius={[4, 4, 0, 0]} />
                  {hasShadowSeries && <Bar dataKey="Heurística" fill="#60a5fa" radius={[4, 4, 0, 0]} />}
                  {hasShadowSeries && <Bar dataKey="ML en sombra" fill="#a78bfa" radius={[4, 4, 0, 0]} />}
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>

          {/* ── Heurística vs ML en sombra ────────────────────────────────── */}
          <div className="bg-slate-800 border border-slate-700 rounded-xl p-5">
            <h2 className="flex items-center gap-2 text-slate-300 text-sm font-semibold uppercase tracking-wide mb-4">
              <Zap size={15} className="text-yellow-400" /> Energía: heurística vs ML en sombra
            </h2>
            {data.heuristic_vs_ml ? (
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="bg-slate-700/40 border border-blue-500/30 rounded-lg p-3">
                  <p className="flex items-center gap-1.5 text-xs text-slate-400 mb-1"><Sigma size={13} className="text-blue-400" /> Heurística (activa)</p>
                  <p className="text-lg font-bold text-white tabular-nums">{fmt(data.heuristic_vs_ml.heuristic_kwh_day, 4)} kWh/día</p>
                </div>
                <div className="bg-slate-700/40 border border-violet-500/30 border-dashed rounded-lg p-3">
                  <p className="flex items-center gap-1.5 text-xs text-slate-400 mb-1"><BrainCircuit size={13} className="text-violet-400" /> ML en sombra (no actúa)</p>
                  <p className="text-lg font-bold text-white tabular-nums">{fmt(data.heuristic_vs_ml.ml_shadow_kwh_day, 4)} kWh/día</p>
                </div>
                <div className="bg-slate-700/40 border border-slate-700 rounded-lg p-3">
                  <p className="text-xs text-slate-400 mb-1">Diferencia (ML − heurística)</p>
                  <p className="text-lg font-bold text-white tabular-nums">
                    {fmt((data.heuristic_vs_ml.ml_shadow_kwh_day - data.heuristic_vs_ml.heuristic_kwh_day) * 1000, 1)} Wh/día
                  </p>
                  <p className="text-[11px] text-slate-500 mt-0.5">n={data.heuristic_vs_ml.samples} · {data.heuristic_vs_ml.source}</p>
                </div>
              </div>
            ) : (
              <p className="text-sm text-slate-500">
                Sin decisiones del ML en sombra en la ventana: no hay base para comparar. La comparación aparece en cuanto
                el modelo esté cargado y procese lecturas del nodo.
              </p>
            )}
          </div>

          {/* ── Supuestos ─────────────────────────────────────────────────── */}
          <div className="bg-slate-800/60 border border-slate-700 rounded-xl px-5 py-4 text-xs text-slate-500 space-y-2">
            <p className="flex items-center gap-1.5 text-slate-400 font-semibold uppercase tracking-wide"><Info size={13} /> Método y supuestos</p>
            <div className="flex flex-wrap gap-x-5 gap-y-1">
              <span className="flex items-center gap-1"><Clock size={12} /> Ventana: <strong className="text-slate-400">{data.window_days} días · {data.total_readings} lecturas{data.total_hours_analyzed != null ? ` · ${fmt(data.total_hours_analyzed, 1)} h` : ''}</strong></span>
              <span>Método: <strong className="text-slate-400">{data.assumptions.method}</strong></span>
              <span>
                Electrónica nominal (ESP32 + calentadores MQ + DHT11): <strong className="text-slate-400">{data.assumptions.node_idle_power_w} W</strong>
                {data.assumptions.buck_efficiency != null && <> / η buck {data.assumptions.buck_efficiency} = <strong className="text-slate-400">{fmt(data.assumptions.logic_power_w, 2)} W</strong> desde 12 V</>}
              </span>
              <span>INA219: <strong className="text-slate-400">{data.assumptions.ina219_scope === 'node' ? 'shunt en la entrada de 12 V (total medido)' : 'shunt en la rama del actuador (ubicación provisional)'}</strong></span>
              <span>Ventilador 12 V al 100 %: <strong className="text-slate-400">{data.assumptions.fan_max_power_w} W</strong></span>
              <span>Calefactor PTC: <strong className="text-slate-400">{data.assumptions.heater_power_w ? `${data.assumptions.heater_power_w} W` : 'sin dato'}</strong></span>
              <span>
                Tarifa: <strong className="text-slate-400">{money(data.assumptions.cost_per_kwh, currency, 2)}/kWh</strong>
                {data.assumptions.tariff_label && <span className="text-slate-500"> · {data.assumptions.tariff_label}</span>}
                {!data.assumptions.tariff_confirmed && <span className="text-amber-500/80"> (referencial, a confirmar UTEC)</span>}
              </span>
            </div>
            <p>
              El INA219 mide la rama del actuador; la electrónica del nodo no pasa por el shunt y se suma con su potencia nominal,
              rotulada “estimado”. Sin INA219 en la lectura, el ventilador también se estima (potencia nominal × PWM).
              {multiNode && ' Con varias aulas se informa el promedio por nodo, no la suma.'}
            </p>
          </div>
        </>
      )}
    </div>
  )
}
