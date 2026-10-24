import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Plus, Pencil, RefreshCw, AlertTriangle, Search } from 'lucide-react'
import api, { getApiErrorDetail } from '../api/client'
import type { StoredReading } from '../types'
import { NUM_INPUT_MODS } from '../utils/formStyles'
import { compareRooms, locationLabel, roomOptions, shortName, type Room } from '../utils/rooms'
import { RoomFilters, useRoomFilter } from '../components/RoomFilters'
import SearchableSelect from '../components/SearchableSelect'
import {
  Card, Chip, Dialog, PageHeader, Pagination, Tabs, Toast, LIVE_SECONDS,
  parseUtc, timeAgo, usePage, useToast,
} from '../components/ui'

// Physical configuration: rooms and their sensors (one page, one question: "what is
// installed and where?"). Registering a room + its sensor s-<room> is what lets a new
// node join without code changes (RNF-28/29). Live device switches stay in the room view,
// where a collaborator with an active reservation may use them (RF-37).

interface Device { sensor_id: string; room_id: string | null; room_name: string | null; is_active: boolean; control_enabled: boolean }
interface Latest { sensor_id?: string | null; room_id?: string | null; reading: StoredReading | null }
type View = 'aulas' | 'sensores'

interface RoomForm { id: string; name: string; building: string; floor: string; max_capacity: string; target_temp: string }
const EMPTY_ROOM: RoomForm = { id: '', name: '', building: '', floor: '', max_capacity: '30', target_temp: '24' }

function friendly(err: unknown, fallback: string) {
  const status = (err as { response?: { status?: number } })?.response?.status
  if (status === 409) return 'Ya existe un aula o sensor con ese código o nombre.'
  if (status === 403) return 'Tu rol no puede modificar la infraestructura.'
  return getApiErrorDetail(err) ?? fallback
}

function LastReading({ reading, now }: { reading: StoredReading | null | undefined; now: number }) {
  if (!reading) return <span className="text-xs text-slate-500">Nunca</span>
  const live = (now - parseUtc(reading.timestamp).getTime()) / 1000 < LIVE_SECONDS
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-slate-400">
      {live && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />}
      {live ? 'En vivo' : timeAgo(reading.timestamp, now)}
    </span>
  )
}

