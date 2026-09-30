import { useState, useEffect } from 'react'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, Legend, ResponsiveContainer,
} from 'recharts'
import {
  TrendingUp, Zap, Leaf, RefreshCw, AlertCircle,
  FlaskConical, Brain, Clock,
} from 'lucide-react'
import api, { getApiErrorDetail } from '../api/client'

// Average CO₂ emission factor for the electrical grid (kg CO₂ per kWh).
// Source: EPA eGrid average; Peru's grid factor is ~0.224 — 0.233 is a conservative estimate.
const CO2_KG_PER_KWH = 0.233

interface Assumptions {
  ac_power_kw: number
  cost_per_kwh: number
  estimated_interval_minutes: number
}

interface TrendDay {
  date: string
  traditional_kwh: number
  cognitive_kwh: number
  savings_kwh: number
}

interface ROIData {
  total_hours_analyzed: number
  total_readings: number
  traditional_kwh: number
  cognitive_kwh: number
  energy_saved_kwh: number
  standby_hours: number
  total_savings_currency: number
  currency: string
  assumptions: Assumptions
  trend_data: TrendDay[]
  simulated: boolean
}

function fmt(n: number, dec = 2) {
  return n.toFixed(dec)
}

function shortDate(iso: string) {
  const [, month, day] = iso.split('-')
  return `${day}/${month}`
}

interface KpiCardProps {
  icon: React.ReactNode
  label: string
  value: string
  sublabel: string
  color: 'emerald' | 'blue' | 'teal'
}

