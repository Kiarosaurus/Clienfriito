import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { RefreshCw, X } from 'lucide-react'
import api, { getApiErrorDetail } from '../api/client'
import type { StoredReading } from '../types'
import { levelTemp, levelHumedad, levelCO2, levelCO, type SensorLevel } from '../utils/sensorColors'
import { compareRooms, locationLabel, shortName, type Room } from '../utils/rooms'
import { RoomFilters, useRoomFilter } from '../components/RoomFilters'
import { useNodes, type NodeStatus } from '../hooks/useNodes'
import {
  NODE_STATE, AI_STATE, LIVE_SECONDS, NODE_SETPOINT, StatusText,
  fmt, parseUtc, timeAgo, valueText, type Tone,
} from '../components/ui'

// "How are all the rooms?" in one screen, for any number of rooms (rules 1, 7, 11, 12):
// status counters (they also filter) and one table of every room that scrolls inside.
// The table's Estado column already says what needs attention, so nothing is repeated.

type Status = 'alert' | 'warn' | 'ok' | 'nodata'
type NoDataReason = 'no-sensor' | 'never' | 'stale'

interface Row {
  room: Room
  latest: StoredReading | null
  fresh: boolean
  status: Status
  node?: NodeStatus
  noData?: NoDataReason
}

interface SensorLatest { sensor_id: string; room_id: string | null; reading: StoredReading | null }

const POLL_MS = 5_000
const STALE_MIN = 15

const STATUS: Record<Status, { label: string; tone: Tone; hint: string }> = {
  alert: { label: 'En alerta', tone: 'alert', hint: 'Valores fuera de rango o nodo desconectado' },
  warn: { label: 'En atención', tone: 'warn', hint: 'Valores que conviene revisar' },
  ok: { label: 'Normales', tone: 'ok', hint: 'Datos recientes y dentro de rango' },
  nodata: { label: 'Sin datos recientes', tone: 'muted', hint: `Sin sensor, sin lecturas o la última tiene más de ${STALE_MIN} min` },
}
const ORDER: Status[] = ['alert', 'warn', 'ok', 'nodata']
const RANK: Record<SensorLevel, number> = { normal: 0, atencion: 1, elevado: 2, alerta: 3 }

const ageMin = (l: StoredReading, now: number) => (now - parseUtc(l.timestamp).getTime()) / 60_000

function targetOf(room: Room, l: StoredReading | null) {
  if (l?.node_state?.accion) return NODE_SETPOINT
  return l?.cognitive_action?.target ?? room.target_temp
}

function levelOf(room: Room, l: StoredReading): SensorLevel {
  const levels = [levelTemp(l.temperature, targetOf(room, l)), levelCO2(l.co2_ppm ?? 0), levelCO(l.co_ppm ?? 0)]
  return levels.reduce((a, b) => (RANK[b] > RANK[a] ? b : a), 'normal' as SensorLevel)
}

function classify(room: Room, l: StoredReading | null, hasSensor: boolean, now: number, node?: NodeStatus): Row {
  const fresh = !!l && ageMin(l, now) <= STALE_MIN
  // A node that dropped (Last Will) means the room lost its local control: alert.
  if (node && !node.online) return { room, latest: l, fresh: false, status: 'alert', node }
  if (!fresh) {
    const noData: NoDataReason = !hasSensor ? 'no-sensor' : !l ? 'never' : 'stale'
    return { room, latest: l, fresh: false, status: 'nodata', node, noData }
  }
  const level = levelOf(room, l!)
  return { room, latest: l, fresh, node, status: level === 'alerta' ? 'alert' : level === 'normal' ? 'ok' : 'warn' }
}

// What the room is doing now: the node's decision if it has one, else the AI's.
function decision(l: StoredReading | null): { label: string; tone: Tone } | null {
  if (!l) return null
  if (l.node_state?.alarma_co) return { label: 'Alarma CO', tone: 'alert' }
  if (l.node_state?.manual) return { label: 'Manual', tone: 'warn' }
  const node = l.node_state?.accion
  if (node) return NODE_STATE[node] ?? { label: node, tone: 'muted' }
  const ai = l.cognitive_action?.ac_status
  return ai ? (AI_STATE[ai] ?? { label: ai, tone: 'muted' }) : null
}

// Estado column: the concrete problem when something is wrong, else what the room is doing.
function stateOf(r: Row): { label: string; tone: Tone } {
  if (r.node && !r.node.online) return { label: 'Nodo desconectado', tone: 'alert' }
  if (r.status === 'nodata') {
    return { label: r.noData === 'no-sensor' ? 'Sin sensor' : r.noData === 'never' ? 'Nunca envió datos' : 'Sin datos recientes', tone: 'muted' }
  }
  const l = r.latest!
  if (r.status === 'alert' || r.status === 'warn') {
    const tone = STATUS[r.status].tone
    if (l.node_state?.alarma_co || levelCO(l.co_ppm ?? 0) !== 'normal') return { label: 'CO alto', tone }
    if (levelCO2(l.co2_ppm ?? 0) !== 'normal') return { label: 'CO₂ elevado', tone }
    return { label: l.temperature > targetOf(r.room, l) ? 'Temperatura alta' : 'Temperatura baja', tone }
  }
  return decision(l) ?? { label: STATUS[r.status].label, tone: STATUS[r.status].tone }
}

