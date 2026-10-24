import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { ChevronDown, ChevronRight, RefreshCw } from 'lucide-react'
import api, { getApiErrorDetail } from '../api/client'
import type { StoredReading } from '../types'
import { levelTemp, levelCO2, levelCO, type SensorLevel } from '../utils/sensorColors'
import { buildingLabel, floorLabel, groupRooms, shortName, type Room } from '../utils/rooms'
import { RoomFilters, useRoomFilter } from '../components/RoomFilters'
import {
  Card, Chip, PageHeader, NODE_STATE, AI_STATE, LIVE_SECONDS, NODE_SETPOINT,
  fmt, parseUtc, timeAgo, valueText, type Tone,
} from '../components/ui'

// Design rules 1 + 11: "how are all the rooms?" for any number of rooms.
// Overview first (status counters), filter (search, building, floor, status),
// details on demand (cards only for rooms that need attention, a grouped table for the rest).

type Status = 'alert' | 'warn' | 'ok' | 'nodata'

interface Row { room: Room; latest: StoredReading | null; status: Status; level: SensorLevel | null }

const POLL_MS = 5_000
// A room whose last reading is older than this is "sin datos recientes".
const STALE_MIN = 15

const STATUS: Record<Status, { label: string; tone: Tone }> = {
  alert: { label: 'En alerta', tone: 'alert' },
  warn: { label: 'En atención', tone: 'warn' },
  ok: { label: 'Normales', tone: 'ok' },
  nodata: { label: 'Sin datos recientes', tone: 'muted' },
}
const ORDER: Status[] = ['alert', 'warn', 'ok', 'nodata']
const RANK: Record<SensorLevel, number> = { normal: 0, atencion: 1, elevado: 2, alerta: 3 }

function targetOf(room: Room, l: StoredReading | null) {
  if (l?.node_state?.accion) return NODE_SETPOINT
  return l?.cognitive_action?.target ?? room.target_temp
}

function levelOf(room: Room, l: StoredReading): SensorLevel {
  const levels = [levelTemp(l.temperature, targetOf(room, l)), levelCO2(l.co2_ppm ?? 0), levelCO(l.co_ppm ?? 0)]
  return levels.reduce((a, b) => (RANK[b] > RANK[a] ? b : a), 'normal' as SensorLevel)
}

function classify(room: Room, l: StoredReading | null, now: number): Row {
  if (!l || (now - parseUtc(l.timestamp).getTime()) / 60_000 > STALE_MIN) {
    return { room, latest: l, status: 'nodata', level: l ? levelOf(room, l) : null }
  }
  const level = levelOf(room, l)
  return { room, latest: l, level, status: level === 'alerta' ? 'alert' : level === 'normal' ? 'ok' : 'warn' }
}

// What the room is doing: the node's decision if it has one, else the AI's.
function decision(l: StoredReading | null): { label: string; tone: Tone } | null {
  if (!l) return null
  if (l.node_state?.alarma_co) return { label: 'Alarma CO', tone: 'alert' }
  const node = l.node_state?.accion
  if (node) return NODE_STATE[node] ?? { label: node, tone: 'muted' }
  const ai = l.cognitive_action?.ac_status
  return ai ? (AI_STATE[ai] ?? { label: ai, tone: 'muted' }) : null
}

function alertReason(r: Row): string {
  const l = r.latest
  if (!l) return ''
  if (levelCO(l.co_ppm ?? 0) !== 'normal') return `CO ${fmt(l.co_ppm, 0)} ppm`
  if (levelCO2(l.co2_ppm ?? 0) !== 'normal') return `CO₂ ${fmt(l.co2_ppm, 0)} ppm`
  return `${fmt(l.temperature)} °C (objetivo ${fmt(targetOf(r.room, l))} °C)`
}

// ── Pieces ────────────────────────────────────────────────────────────────────
const DOT: Record<Status, string> = { alert: 'bg-red-400', warn: 'bg-amber-400', ok: 'bg-emerald-400', nodata: 'bg-slate-500' }

function Counter({ status, count, active, onClick }: { status: Status; count: number; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className={`surface flex h-[72px] flex-col justify-between px-3 py-2 text-left transition-colors hover:border-slate-600 ${active ? 'border-blue-500/70' : ''}`}
    >
      <span className="flex items-center gap-1.5 text-xs text-slate-400">
        <span className={`h-1.5 w-1.5 rounded-full ${DOT[status]}`} />
        {STATUS[status].label}
      </span>
      <span className="text-xl font-semibold leading-none text-white tabular-nums">{count}</span>
    </button>
  )
}

