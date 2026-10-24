import { useState, useEffect, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { Search, RefreshCw, AlertCircle, CheckCircle, XCircle, Cpu, ChevronsUpDown, ChevronUp, ChevronDown } from 'lucide-react'
import api, { getApiErrorDetail } from '../api/client'
import { EmptyState } from '../components/EmptyState'
import { Pagination, usePage } from '../components/ui'

interface SensorDevice {
  sensor_id: string
  room_id: number
  room_name?: string
  is_active: boolean
  control_enabled: boolean
}

type SortKey = 'sensor_id' | 'room_name' | 'is_active' | 'control_enabled'

export default function SensorSearch() {
  const navigate = useNavigate()
  const [sensors, setSensors] = useState<SensorDevice[]>([])
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sortKey, setSortKey] = useState<SortKey>('sensor_id')
  const [sortAsc, setSortAsc] = useState(true)

  function fetchSensors(silent = false) {
    if (!silent) setLoading(true)
    else setRefreshing(true)
    setError(null)
    api.get<SensorDevice[]>('/admin/devices')
      .then(res => setSensors(res.data))
      .catch(err => setError(getApiErrorDetail(err) ?? 'Error cargando sensores.'))
      .finally(() => { setLoading(false); setRefreshing(false) })
  }

  useEffect(() => { fetchSensors() }, [])

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortAsc(a => !a)
    else { setSortKey(key); setSortAsc(true) }
  }

  const filtered = useMemo(() => {
    const q = query.toLowerCase()
    const list = sensors.filter(s =>
      s.sensor_id.toLowerCase().includes(q) ||
      (s.room_name ?? `ID ${s.room_id}`).toLowerCase().includes(q)
    )
    return [...list].sort((a, b) => {
      let va: string | boolean = a[sortKey] ?? ''
      let vb: string | boolean = b[sortKey] ?? ''
      if (typeof va === 'boolean') va = String(va)
      if (typeof vb === 'boolean') vb = String(vb)
      return sortAsc ? (va as string).localeCompare(vb as string) : (vb as string).localeCompare(va as string)
    })
  }, [sensors, query, sortKey, sortAsc])
  const page = usePage(filtered, 25)

  const activeCount = sensors.filter(s => s.is_active).length
  const controlCount = sensors.filter(s => s.control_enabled).length

  function SortIndicator({ col }: { col: SortKey }) {
    if (sortKey !== col) return <ChevronsUpDown size={12} className="ml-1 inline text-slate-600" />
    return sortAsc
      ? <ChevronUp size={12} className="ml-1 inline text-slate-200" />
      : <ChevronDown size={12} className="ml-1 inline text-slate-200" />
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <div>
            <h1 className="page-title">Sensores</h1>
            <p className="mt-1 text-xs text-slate-400">Dispositivos registrados en el sistema</p>
          </div>
        </div>
        <button
          onClick={() => fetchSensors(true)}
          disabled={loading || refreshing}
          className="btn btn-secondary"
        >
          <RefreshCw size={13} className={refreshing ? 'animate-spin' : ''} /> Actualizar
        </button>
      </div>

      {/* Stats row */}
      {!loading && sensors.length > 0 && (
        <div className="flex flex-wrap gap-3 sm:gap-4">
          <div className="surface px-4 py-2 text-sm">
            <span className="text-slate-400">Total </span>
            <span className="font-semibold text-slate-100">{sensors.length}</span>
          </div>
          <div className="surface px-4 py-2 text-sm">
            <span className="text-slate-400">Activos </span>
            <span className="font-semibold text-slate-100">{activeCount}</span>
          </div>
          <div className="surface px-4 py-2 text-sm">
            <span className="text-slate-400">Control habilitado </span>
            <span className="font-semibold text-slate-100">{controlCount}</span>
          </div>
        </div>
      )}

      {/* Search */}
      <div className="relative max-w-sm">
        <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
        <input
          type="text"
          placeholder="Filtrar por sensor ID o aula…"
          value={query}
          onChange={e => setQuery(e.target.value)}
          className="field pl-9 pr-4"
        />
      </div>

      {/* Loading */}
      {loading && (
        <div className="flex items-center gap-2 text-slate-400 text-sm py-4">
          <RefreshCw size={14} className="animate-spin" /> Cargando sensores…
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="flex items-center gap-2 bg-red-900/30 border border-red-500/40 rounded-lg px-4 py-3 text-sm text-red-300">
          <AlertCircle size={16} className="shrink-0" /> {error}
        </div>
      )}

      {/* Table */}
      {!loading && !error && (
        <div className="surface overflow-x-auto">
          <table className="w-full min-w-[560px] text-sm">
            <thead>
              <tr className="table-head">
                {(
                  [
                    ['sensor_id', 'Sensor ID'],
                    ['room_name', 'Aula Asignada'],
                    ['is_active', 'Estado'],
                    ['control_enabled', 'Control AC'],
                  ] as [SortKey, string][]
                ).map(([key, label]) => (
                  <th
                    key={key}
                    className="text-left px-4 py-3 cursor-pointer select-none hover:text-slate-200 transition-colors"
                    onClick={() => toggleSort(key)}
                  >
                    {label}<SortIndicator col={key} />
                  </th>
                ))}
                <th className="px-4 py-3 text-right">En vivo</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4">
                    {query ? (
                      <EmptyState
                        icon={<Search size={22} />}
                        title="Sin resultados"
                        hint={`Ningún sensor coincide con "${query}".`}
                        action={{ label: 'Limpiar búsqueda', onClick: () => setQuery('') }}
                      />
                    ) : (
                      <EmptyState
                        icon={<Cpu size={22} />}
                        title="Aún no hay sensores"
                        hint="Registra tu primer sensor para empezar a recibir telemetría."
                        action={{ label: 'Registrar un sensor', onClick: () => navigate('/infrastructure') }}
                      />
                    )}
                  </td>
                </tr>
              ) : (
                page.rows.map(s => (
                  <tr
                    key={s.sensor_id}
                    className="border-b border-slate-700/50 hover:bg-slate-700/30 transition-colors"
                  >
                    {/* Sensor ID */}
                    <td className="px-4 py-3">
                      <span className="font-mono text-slate-200 text-xs bg-slate-700 px-2 py-0.5 rounded">
                        {s.sensor_id}
                      </span>
                    </td>

                    {/* Aula */}
                    <td className="px-4 py-3 text-slate-300">
                      {s.room_name ?? <span className="text-slate-500 italic">Aula ID {s.room_id}</span>}
                    </td>

                    {/* Estado */}
                    <td className="px-4 py-3">
                      {s.is_active ? (
                        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-400 bg-emerald-900/30 border border-emerald-500/30 px-2.5 py-1 rounded-full">
                          <CheckCircle size={12} /> Activo
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-400 bg-slate-700/60 border border-slate-600 px-2.5 py-1 rounded-full">
                          <XCircle size={12} /> Inactivo
                        </span>
                      )}
                    </td>

                    {/* Control AC */}
                    <td className="px-4 py-3">
                      {s.control_enabled ? (
                        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-blue-300 bg-blue-900/30 border border-blue-500/30 px-2.5 py-1 rounded-full">
                          Habilitado
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1.5 text-xs text-slate-500 bg-slate-700 border border-slate-600 px-2.5 py-1 rounded-full">
                          Deshabilitado
                        </span>
                      )}
                    </td>

                    {/* Live pulse */}
                    <td className="px-4 py-3 text-right">
                      <span className="inline-flex items-center justify-end gap-1.5">
                        <span
                          className={`w-2 h-2 rounded-full ${
                            s.is_active ? 'bg-emerald-400 animate-pulse' : 'bg-slate-600'
                          }`}
                        />
                      </span>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>

          {/* Table footer */}
          <div className="border-t border-slate-800 px-4 pb-3">
            <Pagination {...page} noun={`sensores${filtered.length !== sensors.length ? ` (de ${sensors.length})` : ''}`} />
          </div>
        </div>
      )}
    </div>
  )
}
