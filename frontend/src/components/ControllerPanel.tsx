import { useEffect, useState } from 'react'
import api, { getApiErrorDetail } from '../api/client'
import { useAuth } from '../context/AuthContext'
import { parseUtc } from './ui'
import { FW } from './NodeLive'

// "Quién controla el aula": the node's rules and the learning controller side by side,
// each with its month result against the same goal and how it decides, and the button
// to put it in charge. Backend: /sensors/rooms/{id}/controller and the month's strategy
// comparison (/strategies?range=30d).

// Same goal as the Aprendizaje tab: class time outside the ideal range.
const GOAL_PCT = 5
// Learning orders last 10 min and are renewed every 5 (backend room_controller).
const ORDER_FRESH_MIN = 10

type Mode = 'rules' | 'learning'
interface Summary { pct_out_of_band: number | null; occupied_hours: number; kwh: number }
interface Month { start?: string; rules?: { summary: Summary | null }; learning?: { summary: Summary | null } }
interface LastOrder { mode: 'fan' | 'heater' | 'off'; level: number | null; started_at: string }
interface Controller { mode: Mode; by: string | null; at: string | null; last_order: LastOrder | null }

const num = (n: number, dec = 1) => n.toLocaleString('es', { minimumFractionDigits: dec, maximumFractionDigits: dec })

// Firmware rules (hardware/firmware/src/sketch.ino, mirrored in FW), by priority.
const RULE_GROUPS: { name: string; hint: string; rows: [string, string][] }[] = [
  { name: 'Primero', hint: 'manda sobre la temperatura', rows: [
    [`CO desde ${FW.coAlarm} ppm`, 'Alarma y ventilador al 100 %'],
    ['Aula vacía', 'Todo apagado'],
  ] },
  { name: 'Si no, según la temperatura', hint: `objetivo ${num(FW.setpoint, 0)} °C`, rows: [
    [`Bajo ${num(FW.heatOn)} °C`, 'Calefactor'],
    [`${num(FW.heatOn)} – ${num(FW.coolOn)} °C`, 'En espera'],
    [`${num(FW.coolOn)} – ${num(FW.fan75At)} °C`, 'Ventilador al 50 %'],
    [`${num(FW.fan75At)} – ${num(FW.fan100At)} °C`, 'Ventilador al 75 %'],
    [`Desde ${num(FW.fan100At)} °C`, 'Ventilador al 100 %'],
  ] },
]

const LEARNING_STEPS = [
  'Prepara el aula antes de cada clase, según el horario.',
  'Cada 5 minutos ajusta el ventilador o el calefactor.',
  'Si pierde la conexión, el nodo vuelve a sus reglas.',
]

/** Month result: share of class time out of range, on a 0–50 % track with the goal zone. */
function Result({ summary, monthName, tone }: { summary: Summary | null | undefined; monthName: string | null; tone: 'rules' | 'learning' }) {
  const pct = summary?.pct_out_of_band
  if (pct == null) return <p className="text-sm text-slate-500">Aún no hay datos {monthName ? `de ${monthName}` : 'de este mes'}.</p>
  const max = Math.max(50, Math.ceil(pct / 10) * 10)
  return (
    <div className="flex flex-col gap-2.5">
      <p className="flex flex-wrap items-baseline gap-x-2.5">
        <span className="text-3xl font-semibold tabular-nums text-white">{num(pct)} %</span>
        <span className="text-sm text-slate-400">de las clases fuera del rango · meta: menos de {GOAL_PCT} %</span>
      </p>
      <div className="relative h-2 rounded-full bg-slate-800" role="img" aria-label={`${num(pct)} % fuera del rango; meta menos de ${GOAL_PCT} %`}>
        <div className="absolute inset-y-0 left-0 rounded-full bg-emerald-400/40" style={{ width: `${(GOAL_PCT / max) * 100}%` }} />
        <div className={`absolute -top-1 h-4 w-4 -translate-x-1/2 rounded-full border-[3px] border-slate-900 ${tone === 'learning' ? 'bg-sky-400' : 'bg-slate-400'}`}
          style={{ left: `${Math.min(100, (pct / max) * 100)}%` }} />
      </div>
      <span className="text-xs text-slate-500">{num(summary!.kwh, 0)} kWh en {monthName ?? 'el mes'}</span>
    </div>
  )
}

function StrategyCard({ title, desc, active, chip, chipDot, canChoose, busy, onChoose, children }: {
  title: string; desc: string; active: boolean; chip: string; chipDot: string
  canChoose: boolean; busy: boolean; onChoose: () => void; children: React.ReactNode
}) {
  return (
    <section className={`surface flex min-h-0 flex-col overflow-hidden ${active ? 'border-blue-500/60' : ''}`}>
      <header className="flex items-center gap-3 px-6 py-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
            <h3 className="text-base font-semibold text-white">{title}</h3>
            <span className="flex items-center gap-1.5 text-xs text-slate-400"><span className={`h-1.5 w-1.5 rounded-full ${chipDot}`} />{chip}</span>
          </div>
          <p className="mt-1 text-sm text-slate-400">{desc}</p>
        </div>
        {active
          ? <span className="btn btn-secondary pointer-events-none min-w-[5.5rem] justify-center text-slate-500">En uso</span>
          : canChoose && <button type="button" className="btn btn-primary min-w-[5.5rem] justify-center" onClick={onChoose} disabled={busy}>Usar</button>}
      </header>
      {children}
    </section>
  )
}