function AttentionCard({ row, now }: { row: Row; now: number }) {
  const { room, latest: l } = row
  const d = decision(l)
  return (
    <Link to={`/room/${room.id}`} className={`surface flex flex-col gap-2 p-3 transition-colors hover:border-slate-600 ${row.status === 'alert' ? 'border-red-500/50' : 'border-amber-500/30'}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-white">{room.id} <span className="font-normal text-slate-400">{shortName(room)}</span></p>
          <p className="text-xs text-slate-500">{buildingLabel(room.building)} · {floorLabel(room.floor)}</p>
        </div>
        <Chip tone={STATUS[row.status].tone}>{alertReason(row)}</Chip>
      </div>
      <div className="flex items-center justify-between text-xs text-slate-400">
        <span>{timeAgo(l?.timestamp, now)}</span>
        {d && <Chip tone={d.tone}>{d.label}</Chip>}
      </div>
    </Link>
  )
}

function RoomRow({ row, now }: { row: Row; now: number }) {
  const navigate = useNavigate()
  const { room, latest: l } = row
  const live = !!l && (now - parseUtc(l.timestamp).getTime()) / 1000 < LIVE_SECONDS
  const target = targetOf(room, l)
  const d = decision(l)
  const stale = row.status === 'nodata'
  const cls = (level: SensorLevel) => (stale ? 'text-slate-500' : valueText(level))
  return (
    <tr className="table-row cursor-pointer" onClick={() => navigate(`/room/${room.id}`)}>
      <td className="py-2 pl-3 pr-4">
        <Link to={`/room/${room.id}`} onClick={e => e.stopPropagation()} className="text-sm font-medium text-slate-100 hover:underline">{room.id}</Link>
        <span className="ml-2 hidden text-xs text-slate-500 md:inline">{shortName(room)}</span>
      </td>
      <td className={`py-2 pr-4 text-sm tabular-nums ${l ? cls(levelTemp(l.temperature, target)) : 'text-slate-500'}`}>{l ? `${fmt(l.temperature)} °C` : '—'}</td>
      <td className={`py-2 pr-4 text-sm tabular-nums ${l ? cls(levelCO2(l.co2_ppm ?? 0)) : 'text-slate-500'}`}>{l ? fmt(l.co2_ppm, 0) : '—'}</td>
      <td className={`py-2 pr-4 text-sm tabular-nums ${l ? cls(levelCO(l.co_ppm ?? 0)) : 'text-slate-500'}`}>{l ? fmt(l.co_ppm) : '—'}</td>
      <td className="py-2 pr-4">{!stale && d ? <Chip tone={d.tone}>{d.label}</Chip> : <span className="text-xs text-slate-500">—</span>}</td>
      <td className="py-2 pr-3 text-right text-xs text-slate-400">
        <span className="inline-flex items-center gap-1.5">
          {live && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />}
          {live ? 'En vivo' : timeAgo(l?.timestamp, now)}
        </span>
      </td>
    </tr>
  )
}

// ── View ──────────────────────────────────────────────────────────────────────
export default function Overview() {
  const [rooms, setRooms] = useState<Room[]>([])
  const [latest, setLatest] = useState<Record<string, StoredReading | null>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [now, setNow] = useState(Date.now())
  const [statusFilter, setStatusFilter] = useState<Status | null>(null)
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const filter = useRoomFilter(rooms)

  useEffect(() => {
    api.get<Room[]>('/admin/rooms')
      .then(r => setRooms(r.data ?? []))
      .catch(err => setError(getApiErrorDetail(err) ?? 'No se pudieron cargar las aulas.'))
  }, [])

  // One aggregated request for every room's latest reading.
  useEffect(() => {
    let cancelled = false
    const load = () => api.get<{ room_id: string; reading: StoredReading | null }[]>('/sensors/latest')
      .then(r => {
        if (cancelled) return
        setLatest(Object.fromEntries((r.data ?? []).map(x => [x.room_id, x.reading])))
        setNow(Date.now())
        setError(null)
      })
      .catch(err => { if (!cancelled) setError(getApiErrorDetail(err) ?? 'No se pudieron cargar las lecturas.') })
      .finally(() => { if (!cancelled) setLoading(false) })
    load()
    const t = setInterval(load, POLL_MS)
    return () => { cancelled = true; clearInterval(t) }
  }, [])

  const all = useMemo(() => rooms.map(r => classify(r, latest[r.id] ?? null, now)), [rooms, latest, now])
  const counts = useMemo(
    () => Object.fromEntries(ORDER.map(s => [s, all.filter(r => r.status === s).length])) as Record<Status, number>,
    [all],
  )
  const visibleIds = new Set(filter.filtered.map(r => r.id))
  const rows = all.filter(r => visibleIds.has(r.room.id) && (!statusFilter || r.status === statusFilter))
  const attention = rows
    .filter(r => r.status === 'alert' || r.status === 'warn')
    .sort((a, b) => (a.status === b.status ? 0 : a.status === 'alert' ? -1 : 1))
  const groups = groupRooms(rows)
  const expandAll = filter.active || !!statusFilter || groups.length === 1
  const buildingsCount = new Set(rooms.map(r => r.building ?? '')).size
  const MAX_CARDS = 12

  return (
    <div className="space-y-4">
      <PageHeader
        title="Resumen"
        subtitle={<>
          <span>{rooms.length} aulas en {buildingsCount} {buildingsCount === 1 ? 'edificio' : 'edificios'}</span>
          <span>·</span>
          <span>se actualiza cada {POLL_MS / 1000} s</span>
        </>}
      />

      {error && <Card className="border-red-500/40 text-sm text-red-300">{error}</Card>}

      {/* 1 · Overview: counters double as status filters */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {ORDER.map(s => (
          <Counter key={s} status={s} count={counts[s] ?? 0} active={statusFilter === s} onClick={() => setStatusFilter(f => (f === s ? null : s))} />
        ))}
      </div>

      {/* 2 · Filter */}
      <RoomFilters rooms={rooms} state={filter.state} onChange={filter.setState}>
        {(filter.active || statusFilter) && (
          <button className="btn btn-ghost" onClick={() => { filter.setState({ query: '', building: '', floor: '' }); setStatusFilter(null) }}>
            Limpiar filtros
          </button>
        )}
        <span className="ml-auto text-xs text-slate-400">{rows.length} de {rooms.length} aulas</span>
      </RoomFilters>

      {loading ? (
        <p className="flex items-center gap-2 py-12 text-sm text-slate-400"><RefreshCw size={14} className="animate-spin" /> Cargando aulas…</p>
      ) : <>
        {/* 3 · Details on demand: only what needs attention gets a card */}
        {(!statusFilter || statusFilter === 'alert' || statusFilter === 'warn') && (
          <section>
            <h2 className="section-title mb-2">Requieren atención · {attention.length}</h2>
            {attention.length === 0
              ? <p className="text-sm text-slate-400">Ninguna aula requiere atención{filter.active ? ' con estos filtros' : ''}.</p>
              : (
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
                  {attention.slice(0, MAX_CARDS).map(r => <AttentionCard key={r.room.id} row={r} now={now} />)}
                </div>
              )}
            {attention.length > MAX_CARDS && (
              <p className="mt-2 text-xs text-slate-400">Y {attention.length - MAX_CARDS} más en la tabla de abajo.</p>
            )}
          </section>
        )}

        <section>
          <h2 className="section-title mb-2">Todas las aulas</h2>
          {rows.length === 0 ? (
            <p className="text-sm text-slate-400">Ningún aula coincide con los filtros.</p>
          ) : (
            <div className="space-y-2">
              {groups.map(g => {
                const groupRows = g.floors.flatMap(f => f.items)
                const isOpen = expandAll || !!open[g.building]
                const c = (s: Status) => groupRows.filter(r => r.status === s).length
                return (
                  <div key={g.building} className="surface overflow-hidden">
                    <button
                      className="flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-slate-800/40"
                      onClick={() => setOpen(o => ({ ...o, [g.building]: !isOpen }))}
                      aria-expanded={isOpen}
                    >
                      {isOpen ? <ChevronDown size={16} className="text-slate-400" /> : <ChevronRight size={16} className="text-slate-400" />}
                      <span className="text-sm font-semibold text-white">{buildingLabel(g.building || null)}</span>
                      <span className="text-xs text-slate-400">{groupRows.length} aulas</span>
                      <span className="ml-auto flex flex-wrap justify-end gap-1.5">
                        {c('alert') > 0 && <Chip tone="alert">{c('alert')} en alerta</Chip>}
                        {c('warn') > 0 && <Chip tone="warn">{c('warn')} en atención</Chip>}
                        {c('nodata') > 0 && <Chip>{c('nodata')} sin datos</Chip>}
                        {c('alert') + c('warn') === 0 && c('ok') > 0 && <Chip tone="ok">Todo normal</Chip>}
                      </span>
                    </button>
                    {isOpen && (
                      <div className="overflow-x-auto border-t border-slate-800">
                        <table className="w-full min-w-[640px]">
                          <thead>
                            <tr className="table-head">
                              <th className="py-2 pl-3 pr-4 font-normal">Aula</th>
                              <th className="py-2 pr-4 font-normal">Temp.</th>
                              <th className="py-2 pr-4 font-normal">CO₂ (ppm)</th>
                              <th className="py-2 pr-4 font-normal">CO (ppm)</th>
                              <th className="py-2 pr-4 font-normal">Estado</th>
                              <th className="py-2 pr-3 text-right font-normal">Última lectura</th>
                            </tr>
                          </thead>
                          {g.floors.map(f => (
                            <tbody key={String(f.floor)}>
                              <tr><td colSpan={6} className="bg-slate-950/40 px-3 py-1 text-xs text-slate-500">{floorLabel(f.floor)}</td></tr>
                              {f.items.map(r => <RoomRow key={r.room.id} row={r} now={now} />)}
                            </tbody>
                          ))}
                        </table>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </section>
      </>}
    </div>
  )
}
