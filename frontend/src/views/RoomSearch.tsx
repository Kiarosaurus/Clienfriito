import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Search, Building2, Users, Thermometer,
  RefreshCw, AlertCircle, Fan,
} from 'lucide-react'
import api, { getApiErrorDetail } from '../api/client'
import { EmptyState } from '../components/EmptyState'
import type { StoredReading } from '../types'
import { decisionOf, fanPwmOf, fmtNum, parseUtcMs, mqttTopic, nodeOnline, ago } from '../utils/node'
import { DecisionBadge, NodeLinkBadge, OriginBadge, AlarmOverrideBadge, lwtFor } from '../components/NodeWidgets'
import { useHealth, useNow, updatedAgo } from '../utils/live'

// Refresco en vivo del estado de cada aula (FE-2-03).
const STATUS_POLL_MS = 15_000

interface Room {
  // Room PKs are strings in PostgreSQL (e.g. "A403").
  id: string
  name: string
  max_capacity: number
  target_temp: number
}

interface RoomStatus {
  last: StoredReading | null
  loading: boolean
}

type StatusMap = Record<string, RoomStatus>

export default function RoomSearch() {
  const navigate = useNavigate()
  const [rooms, setRooms] = useState<Room[]>([])
  const [statuses, setStatuses] = useState<StatusMap>({})
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [lastUpdated, setLastUpdated] = useState<number | null>(null)
  const now = useNow(5_000)
  const { data: health } = useHealth()

  useEffect(() => {
    api.get<Room[]>('/admin/rooms')
      .then(res => {
        const data = res.data
        setRooms(data)
        // Seed loading placeholders
        const initial: StatusMap = {}
        data.forEach(r => { initial[r.id] = { last: null, loading: true } })
        setStatuses(initial)
      })
      .catch(err => {
        setError(getApiErrorDetail(err) ?? 'No se pudo cargar la lista de aulas.')
      })
      .finally(() => setLoading(false))
  }, [])

  // Última lectura por aula, refrescada cada 15 s (el badge "En línea" cae a
  // "Fuera de línea" por antigüedad aunque no lleguen lecturas nuevas).
  useEffect(() => {
    if (rooms.length === 0) return
    let cancelled = false
    const load = () => {
      rooms.forEach(room => {
        api.get<StoredReading[]>(`/sensors/?room_id=${encodeURIComponent(room.id)}&limit=1`)
          .then(res => {
            if (cancelled) return
            const last = (res.data ?? []).find(d => parseUtcMs(d.timestamp) != null) ?? null
            setStatuses(prev => ({ ...prev, [room.id]: { last, loading: false } }))
            setLastUpdated(Date.now())
          })
          .catch(() => {
            if (cancelled) return
            setStatuses(prev => ({ ...prev, [room.id]: { last: prev[room.id]?.last ?? null, loading: false } }))
          })
      })
    }
    load()
    const t = setInterval(load, STATUS_POLL_MS)
    return () => { cancelled = true; clearInterval(t) }
  }, [rooms])

  const filtered = rooms.filter(r =>
    r.name.toLowerCase().includes(query.toLowerCase())
  )

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Building2 size={22} className="text-blue-400" />
        <div>
          <h1 className="text-xl font-bold text-white">Aulas</h1>
          <p className="text-sm text-slate-400">Selecciona un aula para ver su dashboard cognitivo · <span className="text-slate-500">{updatedAgo(lastUpdated, now)}</span></p>
        </div>
      </div>

      {/* Search bar */}
      <div className="relative max-w-sm">
        <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
        <input
          type="text"
          placeholder="Buscar aula…"
          value={query}
          onChange={e => setQuery(e.target.value)}
          className="w-full bg-slate-800 border border-slate-700 rounded-lg pl-9 pr-4 py-2.5 text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500/50 transition"
        />
      </div>

      {/* Loading */}
      {loading && (
        <div className="flex items-center gap-2 text-slate-400 text-sm">
          <RefreshCw size={14} className="animate-spin" /> Cargando aulas…
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="flex items-center gap-2 bg-red-900/30 border border-red-500/40 rounded-lg px-4 py-3 text-sm text-red-300">
          <AlertCircle size={16} className="shrink-0" /> {error}
        </div>
      )}

      {/* Empty */}
      {!loading && !error && filtered.length === 0 && (
        query ? (
          <EmptyState
            icon={<Search size={22} />}
            title="Sin resultados"
            hint={`Ninguna aula coincide con "${query}".`}
            action={{ label: 'Limpiar búsqueda', onClick: () => setQuery('') }}
          />
        ) : (
          <EmptyState
            icon={<Building2 size={22} />}
            title="Aún no hay aulas"
            hint="Registra tu primera aula para verla y abrir su dashboard cognitivo."
            action={{ label: 'Registrar un aula', onClick: () => navigate('/infrastructure') }}
          />
        )
      )}

      {/* Card grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
        {filtered.map(room => {
          const st = statuses[room.id]
          // Decisión vigente solo si el nodo está en línea; si no, se rotula como la última conocida (FE-3-07).
          const link = nodeOnline(st?.last ?? null, now, { lwt: lwtFor(health, room.id) })
          const current = link.online === true
          return (
            <button
              key={room.id}
              onClick={() => navigate(`/room/${room.id}`)}
              className="bg-slate-800 border border-slate-700 hover:border-blue-500/60 hover:bg-slate-700/60 rounded-xl p-5 text-left transition-all group"
            >
              {/* Header row */}
              <div className="flex items-start justify-between mb-3">
                <div className="w-10 h-10 rounded-lg bg-blue-600/20 border border-blue-500/30 flex items-center justify-center group-hover:bg-blue-600/30 transition-colors">
                  <Building2 size={20} className="text-blue-400" />
                </div>
                {st?.loading
                  ? <span className="flex items-center gap-1 text-xs text-slate-500"><RefreshCw size={10} className="animate-spin" /> …</span>
                  : (
                    <div className="flex flex-col items-end gap-1">
                      {current || !st?.last
                        ? <DecisionBadge state={st?.last ? decisionOf(st.last.cognitive_action) : null} />
                        : (
                          <span title="El nodo no está en línea: no hay decisión vigente" className="flex flex-col items-end gap-0.5 opacity-60">
                            <DecisionBadge state={decisionOf(st.last.cognitive_action)} />
                            <span className="text-[10px] text-slate-500">Última decisión ({ago(link.lastSeenMs, now)})</span>
                          </span>
                        )}
                      {current && <AlarmOverrideBadge reading={st?.last} />}
                    </div>
                  )}
              </div>

              {/* Name */}
              <h3 className="font-semibold text-slate-100 text-sm mb-2 truncate">{room.name}</h3>
              <div className="flex flex-wrap items-center gap-1.5 mb-3">
                {!st?.loading && <NodeLinkBadge reading={st?.last ?? null} now={now} roomId={room.id} />}
                <OriginBadge reading={st?.last} compact />
              </div>

              {/* Stats */}
              <div className="space-y-1.5">
                <div className="flex items-center gap-2 text-xs text-slate-400">
                  <Users size={12} />
                  <span>Capacidad: <span className="text-slate-300 font-medium">{room.max_capacity}</span></span>
                </div>
                <div className="flex items-center gap-2 text-xs text-slate-400">
                  <Thermometer size={12} />
                  <span>
                    Objetivo: <span className="text-blue-300 font-medium">{room.target_temp}°C</span>
                    {st?.last?.temperature != null && (
                      <span className="ml-2 text-slate-500">
                        · Actual: <span className="text-slate-300">{st.last.temperature.toFixed(1)}°C</span>
                      </span>
                    )}
                  </span>
                </div>
                <div className="flex items-center gap-2 text-xs text-slate-400">
                  <Fan size={12} />
                  <span>
                    {current ? 'Ventilador' : 'Ventilador (último)'}:{' '}
                    <span className={`font-medium ${current ? 'text-slate-300' : 'text-slate-500'}`}>{fmtNum(fanPwmOf(st?.last, st?.last?.cognitive_action).value, ' %', 0)}</span>
                  </span>
                </div>
              </div>

              {/* Footer */}
              <div className="mt-3 pt-3 border-t border-slate-700/50">
                <span className="text-xs text-slate-500" title="Topic MQTT previsto para el nodo del aula">Nodo <span className="font-mono">{mqttTopic(room.id)}</span> · Ver dashboard →</span>
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}
