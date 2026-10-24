import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { AlertTriangle, Search, RefreshCw } from 'lucide-react'
import api, { getApiErrorDetail } from '../api/client'
import type { StoredReading } from '../types'
import { useEmergency } from '../context/EmergencyContext'
import { levelTemp, levelCO2, levelCO, type SensorLevel } from '../utils/sensorColors'
import {
  Card, Chip, PageHeader, LEVEL_TONE, NODE_STATE, AI_STATE, LIVE_SECONDS,
  NODE_SETPOINT, fmt, parseUtc, timeAgo, toneText, type Tone,
} from '../components/ui'

interface Room {
  id: string
  name: string
  max_capacity: number
  target_temp: number
}

interface RoomRow {
  room: Room
  latest: StoredReading | null
}

const POLL_MS = 5_000
const LEVEL_RANK: Record<SensorLevel, number> = { normal: 0, atencion: 1, elevado: 2, alerta: 3 }

// Worst level across the room's latest values.
// Temperature reference: the node's setpoint when a node is acting, else the AI's.
function targetOf(r: RoomRow): number {
  const l = r.latest
  if (l?.node_state?.accion) return NODE_SETPOINT
  return l?.cognitive_action?.target ?? r.room.target_temp
}

function roomLevel(r: RoomRow): SensorLevel {
  const l = r.latest
  if (!l) return 'normal'
  const target = targetOf(r)
  const levels = [levelTemp(l.temperature, target), levelCO2(l.co2_ppm ?? 0), levelCO(l.co_ppm ?? 0)]
  return levels.reduce((a, b) => (LEVEL_RANK[b] > LEVEL_RANK[a] ? b : a), 'normal' as SensorLevel)
}

// Which magnitude put the room at alert level, in words.
function alertReason(r: RoomRow): string {
  const l = r.latest
  if (!l) return ''
  const target = targetOf(r)
  if (levelCO(l.co_ppm ?? 0) === 'alerta') return `CO ${fmt(l.co_ppm, 0)} ppm`
  if (levelCO2(l.co2_ppm ?? 0) === 'alerta') return `CO₂ ${fmt(l.co2_ppm, 0)} ppm`
  if (levelTemp(l.temperature, target) === 'alerta') return `${fmt(l.temperature)} °C, objetivo ${fmt(target)} °C`
  return 'fuera de rango'
}

// What the room is doing right now: the node's decision if it has one, else the AI's.
function decision(l: StoredReading | null): { label: string; tone: Tone; source: string } | null {
  if (!l) return null
  const node = l.node_state?.accion
  if (node) {
    if (l.node_state?.alarma_co) return { label: 'Alarma CO', tone: 'alert', source: 'nodo' }
    const s = NODE_STATE[node] ?? { label: node, tone: 'muted' as Tone }
    return { ...s, source: 'nodo' }
  }
  const ai = l.cognitive_action?.ac_status
  if (!ai) return null
  const s = AI_STATE[ai] ?? { label: ai, tone: 'muted' as Tone }
  return { ...s, source: 'IA' }
}

function splitName(room: Room) {
  // "A403 Aula Multipropósito" → code "A403", rest "Aula Multipropósito"
  const rest = room.name.startsWith(room.id) ? room.name.slice(room.id.length).trim() : room.name
  return { code: room.id, rest }
}

function Value({ label, value, unit, level }: { label: string; value: string; unit: string; level: SensorLevel | null }) {
  return (
    <div className="min-w-0">
      <p className="text-xs text-slate-400">{label}</p>
      <p className={`text-sm font-semibold tabular-nums ${level && level !== 'normal' ? toneText(LEVEL_TONE[level]) : 'text-slate-100'}`}>
        {value}{value !== '—' && <span className="ml-0.5 text-xs font-normal text-slate-400">{unit}</span>}
      </p>
    </div>
  )
}