export default function ControllerPanel({ roomId }: { roomId: string }) {
  const { user } = useAuth()
  const isAdmin = user?.role === 'admin'
  const [month, setMonth] = useState<Month | null>(null)
  const [ctl, setCtl] = useState<Controller | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [now, setNow] = useState(Date.now())
  const base = `/sensors/rooms/${encodeURIComponent(roomId)}`

  useEffect(() => {
    let alive = true
    api.get<Month>(`${base}/strategies?range=30d`).then(r => alive && setMonth(r.data)).catch(() => alive && setMonth({}))
    const loadCtl = () => api.get<Controller>(`${base}/controller`).then(r => alive && setCtl(r.data)).catch(() => {})
    loadCtl()
    const t = setInterval(() => { loadCtl(); setNow(Date.now()) }, 60_000)   // orders change every 5 min
    return () => { alive = false; clearInterval(t) }
  }, [base])

  const choose = async (mode: Mode) => {
    setSaving(true); setError(null)
    try {
      const r = await api.put<Controller>(`${base}/controller`, { mode })
      const fresh = await api.get<Controller>(`${base}/controller`).catch(() => ({ data: { ...r.data, last_order: null } }))
      setCtl(fresh.data); setConfirming(false); setNow(Date.now())
    } catch (e) {
      setError(getApiErrorDetail(e) ?? 'No se pudo cambiar quién controla el aula.')
    } finally {
      setSaving(false)
    }
  }

  const R = month?.rules?.summary, L = month?.learning?.summary
  const monthName = month?.start ? parseUtc(month.start).toLocaleDateString('es', { month: 'long' }) : null
  const mode: Mode = ctl?.mode ?? 'rules'
  const order = ctl?.last_order
  const orderFresh = !!order && now - parseUtc(order.started_at).getTime() < ORDER_FRESH_MIN * 60_000
  const learningMeetsGoal = L?.pct_out_of_band != null && L.pct_out_of_band < GOAL_PCT
  const canChoose = isAdmin && !!ctl

  return (
    <div className="flex flex-col gap-3 lg:min-h-0 lg:flex-1">
      <div className="flex shrink-0 flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-base font-semibold text-white">Quién controla el aula</h2>
        {!isAdmin && <span className="text-xs text-slate-500">Solo lectura: lo cambia un administrador.</span>}
      </div>
      {error && <p className="text-sm text-red-300">{error}</p>}

      <div className="grid grid-cols-1 gap-4 lg:min-h-0 lg:flex-1 lg:grid-cols-2">
        <StrategyCard
          title="Reglas del nodo" desc="Umbrales fijos. Funciona sin conexión."
          active={mode === 'rules'} chip={mode === 'rules' ? 'Controlando' : 'Respaldo'}
          chipDot={mode === 'rules' ? 'bg-emerald-400' : 'bg-slate-600'}
          canChoose={canChoose} busy={saving} onChoose={() => choose('rules')}
        >
          <div className="px-6 pb-5 pt-1"><Result summary={R} monthName={monthName} tone="rules" /></div>
          <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto border-t border-slate-800 px-6 py-4">
            <span className="text-sm text-slate-400">Cómo decide</span>
            <div className="flex flex-col gap-5 text-sm">
              {RULE_GROUPS.map((g, i) => (
                <div key={g.name}>
                  <div className="flex items-baseline gap-2 border-b border-slate-700 pb-1.5">
                    <span className="text-slate-500">{i + 1}.</span>
                    <span className="font-medium text-slate-300">{g.name}</span>
                    <span className="ml-auto text-xs text-slate-500">{g.hint}</span>
                  </div>
                  {g.rows.map(([when, then]) => (
                    <div key={when} className="grid grid-cols-[12rem_minmax(0,1fr)] gap-4 border-b border-slate-800 py-2 pl-5">
                      <span className="tabular-nums text-slate-400">{when}</span>
                      <span className="text-slate-100">{then}</span>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </div>
        </StrategyCard>

        <StrategyCard
          title="Aprendizaje automático" desc="Aprende cómo responde el aula."
          active={mode === 'learning'}
          chip={mode === 'learning' ? (orderFresh ? 'Controlando' : 'Sin órdenes recientes') : 'En sombra'}
          chipDot={mode === 'learning' ? (orderFresh ? 'bg-emerald-400' : 'bg-amber-400') : 'bg-slate-600'}
          canChoose={canChoose} busy={saving} onChoose={() => setConfirming(true)}
        >
          {confirming && (
            <div className="mx-6 mb-4 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3">
              <p className="text-sm text-amber-200">
                {learningMeetsGoal ? 'Ya alcanzó la meta.' : 'Aún no alcanza la meta.'} Si el nodo pierde la conexión, vuelve solo a sus reglas.
              </p>
              <div className="mt-3 flex justify-end gap-2">
                <button type="button" className="btn btn-secondary" onClick={() => setConfirming(false)} disabled={saving}>Cancelar</button>
                <button type="button" className="btn bg-amber-600 text-white hover:bg-amber-500" onClick={() => choose('learning')} disabled={saving}>Confirmar</button>
              </div>
            </div>
          )}
          <div className="px-6 pb-5 pt-1"><Result summary={L} monthName={monthName} tone="learning" /></div>
          <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto border-t border-slate-800 px-6 py-4">
            <span className="text-sm text-slate-400">Cómo decide</span>
            <ol className="flex flex-col gap-3.5 text-sm leading-relaxed text-slate-200">
              {LEARNING_STEPS.map((s, i) => (
                <li key={s} className="grid grid-cols-[1.25rem_minmax(0,1fr)] gap-2.5"><span className="text-slate-500">{i + 1}</span>{s}</li>
              ))}
            </ol>
          </div>
        </StrategyCard>
      </div>
    </div>
  )
}