export default function Infrastructure() {
  const [params, setParams] = useSearchParams()
  const view = (params.get('vista') as View) || 'aulas'
  const setView = (v: View) => setParams(v === 'aulas' ? {} : { vista: v }, { replace: true })

  const [rooms, setRooms] = useState<Room[]>([])
  const [devices, setDevices] = useState<Device[]>([])
  const [latestRoom, setLatestRoom] = useState<Record<string, StoredReading | null>>({})
  const [latestSensor, setLatestSensor] = useState<Record<string, StoredReading | null>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [now, setNow] = useState(Date.now())
  const { toast, notify, clear } = useToast()

  const [roomDialog, setRoomDialog] = useState<{ original: Room | null } | null>(null)
  const [roomToDelete, setRoomToDelete] = useState<Room | null>(null)
  const [sensorDialog, setSensorDialog] = useState<{ original: Device | null } | null>(null)
  const [sensorToDelete, setSensorToDelete] = useState<Device | null>(null)

  const load = useCallback(() => Promise.all([
    api.get<Room[]>('/admin/rooms'),
    api.get<Device[]>('/admin/devices'),
    api.get<Latest[]>('/sensors/latest').catch(() => ({ data: [] as Latest[] })),
    api.get<Latest[]>('/sensors/latest?by=sensor').catch(() => ({ data: [] as Latest[] })),
  ])
    .then(([r, d, lr, ls]) => {
      setRooms(r.data ?? [])
      setDevices(d.data ?? [])
      setLatestRoom(Object.fromEntries((lr.data ?? []).map(x => [x.room_id ?? '', x.reading])))
      setLatestSensor(Object.fromEntries((ls.data ?? []).map(x => [x.sensor_id ?? '', x.reading])))
      setNow(Date.now())
      setError(null)
    })
    .catch(err => setError(getApiErrorDetail(err) ?? 'No se pudo cargar la infraestructura.'))
    .finally(() => setLoading(false)), [])

  useEffect(() => { load() }, [load])

  const roomById = useMemo(() => Object.fromEntries(rooms.map(r => [r.id, r])), [rooms])

  return (
    <div className="space-y-4">
      <PageHeader title="Infraestructura" subtitle="Aulas y sensores instalados. Para sumar un nodo nuevo, registra su aula y su sensor.">
        {view === 'aulas'
          ? <button className="btn btn-primary" onClick={() => setRoomDialog({ original: null })}><Plus size={16} /> Nueva aula</button>
          : <button className="btn btn-primary" onClick={() => setSensorDialog({ original: null })} disabled={rooms.length === 0}><Plus size={16} /> Nuevo sensor</button>}
      </PageHeader>

      {error && <Card className="border-red-500/40 text-sm text-red-300">{error}</Card>}

      <Tabs<View>
        value={view}
        onChange={setView}
        items={[
          { value: 'aulas', label: `Aulas · ${rooms.length}` },
          { value: 'sensores', label: `Sensores · ${devices.length}` },
        ]}
      />

      {loading ? (
        <p className="flex items-center gap-2 py-8 text-sm text-slate-400"><RefreshCw size={14} className="animate-spin" /> Cargando…</p>
      ) : view === 'aulas' ? (
        <RoomsTab rooms={rooms} devices={devices} latest={latestRoom} now={now} onEdit={r => setRoomDialog({ original: r })} />
      ) : (
        <SensorsTab devices={devices} rooms={roomById} latest={latestSensor} now={now} onEdit={d => setSensorDialog({ original: d })} />
      )}

      {roomDialog && (
        <RoomDialog
          original={roomDialog.original}
          onClose={() => setRoomDialog(null)}
          onDelete={r => { setRoomDialog(null); setRoomToDelete(r) }}
          onSaved={msg => { setRoomDialog(null); notify('ok', msg); load() }}
        />
      )}
      {roomToDelete && (
        <DeleteRoomDialog
          room={roomToDelete}
          onClose={() => setRoomToDelete(null)}
          onDeleted={() => { notify('ok', `Aula ${roomToDelete.id} eliminada.`); setRoomToDelete(null); load() }}
          onError={msg => notify('error', msg)}
        />
      )}
      {sensorDialog && (
        <SensorDialog
          original={sensorDialog.original}
          rooms={rooms}
          devices={devices}
          onClose={() => setSensorDialog(null)}
          onDelete={d => { setSensorDialog(null); setSensorToDelete(d) }}
          onSaved={msg => { setSensorDialog(null); notify('ok', msg); load() }}
        />
      )}
      {sensorToDelete && (
        <DeleteSensorDialog
          device={sensorToDelete}
          onClose={() => setSensorToDelete(null)}
          onDeleted={() => { notify('ok', `Sensor ${sensorToDelete.sensor_id} eliminado.`); setSensorToDelete(null); load() }}
          onError={msg => notify('error', msg)}
        />
      )}
      <Toast toast={toast} onClose={clear} />
    </div>
  )
}