const shortDate = (ts: string) =>
  parseUtc(ts).toLocaleString('es', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })

// ── Pieces ────────────────────────────────────────────────────────────────────
function Counter({ status, count, total, active, onClick }: {
  status: Status; count: number; total: number; active: boolean; onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      title={`${STATUS[status].hint}. Clic para ver solo estas aulas.`}
      className={`surface flex h-28 flex-col justify-between rounded-xl px-5 py-4 text-left transition-colors hover:border-slate-600 ${active ? 'border-slate-500 bg-slate-800/60' : ''}`}
    >
      <StatusText tone={STATUS[status].tone}><span className="text-sm text-slate-400">{STATUS[status].label}</span></StatusText>
      <span className="flex items-baseline gap-2">
        <span className="text-3xl font-semibold leading-none text-white tabular-nums">{count}</span>
        <span className="text-sm text-slate-500 tabular-nums">{total ? Math.round((count / total) * 100) : 0} %</span>
      </span>
    </button>
  )
}

function RoomTableRow({ row, now }: { row: Row; now: number }) {
  const navigate = useNavigate()
  const { room, latest: l, fresh } = row
  const live = fresh && !!l && (now - parseUtc(l.timestamp).getTime()) / 1000 < LIVE_SECONDS
  const target = targetOf(room, l)
  const cell = (level: SensorLevel | null) => `whitespace-nowrap px-3 py-2.5 text-right text-sm tabular-nums ${fresh && level ? valueText(level) : 'text-slate-500'}`
  const st = stateOf(row)
  return (
    <tr className="table-row cursor-pointer" onClick={() => navigate(`/room/${room.id}`)}>
      <td className="whitespace-nowrap px-5 py-2.5" title={shortName(room)}>
        <Link to={`/room/${room.id}`} onClick={e => e.stopPropagation()} className="text-sm font-medium text-slate-100 hover:underline">{room.id}</Link>
        <span className="ml-2.5 text-sm text-slate-500">{locationLabel(room)}</span>
      </td>
      <td className="whitespace-nowrap px-3 py-2.5"><StatusText tone={st.tone}><span className="text-sm text-slate-300">{st.label}</span></StatusText></td>
      <td className={cell(l ? levelTemp(l.temperature, target) : null)}>{l ? `${fmt(l.temperature)} °C` : '—'}</td>
      <td className={cell(l ? levelHumedad(l.humidity) : null)}>{l ? `${fmt(l.humidity, 0)} %` : '—'}</td>
      <td className={cell(l ? levelCO2(l.co2_ppm ?? 0) : null)}>{l ? fmt(l.co2_ppm, 0) : '—'}</td>
      <td className={cell(l ? levelCO(l.co_ppm ?? 0) : null)}>{l ? fmt(l.co_ppm) : '—'}</td>
      <td className="whitespace-nowrap px-5 py-2.5 text-right text-sm tabular-nums text-slate-500">
        {live ? 'En vivo' : l ? (fresh ? timeAgo(l.timestamp, now) : shortDate(l.timestamp)) : '—'}
      </td>
    </tr>
  )
}

