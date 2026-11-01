import { useEffect, useState } from 'react'
import api, { getApiErrorDetail } from '../api/client'
import { useAuth } from '../context/AuthContext'
import { Chip, parseUtc, timeAgo } from './ui'

// "Quién controla el aula": the node's rules or the learning controller, next to how
// close learning is to the goal. Backend: /sensors/rooms/{id}/controller and the
// month's strategy comparison (/strategies?range=30d).

// Same goal as the Aprendizaje tab: class time outside the ideal range.
const GOAL_PCT = 5
// Learning orders last 10 min and are renewed every 5 (backend room_controller).
const ORDER_FRESH_MIN = 10

type Mode = 'rules' | 'learning'
interface Summary { pct_out_of_band: number | null; occupied_hours: number; kwh: number }
interface Month { start?: string; rules?: { summary: Summary | null }; learning?: { summary: Summary | null } }
interface LastOrder { mode: 'fan' | 'heater' | 'off'; level: number | null; started_at: string }
interface Controller { mode: Mode; by: string | null; at: string | null; last_order: LastOrder | null }

const orderText = (o: LastOrder) =>
  o.mode === 'fan' ? `ventilador al ${o.level ?? 100} %` : o.mode === 'heater' ? 'calefactor encendido' : 'todo apagado'

/** Track from 0 to `max` % with the goal zone and both strategies marked. */
function GoalTrack({ rules, learning }: { rules: number; learning: number }) {
  const max = Math.max(50, Math.ceil(Math.max(rules, learning) / 10) * 10)
  const W = 700
  const x = (p: number) => (p / max) * W
  const goalX = x(GOAL_PCT), lx = x(learning), rx = x(rules)
  const gap = learning - GOAL_PCT
  return (
    <svg viewBox="0 0 700 150" className="block h-auto w-full" role="img"
      aria-label={`Fuera del rango ideal: aprendizaje ${learning.toFixed(1)} %, reglas ${rules.toFixed(1)} %, meta menos de ${GOAL_PCT} %`}>
      <rect x={0} y={62} width={W} height={14} rx={7} fill="#1e293b" />
      <rect x={0} y={62} width={goalX} height={14} rx={7} fill="#34d399" opacity={0.45} />
      <text x={goalX / 2} y={100} textAnchor="middle" fontSize={12} fill="#6ee7b7">Meta</text>
      <text x={goalX / 2} y={116} textAnchor="middle" fontSize={12} fill="#6ee7b7">{`< ${GOAL_PCT} %`}</text>

      {gap > 0 && <>
        <path d={`M${goalX + 8},46 H${lx - 9}`} stroke="#475569" strokeDasharray="3 3" />
        <text x={(goalX + lx) / 2} y={40} textAnchor="middle" fontSize={11} fill="#94a3b8">le faltan {gap.toFixed(1)} puntos</text>
      </>}

      {/* Learning above the track, rules below: they never collide */}
      <line x1={lx} x2={lx} y1={34} y2={80} stroke="#38bdf8" strokeWidth={2} />
      <circle cx={lx} cy={69} r={8} fill="#38bdf8" stroke="#0f172a" strokeWidth={3} />
      <text x={lx} y={14} textAnchor="middle" fontSize={12} fill="#7dd3fc">Aprendizaje</text>
      <text x={lx} y={30} textAnchor="middle" fontSize={16} fontWeight={600} fill="#f8fafc">{learning.toFixed(1)} %</text>

      <line x1={rx} x2={rx} y1={62} y2={104} stroke="#94a3b8" strokeWidth={2} />
      <circle cx={rx} cy={69} r={8} fill="#94a3b8" stroke="#0f172a" strokeWidth={3} />
      <text x={rx} y={124} textAnchor="middle" fontSize={16} fontWeight={600} fill="#f8fafc">{rules.toFixed(1)} %</text>
      <text x={rx} y={142} textAnchor="middle" fontSize={12} fill="#94a3b8">Reglas</text>

      <text x={0} y={140} fontSize={11} fill="#475569">0 %</text>
      <text x={W} y={140} textAnchor="end" fontSize={11} fill="#475569">{max} %</text>
    </svg>
  )
}

function Stat({ label, value, unit }: { label: string; value: string; unit: string }) {
  return (
    <div className="surface-inset px-3 py-2.5">
      <p className="text-xs text-slate-400">{label}</p>
      <p className="mt-1 text-xl font-semibold tabular-nums text-slate-100">{value} <span className="text-sm font-normal text-slate-500">{unit}</span></p>
    </div>
  )
}