function RoomCard({ row, now }: { row: RoomRow; now: number }) {
  const { room, latest: l } = row
  const { code, rest } = splitName(room)
  const age = l ? (now - parseUtc(l.timestamp).getTime()) / 1000 : Infinity
  const live = age < LIVE_SECONDS
  const d = decision(l)
  const level = roomLevel(row)
  const target = targetOf(row)

  return (
    <Link
      to={`/room/${room.id}`}
      className={`group flex flex-col gap-3 rounded-lg border bg-slate-800/60 p-3 transition-colors hover:border-slate-500 hover:bg-slate-800 ${
        level === 'alerta' ? 'border-red-500/50' : 'border-slate-700/60'
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-white">{code}</p>
          <p className="truncate text-xs text-slate-400">{rest}</p>
        </div>
        {d ? <Chip tone={d.tone} title={`Decisión del ${d.source}`}>{d.label}</Chip> : <Chip>Sin datos</Chip>}
      </div>

      <div className="grid grid-cols-3 gap-2">
        <Value label="Temp." value={fmt(l?.temperature)} unit="°C" level={l ? levelTemp(l.temperature, target) : null} />
        <Value label="CO₂" value={fmt(l?.co2_ppm, 0)} unit="ppm" level={l ? levelCO2(l.co2_ppm ?? 0) : null} />
        <Value label="CO" value={fmt(l?.co_ppm)} unit="ppm" level={l ? levelCO(l.co_ppm ?? 0) : null} />
      </div>

      <div className="flex items-center justify-between gap-2 border-t border-slate-700/60 pt-2 text-xs text-slate-400">
        <span className="flex items-center gap-1.5">
          <span className={`h-1.5 w-1.5 rounded-full ${live ? 'animate-pulse bg-emerald-400' : 'bg-slate-500'}`} />
          {live ? 'En vivo' : timeAgo(l?.timestamp, now)}
        </span>
        <span className="flex items-center gap-1.5">
          {l?.is_simulated && <Chip tone="warn">Simulada</Chip>}
          {d?.source === 'nodo' && <Chip tone="info">Nodo ESP32</Chip>}
        </span>
      </div>
    </Link>
  )
}

export default function Overview() {
  const [rooms, setRooms] = useState<Room[]>([])
  const [latest, setLatest] = useState<Record<string, StoredReading | null>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [now, setNow] = useState(Date.now())
  const { realEmergencies } = useEmergency()

  useEffect(() => {
    api.get<Room[]>('/admin/rooms')
      .then(r => setRooms(r.data ?? []))
      .catch(err => setError(getApiErrorDetail(err) ?? 'No se pudieron cargar las aulas.'))
      .finally(() => setLoading(false))
  }, [])

  // Latest reading per room, refreshed every few seconds.
  useEffect(() => {
    if (rooms.length === 0) return
    let cancelled = false
    const load = async () => {
      const entries = await Promise.all(rooms.map(async room => {
        try {
          const { data } = await api.get<StoredReading[]>(`/sensors/?room_id=${room.id}&limit=1`)
          return [room.id, data?.[0] ?? null] as const
        } catch {
          return [room.id, null] as const
        }
      }))
      if (!cancelled) { setLatest(Object.fromEntries(entries)); setNow(Date.now()) }
    }
    load()
    const t = setInterval(load, POLL_MS)
    return () => { cancelled = true; clearInterval(t) }
  }, [rooms])

  const rows = useMemo<RoomRow[]>(() => {
    const q = query.trim().toLowerCase()
    return rooms
      .filter(r => !q || r.name.toLowerCase().includes(q) || r.id.toLowerCase().includes(q))
      .map(room => ({ room, latest: latest[room.id] ?? null }))
      // Alerts first, then the most recently updated rooms.
      .sort((a, b) =>
        LEVEL_RANK[roomLevel(b)] - LEVEL_RANK[roomLevel(a)] ||
        (b.latest ? parseUtc(b.latest.timestamp).getTime() : 0) - (a.latest ? parseUtc(a.latest.timestamp).getTime() : 0),
      )
  }, [rooms, latest, query])

  const all = rooms.map(room => ({ room, latest: latest[room.id] ?? null }))
  const liveCount = all.filter(r => r.latest && (now - parseUtc(r.latest.timestamp).getTime()) / 1000 < LIVE_SECONDS).length
  const alertRooms = all.filter(r => roomLevel(r) === 'alerta')

  return (
    <div className="space-y-4">
      <PageHeader
        title="Resumen"
        subtitle={<>
          <span>{rooms.length} aulas</span>
          <span>·</span>
          <span>{liveCount} en vivo</span>
        </>}
      >
        <label className="relative">
          <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500" />
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Buscar aula…"
            className="w-48 rounded-lg border border-slate-700 bg-slate-800 py-1.5 pl-8 pr-3 text-sm text-slate-100 placeholder-slate-500 focus:border-blue-500 focus:outline-none"
          />
        </label>
      </PageHeader>

      {/* 1 · Alerts */}
      {realEmergencies.length > 0 || alertRooms.length > 0 ? (
        <Card className="border-red-500/40 bg-red-950/30">
          <div className="flex flex-wrap items-center gap-2 text-sm text-red-200">
            <AlertTriangle size={16} className="text-red-400" />
            <span className="font-semibold">Alertas activas:</span>
            {realEmergencies.map(e => (
              <Link key={e.sensor_id} to={`/room/${e.room_id}`}><Chip tone="alert">{e.room_id} · CO {e.co_ppm.toFixed(0)} ppm</Chip></Link>
            ))}
            {alertRooms.filter(r => !realEmergencies.some(e => e.room_id === r.room.id)).map(r => (
              <Link key={r.room.id} to={`/room/${r.room.id}`}><Chip tone="alert">{r.room.id} · {alertReason(r)}</Chip></Link>
            ))}
          </div>
        </Card>
      ) : (
        <p className="flex items-center gap-2 text-xs text-slate-400">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" /> Sin alertas activas
        </p>
      )}

      {error && <Card className="border-red-500/40 text-sm text-red-300">{error}</Card>}

      {/* 2 · Rooms */}
      {loading ? (
        <p className="flex items-center gap-2 py-12 text-sm text-slate-400"><RefreshCw size={14} className="animate-spin" /> Cargando aulas…</p>
      ) : rows.length === 0 ? (
        <p className="py-12 text-center text-sm text-slate-400">
          {query ? `Ningún aula coincide con "${query}".` : 'No hay aulas registradas. Créalas en Infraestructura.'}
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
          {rows.map(r => <RoomCard key={r.room.id} row={r} now={now} />)}
        </div>
      )}
    </div>
  )
}