// ── Aulas ─────────────────────────────────────────────────────────────────────
function RoomsTab({ rooms, devices, latest, now, onEdit }: {
  rooms: Room[]; devices: Device[]; latest: Record<string, StoredReading | null>; now: number; onEdit: (r: Room) => void
}) {
  const filter = useRoomFilter(rooms)
  const sorted = [...filter.filtered].sort(compareRooms)
  const page = usePage(sorted, 15)
  const sensorsOf = (id: string) => devices.filter(d => d.room_id === id)

  return (
    <Card>
      <div className="mb-3">
        <RoomFilters rooms={rooms} state={filter.state} onChange={filter.setState}>
          <span className="ml-auto text-xs text-slate-400">{sorted.length} de {rooms.length} aulas</span>
        </RoomFilters>
      </div>
      {sorted.length === 0 ? (
        <p className="py-4 text-sm text-slate-400">{rooms.length ? 'Ningún aula coincide con los filtros.' : 'Todavía no hay aulas. Crea la primera con "Nueva aula".'}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <thead>
              <tr className="table-head">
                {['Aula', 'Ubicación', 'Capacidad', 'Temp. objetivo', 'Sensores', 'Última lectura', ''].map(h => <th key={h} className="py-2 pr-4 font-normal">{h}</th>)}
              </tr>
            </thead>
            <tbody>
              {page.rows.map(r => {
                const sensors = sensorsOf(r.id)
                return (
                  <tr key={r.id} className="table-row cursor-pointer" onClick={() => onEdit(r)}>
                    <td className="py-2 pr-4">
                      <Link to={`/room/${r.id}`} onClick={e => e.stopPropagation()} className="font-medium text-slate-100 hover:underline">{r.id}</Link>
                      <span className="ml-2 text-slate-400">{shortName(r)}</span>
                    </td>
                    <td className="py-2 pr-4 text-slate-300">{locationLabel(r)}</td>
                    <td className="py-2 pr-4 tabular-nums text-slate-300">{r.max_capacity} personas</td>
                    <td className="py-2 pr-4 tabular-nums text-slate-300">{r.target_temp} °C</td>
                    <td className="py-2 pr-4">
                      {sensors.length ? <span className="text-xs text-slate-400">{sensors.map(s => s.sensor_id).join(', ')}</span> : <Chip tone="warn">Sin sensor</Chip>}
                    </td>
                    <td className="py-2 pr-4"><LastReading reading={latest[r.id]} now={now} /></td>
                    <td className="py-2 text-right">
                      <button className="btn btn-ghost py-1" onClick={e => { e.stopPropagation(); onEdit(r) }}><Pencil size={13} /> Editar</button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      <Pagination {...page} noun="aulas" />
    </Card>
  )
}

function RoomDialog({ original, onClose, onDelete, onSaved }: {
  original: Room | null
  onClose: () => void
  onDelete: (r: Room) => void
  onSaved: (msg: string) => void
}) {
  const [f, setF] = useState<RoomForm>(() => original ? {
    id: original.id, name: original.name, building: original.building ?? '', floor: original.floor == null ? '' : String(original.floor),
    max_capacity: String(original.max_capacity), target_temp: String(original.target_temp),
  } : EMPTY_ROOM)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  // Rename: how many records move with the room. New room: history left by a deleted room with this code.
  const [moving, setMoving] = useState<{ reservations_count: number; sensors_count: number } | null>(null)
  const [orphans, setOrphans] = useState<{ reservations_count: number; sensors_count: number } | null>(null)
  const [inheritOk, setInheritOk] = useState(false)

  const code = f.id.trim()
  const renaming = !!original && code !== '' && code !== original.id

  useEffect(() => {
    if (!renaming || !original) { setMoving(null); return }
    api.get(`/admin/rooms/${encodeURIComponent(original.id)}/impact`).then(r => setMoving(r.data)).catch(() => setMoving(null))
  }, [renaming, original])

  useEffect(() => {
    setOrphans(null); setInheritOk(false)
    if (original || !code) return
    const t = setTimeout(() => {
      api.get(`/admin/rooms/check-orphans/${encodeURIComponent(code)}`)
        .then(r => setOrphans(r.data?.has_orphans ? r.data : null))
        .catch(() => setOrphans(null))
    }, 400)
    return () => clearTimeout(t)
  }, [code, original])

  const problems: string[] = []
  if (!code) problems.push('Indica el código del aula.')
  if (!f.name.trim()) problems.push('Indica el nombre.')
  if (!(Number(f.max_capacity) > 0)) problems.push('La capacidad debe ser mayor que 0.')
  const t = Number(f.target_temp)
  if (!(t >= 16 && t <= 30)) problems.push('La temperatura objetivo debe estar entre 16 y 30 °C.')
  if (orphans && !inheritOk) problems.push('Confirma que la nueva aula heredará el historial existente.')

  async function save() {
    if (problems.length) return
    setSaving(true); setErr(null)
    const body = {
      name: f.name.trim(),
      max_capacity: Number(f.max_capacity),
      target_temp: Number(f.target_temp),
      building: f.building.trim() || null,
      floor: f.floor === '' ? null : Number(f.floor),
    }
    try {
      if (original) {
        // Renaming always moves the room's reservations and sensors with it.
        await api.put(`/admin/rooms/${encodeURIComponent(original.id)}`, { ...body, new_id: renaming ? code : undefined },
          { params: { cascade_sensors: true, cascade_reservations: true } })
        onSaved(renaming ? `Aula ${original.id} ahora es ${code}.` : `Aula ${code} actualizada.`)
      } else {
        await api.post('/admin/rooms', { id: code, ...body })
        onSaved(`Aula ${code} creada. Registra su sensor en la pestaña Sensores.`)
      }
    } catch (e) {
      setErr(friendly(e, 'No se pudo guardar el aula.'))
    } finally { setSaving(false) }
  }

  const field = (key: keyof RoomForm, label: string, props: Record<string, unknown> = {}) => (
    <label className="block">
      <span className="field-label">{label}</span>
      <input className={`field ${props.type === 'number' ? NUM_INPUT_MODS : ''}`} value={f[key]} onChange={e => setF({ ...f, [key]: e.target.value })} {...props} />
    </label>
  )

  return (
    <Dialog
      title={original ? `Editar aula ${original.id}` : 'Nueva aula'}
      onClose={onClose}
      footer={<>
        {original && <button className="btn btn-ghost text-red-300 hover:text-red-200" onClick={() => onDelete(original)}>Eliminar aula</button>}
        <span className="flex-1" />
        <button className="btn btn-secondary" onClick={onClose}>Cancelar</button>
        <button className="btn btn-primary" onClick={save} disabled={saving || problems.length > 0}>
          {saving && <RefreshCw size={14} className="animate-spin" />} {original ? 'Guardar cambios' : 'Crear aula'}
        </button>
      </>}
    >
      <form className="grid grid-cols-2 gap-3" onSubmit={e => { e.preventDefault(); save() }}>
        {field('id', 'Código', { placeholder: 'ej. M601', maxLength: 20, autoFocus: !original })}
        {field('name', 'Nombre', { placeholder: 'ej. M601 Laboratorio' })}
        {field('building', 'Edificio', { placeholder: 'ej. M', maxLength: 10 })}
        {field('floor', 'Piso', { type: 'number', placeholder: 'ej. 6', min: -5, max: 99 })}
        {field('max_capacity', 'Capacidad (personas)', { type: 'number', min: 1 })}
        {field('target_temp', 'Temperatura objetivo (°C)', { type: 'number', min: 16, max: 30, step: 0.5 })}
        <button type="submit" className="hidden" />
      </form>
      <p className="mt-2 text-xs text-slate-500">
        La IA decide con la temperatura objetivo. El nodo de A403 trabaja con 24 °C; usa el mismo valor para que la comparación Nodo vs IA sea justa.
      </p>

      {renaming && moving && (
        <p className="mt-3 flex items-start gap-2 text-xs text-amber-300">
          <AlertTriangle size={14} className="mt-px shrink-0" />
          Se moverán {moving.reservations_count} reservas y {moving.sensors_count} {moving.sensors_count === 1 ? 'sensor' : 'sensores'} de {original!.id} a {code}.
        </p>
      )}
      {orphans && (
        <label className="mt-3 flex items-start gap-2 text-xs text-amber-300">
          <input type="checkbox" className="mt-0.5 accent-amber-500" checked={inheritOk} onChange={e => setInheritOk(e.target.checked)} />
          <span>
            Existió antes un aula {code}: quedan {orphans.reservations_count} reservas y {orphans.sensors_count} sensores con ese código.
            La nueva aula los heredará. Marca para confirmar.
          </span>
        </label>
      )}
      {err && <p className="mt-3 text-xs text-red-300">{err}</p>}
      {problems.length > 0 && !(orphans && !inheritOk && problems.length === 1) && (
        <p className="mt-3 text-xs text-slate-500">{problems[0]}</p>
      )}
    </Dialog>
  )
}

function DeleteRoomDialog({ room, onClose, onDeleted, onError }: {
  room: Room; onClose: () => void; onDeleted: () => void; onError: (msg: string) => void
}) {
  const [impact, setImpact] = useState<{ reservations_count: number; sensors_count: number } | null>(null)
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    api.get(`/admin/rooms/${encodeURIComponent(room.id)}/impact`).then(r => setImpact(r.data)).catch(() => setImpact({ reservations_count: 0, sensors_count: 0 }))
  }, [room.id])

  async function remove() {
    setBusy(true)
    try { await api.delete(`/admin/rooms/${encodeURIComponent(room.id)}`); onDeleted() }
    catch (e) { onError(friendly(e, 'No se pudo eliminar el aula.')); onClose() }
    finally { setBusy(false) }
  }

  return (
    <Dialog
      size="sm"
      title={`¿Eliminar el aula ${room.id}?`}
      onClose={onClose}
      footer={<>
        <span className="flex-1" />
        <button className="btn btn-secondary" onClick={onClose}>Cancelar</button>
        <button className="btn btn-danger" onClick={remove} disabled={busy || typed.trim() !== room.id}>
          {busy && <RefreshCw size={14} className="animate-spin" />} Eliminar
        </button>
      </>}
    >
      {!impact ? <p className="text-sm text-slate-400">Calculando impacto…</p> : (
        <p className="text-sm text-slate-300">
          {impact.reservations_count || impact.sensors_count
            ? <>Sus {impact.reservations_count} reservas y {impact.sensors_count} {impact.sensors_count === 1 ? 'sensor' : 'sensores'} se conservan como historial, pero quedarán sin aula. Sus horarios semanales se eliminan.</>
            : 'El aula no tiene reservas ni sensores. Sus horarios semanales se eliminan.'}
        </p>
      )}
      <label className="mt-3 block">
        <span className="field-label">Escribe {room.id} para confirmar</span>
        <input className="field font-mono" value={typed} onChange={e => setTyped(e.target.value)} placeholder={room.id} autoFocus />
      </label>
    </Dialog>
  )
}

// ── Sensores ──────────────────────────────────────────────────────────────────
type SensorFilter = 'all' | 'unassigned' | 'off' | 'silent'
const STALE_MIN = 15

function SensorsTab({ devices, rooms, latest, now, onEdit }: {
  devices: Device[]; rooms: Record<string, Room>; latest: Record<string, StoredReading | null>; now: number; onEdit: (d: Device) => void
}) {
  const [query, setQuery] = useState('')
  const [show, setShow] = useState<SensorFilter>('all')
  const silent = (d: Device) => {
    const r = latest[d.sensor_id]
    return !r || (now - parseUtc(r.timestamp).getTime()) / 60_000 > STALE_MIN
  }
  const q = query.trim().toLowerCase()
  const list = devices
    .filter(d => !q || d.sensor_id.toLowerCase().includes(q) || (d.room_id ?? '').toLowerCase().includes(q) || (d.room_name ?? '').toLowerCase().includes(q))
    .filter(d => show === 'all' || (show === 'unassigned' && !d.room_id) || (show === 'off' && !d.is_active) || (show === 'silent' && silent(d)))
    .sort((a, b) => {
      const ra = a.room_id ? rooms[a.room_id] : undefined, rb = b.room_id ? rooms[b.room_id] : undefined
      if (ra && rb) return compareRooms(ra, rb) || a.sensor_id.localeCompare(b.sensor_id)
      return ra ? -1 : rb ? 1 : a.sensor_id.localeCompare(b.sensor_id)
    })
  const page = usePage(list, 15)
  const counts = {
    unassigned: devices.filter(d => !d.room_id).length,
    off: devices.filter(d => !d.is_active).length,
    silent: devices.filter(silent).length,
  }

  return (
    <Card>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <label className="relative">
          <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500" />
          <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Sensor o aula…" className="field w-48 pl-8" aria-label="Buscar sensor" />
        </label>
        <div className="segmented">
          {([
            ['all', 'Todos'],
            ['silent', `Sin datos recientes · ${counts.silent}`],
            ['off', `Sin recibir datos · ${counts.off}`],
            ['unassigned', `Sin aula · ${counts.unassigned}`],
          ] as [SensorFilter, string][]).map(([k, label]) => (
            <button key={k} className={`segmented-item ${show === k ? 'segmented-item-active' : ''}`} onClick={() => setShow(k)}>{label}</button>
          ))}
        </div>
      </div>
      {list.length === 0 ? (
        <p className="py-4 text-sm text-slate-400">{devices.length ? 'Ningún sensor coincide.' : 'Todavía no hay sensores. Registra uno con "Nuevo sensor".'}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <thead>
              <tr className="table-head">
                {['Sensor', 'Aula', 'Recibe datos', 'Controla el aire', 'Última lectura', ''].map(h => <th key={h} className="py-2 pr-4 font-normal">{h}</th>)}
              </tr>
            </thead>
            <tbody>
              {page.rows.map(d => {
                const room = d.room_id ? rooms[d.room_id] : undefined
                return (
                  <tr key={d.sensor_id} className="table-row cursor-pointer" onClick={() => onEdit(d)}>
                    <td className="py-2 pr-4 font-mono text-xs text-slate-200">{d.sensor_id}</td>
                    <td className="py-2 pr-4">
                      {d.room_id
                        ? <><Link to={`/room/${d.room_id}`} onClick={e => e.stopPropagation()} className="font-medium text-slate-100 hover:underline">{d.room_id}</Link>
                            {room && <span className="ml-2 text-xs text-slate-400">{locationLabel(room)}</span>}</>
                        : <Chip tone="warn">Sin aula</Chip>}
                    </td>
                    <td className="py-2 pr-4">{d.is_active ? <Chip tone="ok">Sí</Chip> : <Chip>No</Chip>}</td>
                    <td className="py-2 pr-4">{d.control_enabled ? <Chip tone="ok">Sí</Chip> : <Chip>No</Chip>}</td>
                    <td className="py-2 pr-4"><LastReading reading={latest[d.sensor_id]} now={now} /></td>
                    <td className="py-2 text-right">
                      <button className="btn btn-ghost py-1" onClick={e => { e.stopPropagation(); onEdit(d) }}><Pencil size={13} /> Editar</button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      <Pagination {...page} noun="sensores" />
      <p className="mt-2 text-xs text-slate-500">
        "Recibe datos" y "Controla el aire" se cambian desde la vista de cada aula, en Configuración.
      </p>
    </Card>
  )
}

function SensorDialog({ original, rooms, devices, onClose, onDelete, onSaved }: {
  original: Device | null
  rooms: Room[]
  devices: Device[]
  onClose: () => void
  onDelete: (d: Device) => void
  onSaved: (msg: string) => void
}) {
  const [id, setId] = useState(original?.sensor_id ?? '')
  const [roomId, setRoomId] = useState(original?.room_id ?? '')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const options = useMemo(() => [
    ...(original ? [{ value: '__none__', label: 'Sin aula (desinstalado)', group: 'Sin asignar' }] : []),
    ...roomOptions(rooms),
  ], [rooms, original])

  const code = id.trim()
  const taken = devices.some(d => d.sensor_id === code && d.sensor_id !== original?.sensor_id)
  const problems: string[] = []
  if (!code) problems.push('Indica el código del sensor.')
  if (taken) problems.push('Ya existe un sensor con ese código.')
  if (!original && !roomId) problems.push('Elige el aula donde está instalado.')

  // Convention used by the node and MQTT ingest: sensor s-<room>.
  function pickRoom(v: string) {
    setRoomId(v)
    if (!original && v && (!id || /^s-/.test(id))) setId(`s-${v}`)
  }

  async function save() {
    if (problems.length) return
    setSaving(true); setErr(null)
    const target = roomId === '__none__' ? null : roomId || null
    try {
      if (original) {
        await api.put(`/admin/sensors/${encodeURIComponent(original.sensor_id)}`, {
          room_id: target,
          ...(code !== original.sensor_id ? { new_id: code } : {}),
        })
        onSaved(`Sensor ${code} actualizado.`)
      } else {
        await api.post('/admin/sensors', { id: code, room_id: target })
        onSaved(`Sensor ${code} registrado en ${target}. Actívalo desde la vista del aula cuando esté instalado.`)
      }
    } catch (e) {
      setErr(friendly(e, 'No se pudo guardar el sensor.'))
    } finally { setSaving(false) }
  }

  return (
    <Dialog
      title={original ? `Editar sensor ${original.sensor_id}` : 'Nuevo sensor'}
      onClose={onClose}
      footer={<>
        {original && <button className="btn btn-ghost text-red-300 hover:text-red-200" onClick={() => onDelete(original)}>Eliminar sensor</button>}
        <span className="flex-1" />
        <button className="btn btn-secondary" onClick={onClose}>Cancelar</button>
        <button className="btn btn-primary" onClick={save} disabled={saving || problems.length > 0}>
          {saving && <RefreshCw size={14} className="animate-spin" />} {original ? 'Guardar cambios' : 'Registrar sensor'}
        </button>
      </>}
    >
      <div className="space-y-3">
        <SearchableSelect label="Aula" options={options} value={roomId} onChange={pickRoom} placeholder="Busca el aula…" maxVisibleItems={6} />
        <label className="block">
          <span className="field-label">Código del sensor</span>
          <input className="field font-mono" value={id} onChange={e => setId(e.target.value)} placeholder="ej. s-M601" />
          <span className="mt-1 block text-xs text-slate-500">El nodo publica con el código s-&lt;aula&gt; (por ejemplo s-A403). Usa ese formato para que sus lecturas se asocien al aula.</span>
        </label>
        {!original && <p className="text-xs text-slate-500">Se registra sin recibir datos ni controlar el aire, hasta que lo actives desde la vista del aula.</p>}
        {err && <p className="text-xs text-red-300">{err}</p>}
        {problems.length > 0 && <p className="text-xs text-slate-500">{problems[0]}</p>}
      </div>
    </Dialog>
  )
}

function DeleteSensorDialog({ device, onClose, onDeleted, onError }: {
  device: Device; onClose: () => void; onDeleted: () => void; onError: (msg: string) => void
}) {
  const [busy, setBusy] = useState(false)
  async function remove() {
    setBusy(true)
    try { await api.delete(`/admin/sensors/${encodeURIComponent(device.sensor_id)}`); onDeleted() }
    catch (e) { onError(friendly(e, 'No se pudo eliminar el sensor.')); onClose() }
    finally { setBusy(false) }
  }
  return (
    <Dialog
      size="sm"
      title={`¿Eliminar el sensor ${device.sensor_id}?`}
      onClose={onClose}
      footer={<>
        <span className="flex-1" />
        <button className="btn btn-secondary" onClick={onClose}>Cancelar</button>
        <button className="btn btn-danger" onClick={remove} disabled={busy}>{busy && <RefreshCw size={14} className="animate-spin" />} Eliminar</button>
      </>}
    >
      <p className="text-sm text-slate-300">
        Sus lecturas pasadas se conservan. Si el nodo sigue publicando con este código, sus nuevas lecturas se guardarán sin aula y sin decisión de la IA.
      </p>
    </Dialog>
  )
}