function KpiCard({ icon, label, value, sublabel, color }: KpiCardProps) {
  const palette = {
    emerald: 'bg-emerald-900/30 border-emerald-500/30 text-emerald-300',
    blue:    'bg-blue-900/30    border-blue-500/30    text-blue-300',
    teal:    'bg-teal-900/30    border-teal-500/30    text-teal-300',
  }
  const iconBg = {
    emerald: 'bg-emerald-600/20 border-emerald-500/30',
    blue:    'bg-blue-600/20    border-blue-500/30',
    teal:    'bg-teal-600/20    border-teal-500/30',
  }
  return (
    <div className={`rounded-xl border p-5 flex items-start gap-4 ${palette[color]}`}>
      <div className={`w-11 h-11 rounded-lg border flex items-center justify-center shrink-0 ${iconBg[color]}`}>
        {icon}
      </div>
      <div className="min-w-0">
        <p className="text-xs uppercase tracking-wide opacity-70 mb-1">{label}</p>
        <p className="text-2xl font-bold text-white leading-tight truncate">{value}</p>
        <p className="text-xs opacity-60 mt-1">{sublabel}</p>
      </div>
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
  const [data, setData]       = useState<ROIData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState<string | null>(null)

  function fetchROI() {
    setLoading(true)
    setError(null)
    api.get<ROIData>('/reports/roi')
      .then(res => setData(res.data))
      .catch(err => setError(getApiErrorDetail(err) ?? 'Error calculando ROI.'))
      .finally(() => setLoading(false))
  }

  useEffect(() => { fetchROI() }, [])

  const chartData = data?.trend_data.map(d => ({
    date:        shortDate(d.date),
    'Tradicional': d.traditional_kwh,
    'Cognitivo':   d.cognitive_kwh,
  })) ?? []

  const co2Saved = data ? data.energy_saved_kwh * CO2_KG_PER_KWH : 0
  // standbyPct = fraction of traditional consumption avoided by the cognitive system
  const standbyPct = data && data.traditional_kwh > 0
    ? (data.energy_saved_kwh / data.traditional_kwh * 100)
    : 0

  return (
    <div className="space-y-6">

      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <TrendingUp size={22} className="text-emerald-400" />
          <div>
            <h1 className="text-xl font-bold text-white">Dashboard de Rentabilidad</h1>
            <p className="text-sm text-slate-400">Retorno de inversión del sistema cognitivo</p>
          </div>
        </div>
        <button
          onClick={fetchROI}
          disabled={loading}
          className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-slate-100 bg-slate-700 hover:bg-slate-600 px-3 py-1.5 rounded-lg transition-colors"
        >
          <RefreshCw size={13} className={loading ? 'animate-spin' : ''} /> Recalcular
        </button>
      </div>

      {/* Simulated data banner */}
      {data?.simulated && (
        <div className="flex items-center gap-2 bg-amber-900/30 border border-amber-500/40 rounded-xl px-4 py-3 text-sm text-amber-300">
          <FlaskConical size={15} className="shrink-0" />
          <span>
            <strong>Datos simulados</strong> — base de datos con menos de 2 lecturas reales.
            Los valores mostrados son proyecciones basadas en parámetros estándar (8 h/día operativo, 60% STANDBY).
          </span>
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="flex items-center gap-2 bg-red-900/30 border border-red-500/40 rounded-xl px-4 py-3 text-sm text-red-300">
          <AlertCircle size={16} className="shrink-0" /> {error}
        </div>
      )}

      {/* Loading */}
      {loading && (
        <div className="flex items-center justify-center gap-2 text-slate-400 text-sm py-20">
          <RefreshCw size={16} className="animate-spin" />
          Calculando ROI…
        </div>
      )}

      {!loading && data && (
        <>
          {/* ── KPI Cards ─────────────────────────────────────────────────── */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <KpiCard
              color="emerald"
              icon={<TrendingUp size={20} className="text-emerald-400" />}
              label="Ahorro Económico Estimado"
              value={`$${fmt(data.total_savings_currency)}`}
              sublabel={`Factor: $${data.assumptions.cost_per_kwh}/kWh`}
            />
            <KpiCard
              color="blue"
              icon={<Zap size={20} className="text-blue-400" />}
              label="Energía Ahorrada"
              value={`${fmt(data.energy_saved_kwh, 1)} kWh`}
              sublabel={`${fmt(data.standby_hours, 1)} h en STANDBY`}
            />
            <KpiCard
              color="teal"
              icon={<Leaf size={20} className="text-teal-400" />}
              label="Reducción de Huella de Carbono"
              value={`${fmt(co2Saved, 2)} kg CO₂`}
              sublabel={`Factor: ${CO2_KG_PER_KWH} kg/kWh`}
            />
          </div>

          {/* ── Comparative Bar Chart ──────────────────────────────────────── */}
          <div className="bg-slate-800 border border-slate-700 rounded-xl p-5">
            <h2 className="text-slate-300 text-sm font-semibold uppercase tracking-wide mb-1">
              Consumo Comparativo — Últimos 7 días (kWh)
            </h2>
            <p className="text-xs text-slate-500 mb-5">
              Sistema tradicional (AC encendido 100% del tiempo) vs. sistema cognitivo real
            </p>

            {chartData.length === 0 ? (
              <div className="h-64 flex items-center justify-center text-slate-500 text-sm">
                Sin datos para graficar
              </div>
            ) : (
              <ResponsiveContainer width="100%" height={280}>
                <BarChart data={chartData} margin={{ top: 5, right: 10, left: 0, bottom: 5 }} barCategoryGap="30%">
                  <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                  <XAxis dataKey="date" stroke="#64748b" tick={{ fontSize: 11 }} />
                  <YAxis stroke="#64748b" tick={{ fontSize: 11 }} unit=" kWh" />
                  <Tooltip contentStyle={TOOLTIP_STYLE} cursor={{ fill: 'transparent' }} />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Bar dataKey="Tradicional" fill="#f97316" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="Cognitivo"   fill="#22d3ee" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>

          {/* ── Cognitive Summary Panel ────────────────────────────────────── */}
          <div className="bg-slate-800 border border-slate-700 rounded-xl p-5">
            <h2 className="flex items-center gap-2 text-slate-300 text-sm font-semibold uppercase tracking-wide mb-4">
              <Brain size={15} className="text-purple-400" /> Resumen Cognitivo
            </h2>

            <p className="text-slate-300 text-sm leading-relaxed mb-5">
              El sistema ha optimizado la ventilación basándose en patrones de ocupación,
              evitando{' '}
              <span className="font-bold text-blue-300">{fmt(data.energy_saved_kwh, 2)} kWh</span>
              {' '}de gasto por inercia térmica.
            </p>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {[
                {
                  icon: <Clock size={14} className="text-slate-400" />,
                  label: 'Horas analizadas',
                  value: `${fmt(data.total_hours_analyzed, 1)} h`,
                },
                {
                  icon: <Zap size={14} className="text-blue-400" />,
                  label: 'Lecturas procesadas',
                  value: data.total_readings.toLocaleString(),
                },
                {
                  icon: <TrendingUp size={14} className="text-emerald-400" />,
                  label: 'Eficiencia lograda',
                  value: `${fmt(standbyPct, 1)}%`,
                },
                {
                  icon: <Leaf size={14} className="text-teal-400" />,
                  label: 'CO₂ evitado',
                  value: `${fmt(co2Saved, 2)} kg`,
                },
              ].map(item => (
                <div key={item.label} className="bg-slate-700/50 border border-slate-700 rounded-lg px-3 py-3">
                  <div className="flex items-center gap-1.5 mb-1.5">{item.icon}
                    <span className="text-xs text-slate-500 uppercase tracking-wide">{item.label}</span>
                  </div>
                  <p className="text-base font-bold text-slate-100">{item.value}</p>
                </div>
              ))}
            </div>

            <div className="mt-4 pt-4 border-t border-slate-700/60 text-xs text-slate-500 flex flex-wrap gap-x-4 gap-y-1">
              <span>Potencia AC asumida: <strong className="text-slate-400">{data.assumptions.ac_power_kw} kW</strong></span>
              <span>Intervalo de muestreo: <strong className="text-slate-400">{data.assumptions.estimated_interval_minutes} min</strong></span>
              <span>Tarifa energética: <strong className="text-slate-400">${data.assumptions.cost_per_kwh}/kWh</strong></span>
              {data.simulated && (
                <span className="text-amber-500/70">* Proyección simulada — desplegar sensores físicos para datos reales</span>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
