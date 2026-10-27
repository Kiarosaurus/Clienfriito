import { useState, useEffect, useMemo, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { Search, RefreshCw, AlertCircle, CheckCircle, XCircle, Cpu } from 'lucide-react'
import api, { getApiErrorDetail } from '../api/client'
import { EmptyState } from '../components/EmptyState'
import type { StoredReading } from '../types'
import { nodeOnline, ago, fmtNum, mqttTopic, parseUtcMs } from '../utils/node'
import { NodeLinkBadge, OriginBadge, lwtFor } from '../components/NodeWidgets'
import { useHealth, useNow, updatedAgo, ingestLabel } from '../utils/live'

const NODES_POLL_MS = 15_000

// Cada sensor_id registrado es un NODO ESP32 con varios sensores y actuadores a bordo
// (docs/hardware-spec.md). El identificador no cambia; solo la presentación.
// Los chips se DERIVAN de la última telemetría: un componente que nunca reportó
// su campo aparece atenuado ("no reportado"); no se presenta hardware sin evidencia.
type Probe = (r: StoredReading) => boolean
const ONBOARD_SENSORS: { name: string; what: string; reported: Probe }[] = [
  { name: 'DHT11', what: 'temperatura y humedad (GPIO)', reported: r => r.temperature != null && r.humidity != null },
  { name: 'MQ-135', what: 'CO₂ relativo (ADC1)', reported: r => r.co2_ppm != null },
  { name: 'MQ-7', what: 'CO (ADC1)', reported: r => r.co_ppm != null },
  { name: 'INA219', what: 'potencia de la rama del actuador (I2C 0x40)', reported: r => r.power_w != null || r.current_ma != null },
]
const ONBOARD_ACTUATORS: { name: string; what: string; reported: Probe }[] = [
  { name: 'Ventilador PWM', what: 'ventilador DC 12 V vía MOSFET', reported: r => r.fan_pwm != null },
  { name: 'Buzzer + LED', what: 'alarma local: CO > 50 ppm, se dispara en el nodo aun sin red', reported: r => r.alarm_active != null },
  { name: 'PTC', what: 'calefactor 12 V (montaje por confirmar)', reported: r => r.heater_on != null },
]

function Chip({ label, title, tone, reported }: { label: string; title: string; tone: 'sensor' | 'act'; reported: boolean }) {
  const on = tone === 'sensor' ? 'text-cyan-300 bg-cyan-500/10 border-cyan-500/30' : 'text-violet-300 bg-violet-500/10 border-violet-500/30'
  return (
    <span
      title={reported ? `${title} · reportado en la última telemetría` : `${title} · no reportado en la última telemetría`}
      className={`text-[10px] font-medium rounded px-1.5 py-0.5 border whitespace-nowrap ${
        reported ? on : 'text-slate-500 bg-transparent border-slate-700 border-dashed line-through decoration-slate-600'
      }`}
    >{label}</span>
  )
}

interface SensorDevice {
  sensor_id: string
  room_id: string
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
  const [lastBy, setLastBy] = useState<Record<string, StoredReading | null>>({})
  const [lastUpdated, setLastUpdated] = useState<number | null>(null)
  const now = useNow(5_000)
  const { data: health } = useHealth()

  const fetchSensors = useCallback((silent = false, isCancelled: () => boolean = () => false) => {
    if (!silent) setLoading(true)
    else setRefreshing(true)
    setError(null)
    api.get<SensorDevice[]>('/admin/devices')
      .then(res => {
        if (isCancelled()) return
        const list = res.data ?? []
        setSensors(list)
        // Último mensaje de cada nodo (para estado del enlace, RSSI y último visto).
        list.forEach(d => {
          api.get<StoredReading[]>(`/sensors/?sensor_id=${encodeURIComponent(d.sensor_id)}&limit=1`)
            .then(r => {
              if (isCancelled()) return
              const last = (r.data ?? []).find(x => parseUtcMs(x.timestamp) != null) ?? null
              setLastBy(prev => ({ ...prev, [d.sensor_id]: last }))
              setLastUpdated(Date.now())
            })
            .catch(() => { if (!isCancelled()) setLastBy(prev => ({ ...prev, [d.sensor_id]: prev[d.sensor_id] ?? null })) })
        })
      })
      .catch(err => { if (!isCancelled()) setError(getApiErrorDetail(err) ?? 'Error cargando nodos.') })
      .finally(() => { if (!isCancelled()) { setLoading(false); setRefreshing(false) } })
  }, [])

  // Carga inicial + refresco cada 15 s con limpieza al desmontar (FE-2-03).
  useEffect(() => {
    let cancelled = false
    const isCancelled = () => cancelled
    fetchSensors(false, isCancelled)
    const t = setInterval(() => fetchSensors(true, isCancelled), NODES_POLL_MS)
    return () => { cancelled = true; clearInterval(t) }
  }, [fetchSensors])

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

  const activeCount = sensors.filter(s => s.is_active).length
  const controlCount = sensors.filter(s => s.control_enabled).length
  const onlineCount = sensors.filter(s => nodeOnline(lastBy[s.sensor_id], now, { lwt: lwtFor(health, s.room_id) }).online === true).length

  function SortIndicator({ col }: { col: SortKey }) {
    if (sortKey !== col) return <span className="text-slate-600 ml-1">↕</span>
    return <span className="text-blue-400 ml-1">{sortAsc ? '↑' : '↓'}</span>
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <Cpu size={22} className="text-blue-400" />
          <div>
            <h1 className="text-xl font-bold text-white">Nodos ESP32</h1>
            <p className="text-sm text-slate-400">Nodos de sensado y actuación registrados · {ingestLabel(health)} · <span className="text-slate-500">{updatedAgo(lastUpdated, now)}</span></p>
          </div>
        </div>
        <button
          onClick={() => fetchSensors(true)}
          disabled={loading || refreshing}
          className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-slate-100 bg-slate-700 hover:bg-slate-600 disabled:opacity-50 px-3 py-1.5 rounded-lg transition-colors"
        >
          <RefreshCw size={13} className={refreshing ? 'animate-spin' : ''} /> Actualizar
        </button>
      </div>

      {/* Stats row */}
      {!loading && sensors.length > 0 && (
        <div className="flex flex-wrap gap-3 sm:gap-4">
          <div className="bg-slate-800 border border-slate-700 rounded-lg px-4 py-2 text-sm">
            <span className="text-slate-400">Total </span>
            <span className="font-bold text-slate-100">{sensors.length}</span>
          </div>
          <div className="bg-slate-800 border border-emerald-700/40 rounded-lg px-4 py-2 text-sm">
            <span className="text-slate-400">Activos </span>
            <span className="font-bold text-emerald-400">{activeCount}</span>
          </div>
          <div className="bg-slate-800 border border-blue-700/40 rounded-lg px-4 py-2 text-sm">
            <span className="text-slate-400">Control de actuadores </span>
            <span className="font-bold text-blue-400">{controlCount}</span>
          </div>
          <div className="bg-slate-800 border border-emerald-700/40 rounded-lg px-4 py-2 text-sm">
            <span className="text-slate-400">En línea </span>
            <span className="font-bold text-emerald-400">{onlineCount}</span>
          </div>
        </div>
      )}

      {/* Search */}
      <div className="relative max-w-sm">
        <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
        <input
          type="text"
          placeholder="Filtrar por ID de nodo o aula…"
          value={query}
          onChange={e => setQuery(e.target.value)}
          className="w-full bg-slate-800 border border-slate-700 rounded-lg pl-9 pr-4 py-2.5 text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500/50 transition"
        />
      </div>

      {/* Loading */}
      {loading && (
        <div className="flex items-center gap-2 text-slate-400 text-sm py-4">
          <RefreshCw size={14} className="animate-spin" /> Cargando nodos…
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
        <div className="bg-slate-800 rounded-xl overflow-x-auto border border-slate-700">
          <table className="w-full min-w-[1080px] text-sm">
            <thead>
              <tr className="text-slate-400 text-xs uppercase border-b border-slate-700 bg-slate-800/80">
                {(
                  [
                    ['sensor_id', 'Nodo ESP32'],
                    ['room_name', 'Aula asignada'],
                    ['is_active', 'Recepción'],
                    ['control_enabled', 'Control de actuadores'],
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
                <th className="px-4 py-3 text-left" title="Derivado de la última telemetría; atenuado = no reportado">Sensores reportados</th>
                <th className="px-4 py-3 text-left" title="Derivado de la última telemetría; atenuado = no reportado">Actuadores reportados</th>
                <th className="px-4 py-3 text-left">Enlace</th>
                <th className="px-4 py-3 text-left">RSSI</th>
                <th className="px-4 py-3 text-right">Último visto</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={9} className="px-4">
                    {query ? (
                      <EmptyState
                        icon={<Search size={22} />}
                        title="Sin resultados"
                        hint={`Ningún nodo coincide con "${query}".`}
                        action={{ label: 'Limpiar búsqueda', onClick: () => setQuery('') }}
                      />
                    ) : (
                      <EmptyState
                        icon={<Cpu size={22} />}
                        title="Aún no hay nodos"
                        hint="Registra tu primer nodo ESP32 para empezar a recibir su telemetría."
                        action={{ label: 'Registrar un nodo', onClick: () => navigate('/infrastructure') }}
                      />
                    )}
                  </td>
                </tr>
              ) : (
                filtered.map(s => (
                  <tr
                    key={s.sensor_id}
                    className="border-b border-slate-700/50 hover:bg-slate-700/30 transition-colors"
                  >
                    {/* Sensor ID */}
                    <td className="px-4 py-3">
                      <span className="font-mono text-slate-200 text-xs bg-slate-700 px-2 py-0.5 rounded">
                        {s.sensor_id}
                      </span>
                      <p className="text-[10px] font-mono text-slate-500 mt-1">{mqttTopic(s.room_id)}</p>
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

                    {/* Control de actuadores */}
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

                    {/* Inventario a bordo */}
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-1 max-w-[220px]">
                        {ONBOARD_SENSORS.map(x => {
                          const last = lastBy[s.sensor_id]
                          return <Chip key={x.name} label={x.name} title={x.what} tone="sensor" reported={!!last && x.reported(last)} />
                        })}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-1 max-w-[200px]">
                        {ONBOARD_ACTUATORS.map(x => {
                          const last = lastBy[s.sensor_id]
                          return <Chip key={x.name} label={x.name} title={x.what} tone="act" reported={!!last && x.reported(last)} />
                        })}
                      </div>
                    </td>
                    {/* Enlace */}
                    <td className="px-4 py-3">
                      <div className="flex flex-col items-start gap-1">
                        <NodeLinkBadge reading={lastBy[s.sensor_id] ?? null} now={now} roomId={s.room_id} />
                        <OriginBadge reading={lastBy[s.sensor_id]} compact />
                      </div>
                    </td>
                    <td className="px-4 py-3 text-xs text-slate-300 tabular-nums">{fmtNum(lastBy[s.sensor_id]?.rssi_dbm, ' dBm', 0)}</td>
                    <td className="px-4 py-3 text-right text-xs text-slate-400">
                      {lastBy[s.sensor_id] === undefined ? '…' : ago(parseUtcMs(lastBy[s.sensor_id]?.timestamp), now)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>

          {/* Table footer */}
          {filtered.length > 0 && (
            <div className="px-4 py-2 border-t border-slate-700/50 text-xs text-slate-500 text-right">
              {filtered.length} de {sensors.length} nodo{sensors.length !== 1 ? 's' : ''}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