function Option({ selected, disabled, title, chip, children, onClick }: {
  selected: boolean; disabled: boolean; title: string; chip: string; children: string; onClick: () => void
}) {
  return (
    <button type="button" role="radio" aria-checked={selected} disabled={disabled} onClick={onClick}
      className={`flex w-full gap-3 rounded-lg border p-3 text-left transition-colors disabled:cursor-not-allowed ${
        selected ? 'border-blue-500/60 bg-blue-500/5' : 'border-slate-800 bg-slate-950/60 enabled:hover:border-slate-600'}`}>
      <span className={`mt-0.5 h-4 w-4 shrink-0 rounded-full ${selected ? 'border-[5px] border-blue-500' : 'border-2 border-slate-600'}`} />
      <span className="min-w-0 flex-1">
        <span className="flex items-center justify-between gap-2 text-sm font-medium text-slate-100">
          {title}<Chip tone={selected ? 'ok' : 'muted'} dot={selected}>{chip}</Chip>
        </span>
        <span className="mt-1 block text-xs text-slate-400">{children}</span>
      </span>
    </button>
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
  const hasEval = R?.pct_out_of_band != null && L?.pct_out_of_band != null
  const monthName = month?.start ? parseUtc(month.start).toLocaleDateString('es', { month: 'long' }) : null
  const mode: Mode = ctl?.mode ?? 'rules'
  const order = ctl?.last_order
  const orderFresh = order && now - parseUtc(order.started_at).getTime() < ORDER_FRESH_MIN * 60_000
  const learningMeetsGoal = hasEval && L!.pct_out_of_band! < GOAL_PCT

  return (
    <section className="surface grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_24rem]">
      {/* Left: how close learning is to the goal */}
      <div className="border-b border-slate-800 p-4 lg:border-b-0 lg:border-r">
        <header className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="section-title">Camino a la meta</h2>
          <span className="text-xs text-slate-500">
            Tiempo de clase fuera del rango ideal{monthName && ` · ${monthName}`}
          </span>
        </header>
        {!month ? <div className="h-[12.5rem]" />
          : !hasEval ? <p className="py-10 text-center text-sm text-slate-400">Aún no hay datos para comparar las estrategias.</p>
          : <>
            <GoalTrack rules={R!.pct_out_of_band!} learning={L!.pct_out_of_band!} />
            <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
              <Stat label="Mejora frente a reglas" value={(L!.pct_out_of_band! - R!.pct_out_of_band!).toFixed(1).replace(/^(\d)/, '+$1').replace('-', '−')} unit="puntos" />
              <Stat label="Energía" value={L!.kwh.toFixed(0)} unit={`kWh · reglas ${R!.kwh.toFixed(0)}`} />
              <Stat label="Horas de clase evaluadas" value={L!.occupied_hours.toFixed(0)} unit="h" />
            </div>
          </>}
      </div>

      {/* Right: choose */}
      <div className="flex flex-col gap-2 p-4" role="radiogroup" aria-label="Quién controla el aula">
        <h2 className="section-title mb-1">Quién controla el aula</h2>
        <Option selected={mode === 'rules'} disabled={!isAdmin || saving || !ctl} title="Reglas del nodo"
          chip={mode === 'rules' ? 'Controlando' : 'Respaldo'} onClick={() => mode !== 'rules' && choose('rules')}>
          Decide el nodo con umbrales fijos. Funciona sin conexión.
        </Option>
        <Option selected={mode === 'learning'} disabled={!isAdmin || saving || !ctl} title="Aprendizaje automático"
          chip={mode === 'learning' ? 'Controlando' : 'En sombra'} onClick={() => mode !== 'learning' && setConfirming(true)}>
          Decide el servidor y envía órdenes cada 5 min. Prepara el aula antes de cada clase.
        </Option>

        {confirming && (
          <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-3">
            <p className="text-sm text-amber-200">
              {learningMeetsGoal ? 'Ya alcanzó la meta.' : 'Aún no alcanza la meta.'} Si el nodo pierde la conexión, vuelve solo a sus reglas.
            </p>
            <div className="mt-3 flex justify-end gap-2">
              <button type="button" className="btn btn-secondary" onClick={() => setConfirming(false)} disabled={saving}>Cancelar</button>
              <button type="button" className="btn bg-amber-600 text-white hover:bg-amber-500" onClick={() => choose('learning')} disabled={saving}>Confirmar</button>
            </div>
          </div>
        )}
        {error && <p className="text-xs text-red-300">{error}</p>}

        <div className="mt-auto space-y-1.5 border-t border-slate-800 pt-3 text-xs text-slate-400">
          <p className="flex items-center gap-2">
            <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${mode === 'learning' && !orderFresh ? 'bg-amber-400' : 'bg-emerald-400'}`} />
            {mode === 'rules'
              ? 'Controlan las reglas · el aprendizaje observa en sombra'
              : orderFresh
                ? `Controla el aprendizaje · última orden ${timeAgo(order!.started_at, now)}: ${orderText(order!)}`
                : 'Sin órdenes recientes del aprendizaje: el nodo sigue sus reglas'}
          </p>
          <p className="text-slate-500">
            La alarma de CO la maneja siempre el nodo. {isAdmin ? 'Solo administradores pueden cambiarlo.' : 'Solo lectura: lo cambia un administrador.'}
          </p>
        </div>
      </div>
    </section>
  )
}