// ── View ──────────────────────────────────────────────────────────────────────
export default function Overview() {
  const [rooms, setRooms] = useState<Room[]>([])
  const [sensors, setSensors] = useState<SensorLatest[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [now, setNow] = useState(Date.now())
  const [statusFilter, setStatusFilter] = useState<Status | null>(null)
  const filter = useRoomFilter(rooms)
  const nodes = useNodes()

  useEffect(() => {
    api.get<Room[]>('/admin/rooms')
      .then(r => setRooms(r.data ?? []))
      .catch(err => setError(getApiErrorDetail(err) ?? 'No se pudieron cargar las aulas.'))
  }, [])

  // One aggregated request: every sensor with its room and latest reading.
  useEffect(() => {
    let cancelled = false
    const load = () => api.get<SensorLatest[]>('/sensors/latest?by=sensor')
      .then(r => { if (!cancelled) { setSensors(r.data ?? []); setNow(Date.now()); setError(null) } })
      .catch(err => { if (!cancelled) setError(getApiErrorDetail(err) ?? 'No se pudieron cargar las lecturas.') })
      .finally(() => { if (!cancelled) setLoading(false) })
    load()
    const t = setInterval(load, POLL_MS)
    return () => { cancelled = true; clearInterval(t) }
  }, [])

  const byRoom = useMemo(() => {
    const m: Record<string, { latest: StoredReading | null; sensors: number }> = {}
    for (const s of sensors) {
      if (!s.room_id) continue
      const cur = m[s.room_id] ?? { latest: null, sensors: 0 }
      cur.sensors++
      if (s.reading && (!cur.latest || s.reading.timestamp > cur.latest.timestamp)) cur.latest = s.reading
      m[s.room_id] = cur
    }
    return m
  }, [sensors])

  const all = useMemo(
    () => rooms.map(r => classify(r, byRoom[r.id]?.latest ?? null, (byRoom[r.id]?.sensors ?? 0) > 0, now, nodes[r.id])),
    [rooms, byRoom, now, nodes],
  )
  const counts = useMemo(
    () => Object.fromEntries(ORDER.map(s => [s, all.filter(r => r.status === s).length])) as Record<Status, number>,
    [all],
  )
  const visibleIds = new Set(filter.filtered.map(r => r.id))
  // Alerts first, then by location: what needs attention is at the top of the one list.
  const rows = all
    .filter(r => visibleIds.has(r.room.id) && (!statusFilter || r.status === statusFilter))
    .sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status) || compareRooms(a.room, b.room))

  // Freshness of the whole system, as one short line under the title.
  const lastAny = sensors.reduce<string | null>((acc, s) => (s.reading && (!acc || s.reading.timestamp > acc) ? s.reading.timestamp : acc), null)
  const anyFresh = all.some(r => r.fresh)

  return (
    <div className="flex flex-col gap-5 lg:h-full lg:min-h-0">
      {/* Header: title + scope on the left, room filters on the right */}
      <div className="flex shrink-0 flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="page-title">Resumen</h1>
          <p className="mt-1 flex flex-wrap items-center gap-x-2 text-sm text-slate-400">
            {loading ? <span>Cargando…</span> : (
              <span
                className="inline-flex items-center gap-1.5"
                title={anyFresh ? `Se actualiza cada ${POLL_MS / 1000} s` : 'Ningún sensor reporta. Si los nodos deberían estar funcionando, revisa el broker MQTT y la ingesta del backend.'}
              >
                {!anyFresh && <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />}
                {lastAny
                  ? `Última lectura ${anyFresh ? timeAgo(lastAny, now) : `el ${shortDate(lastAny)}`}`
                  : 'Todavía no hay lecturas'}
              </span>
            )}
            {error && <><span>·</span><span className="text-red-300">{error}</span></>}
          </p>
        </div>
        <RoomFilters rooms={rooms} state={filter.state} onChange={filter.setState}>
          {statusFilter && (
            <button className="chip" onClick={() => setStatusFilter(null)} title="Quitar filtro">
              Solo {STATUS[statusFilter].label.toLowerCase()} <X size={12} />
            </button>
          )}
        </RoomFilters>
      </div>

      {/* Counters: the overview, and a status filter for the table */}
      <div className="grid shrink-0 grid-cols-2 gap-4 md:grid-cols-4">
        {ORDER.map(s => (
          <Counter key={s} status={s} count={counts[s] ?? 0} total={rooms.length} active={statusFilter === s} onClick={() => setStatusFilter(f => (f === s ? null : s))} />
        ))}
      </div>

      {/* Every room, one list ordered by status (alerts first); scrolls inside */}
      <div className="flex flex-col gap-2 lg:min-h-0 lg:flex-1">
      <h2 className="section-title shrink-0">Aulas</h2>
      <section className="surface flex min-h-[60vh] flex-col overflow-hidden rounded-xl lg:min-h-0 lg:flex-1">
        <div className="min-h-0 flex-1 overflow-auto">
          {loading ? (
            <p className="flex items-center gap-2 p-5 text-sm text-slate-400"><RefreshCw size={14} className="animate-spin" /> Cargando aulas…</p>
          ) : rows.length === 0 ? (
            <p className="p-5 text-sm text-slate-400">Ningún aula coincide con los filtros.</p>
          ) : (
            <table className="w-full min-w-[820px]">
              <thead className="sticky top-0 z-10 bg-slate-900">
                <tr className="table-head">
                  <th className="whitespace-nowrap px-5 py-2.5 font-normal">Aula</th>
                  <th className="whitespace-nowrap px-3 py-2.5 font-normal">Estado</th>
                  {['Temp.', 'Humedad', 'CO₂ ppm', 'CO ppm'].map(h => <th key={h} className="whitespace-nowrap px-3 py-2.5 text-right font-normal">{h}</th>)}
                  <th className="whitespace-nowrap px-5 py-2.5 text-right font-normal">Última lectura</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(r => <RoomTableRow key={r.room.id} row={r} now={now} />)}
              </tbody>
            </table>
          )}
        </div>
      </section>
      </div>
    </div>
  )
}
