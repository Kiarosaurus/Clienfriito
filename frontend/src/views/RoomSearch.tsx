import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Search, Building2, Users, Thermometer,
  RefreshCw, AlertCircle, Zap, ZapOff, HelpCircle,
} from 'lucide-react'
import api, { getApiErrorDetail } from '../api/client'
import { EmptyState } from '../components/EmptyState'

interface Room {
  id: number
  name: string
  max_capacity: number
  target_temp: number
}

interface RoomStatus {
  ac_status: string | null
  temperature: number | null
  loading: boolean
}

type StatusMap = Record<number, RoomStatus>

type AcStatus = 'ON' | 'STANDBY' | 'DISABLED' | null

function AcBadge({ status, loading }: { status: AcStatus; loading: boolean }) {
  if (loading) {
    return (
      <span className="flex items-center gap-1 text-xs text-slate-500">
        <RefreshCw size={10} className="animate-spin" /> …
      </span>
    )
  }
  if (status === 'ON') {
    return (
      <span className="flex items-center gap-1 text-xs font-semibold text-blue-300 bg-blue-900/40 border border-blue-500/30 px-2 py-0.5 rounded-full">
        <Zap size={10} /> Encendido
      </span>
    )
  }
  if (status === 'STANDBY') {
    return (
      <span className="flex items-center gap-1 text-xs text-slate-400 bg-slate-700/60 border border-slate-600 px-2 py-0.5 rounded-full">
        <ZapOff size={10} /> En espera
      </span>
    )
  }
  if (status === 'DISABLED') {
    return (
      <span className="flex items-center gap-1 text-xs text-amber-400 bg-amber-900/30 border border-amber-500/30 px-2 py-0.5 rounded-full">
        <ZapOff size={10} /> Deshabilitado
      </span>
    )
  }
  return (
    <span className="flex items-center gap-1 text-xs text-slate-600 px-2 py-0.5 rounded-full">
      <HelpCircle size={10} /> Sin datos
    </span>
  )
}

export default function RoomSearch() {
  const navigate = useNavigate()
  const [rooms, setRooms] = useState<Room[]>([])
  const [statuses, setStatuses] = useState<StatusMap>({})
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api.get<Room[]>('/admin/rooms')
      .then(res => {
        const data = res.data
        setRooms(data)

        // Seed loading placeholders
        const initial: StatusMap = {}
        data.forEach(r => { initial[r.id] = { ac_status: null, temperature: null, loading: true } })
        setStatuses(initial)

        // Fetch last reading per room in parallel (non-blocking)
        data.forEach(room => {
          api.get<{ cognitive_action?: { ac_status?: string }; temperature?: number }[]>(
            `/sensors/?room_id=${room.id}&limit=1`
          )
            .then(res => {
              const last = res.data?.[0]
              setStatuses(prev => ({
                ...prev,
                [room.id]: {
                  ac_status: (last?.cognitive_action?.ac_status ?? null) as AcStatus,
                  temperature: last?.temperature ?? null,
                  loading: false,
                },
              }))
            })
            .catch(() => {
              setStatuses(prev => ({
                ...prev,
                [room.id]: { ac_status: null, temperature: null, loading: false },
              }))
            })
        })
      })
      .catch(err => {
        setError(getApiErrorDetail(err) ?? 'No se pudo cargar la lista de aulas.')
      })
      .finally(() => setLoading(false))
  }, [])

  const filtered = rooms.filter(r =>
    r.name.toLowerCase().includes(query.toLowerCase())
  )

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Building2 size={22} className="text-blue-400" />
        <div>
          <h1 className="text-xl font-bold text-white">Aulas</h1>
          <p className="text-sm text-slate-400">Selecciona un aula para ver su dashboard cognitivo</p>
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
                <AcBadge
                  status={st?.ac_status as AcStatus ?? null}
                  loading={st?.loading ?? false}
                />
              </div>

              {/* Name */}
              <h3 className="font-semibold text-slate-100 text-sm mb-3 truncate">{room.name}</h3>

              {/* Stats */}
              <div className="space-y-1.5">
                <div className="flex items-center gap-2 text-xs text-slate-400">
                  <Users size={12} />
                  <span>Capacidad: <span className="text-slate-300 font-medium">{room.max_capacity}</span></span>
                </div>
                <div className="flex items-center gap-2 text-xs text-slate-400">
                  <Thermometer size={12} />
                  <span>
                    Target: <span className="text-blue-300 font-medium">{room.target_temp}°C</span>
                    {st?.temperature != null && (
                      <span className="ml-2 text-slate-500">
                        · Actual: <span className={st.temperature > 40 ? 'text-red-400' : 'text-slate-300'}>{st.temperature.toFixed(1)}°C</span>
                      </span>
                    )}
                  </span>
                </div>
              </div>

              {/* Footer */}
              <div className="mt-3 pt-3 border-t border-slate-700/50">
                <span className="text-xs text-slate-500">ID {room.id} · Ver dashboard →</span>
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}
