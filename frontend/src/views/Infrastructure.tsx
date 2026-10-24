import { useState, useEffect, useCallback } from 'react'
import {
  Building2, Cpu, Radio, PlusCircle, Pencil, Trash2,
  RefreshCw, AlertCircle, CheckCircle2, X, Info, DoorOpen, TriangleAlert,
} from 'lucide-react'
import api, { getApiErrorDetail } from '../api/client'
import { NUM_INPUT_MODS } from '../utils/formStyles'
import SearchableSelect from '../components/SearchableSelect'
import { RoomFilters, useRoomFilter } from '../components/RoomFilters'
import { Pagination, usePage } from '../components/ui'
import { compareRooms, locationLabel, roomOptions as groupedRoomOptions, shortName, type Room } from '../utils/rooms'

// ── Types ─────────────────────────────────────────────────────────────────────

interface SensorDevice {
  sensor_id: string
  room_id: string
  room_name: string | null
  is_active: boolean
  control_enabled: boolean
}

interface Toast { type: 'success' | 'error'; message: string }
interface EditRoomForm { new_id: string; name: string; max_capacity: string; target_temp: string; building: string; floor: string }
interface RoomImpact   { reservations_count: number; sensors_count: number }
interface OrphanData  { reservations_count: number; sensors_count: number }

type RoomTab   = 'register' | 'edit'
type SensorTab = 'register' | 'edit'

// ── Sub-components ────────────────────────────────────────────────────────────

function DataRow({ label, value, changed }: { label: string; value: string; changed?: boolean }) {
  return (
    <div>
      <p className="text-xs text-slate-500 mb-0.5">{label}</p>
      <p className={`text-sm font-medium ${changed ? 'text-amber-300' : 'text-slate-200'}`}>
        {value}
        {changed && (
          <span className="ml-1.5 text-xs bg-amber-500/20 text-amber-400 px-1 py-0.5 rounded">
            modificado
          </span>
        )}
      </p>
    </div>
  )
}

interface TabBarProps {
  active: string
  onChange: (v: string) => void
  tabs: { key: string; label: string; icon: React.ReactNode }[]
}

function TabBar({ active, onChange, tabs }: TabBarProps) {
  return (
    <div className="segmented p-0.5">
      {tabs.map(t => (
        <button
          key={t.key}
          type="button"
          onClick={() => onChange(t.key)}
          className={`segmented-item text-xs ${active === t.key ? 'segmented-item-active' : ''}`}
        >
          {t.icon} {t.label}
        </button>
      ))}
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export default function Infrastructure() {
  // ── Data ─────────────────────────────────────────────────────────────────
  const [rooms,   setRooms]   = useState<Room[]>([])
  const [devices, setDevices] = useState<SensorDevice[]>([])
  const [loading, setLoading] = useState(true)
  const [toast,   setToast]   = useState<Toast | null>(null)

  // ── Per-card submitting state ─────────────────────────────────────────────
  const [roomSubmitting,   setRoomSubmitting]   = useState(false)
  const [sensorSubmitting, setSensorSubmitting] = useState(false)

  // ── Tab state ─────────────────────────────────────────────────────────────
  const [roomTab,   setRoomTab]   = useState<RoomTab>('register')
  const [sensorTab, setSensorTab] = useState<SensorTab>('register')

  // ── Register room ─────────────────────────────────────────────────────────
  const EMPTY_ROOM = { id: '', name: '', max_capacity: '30', target_temp: '22', building: '', floor: '' }
  const [regRoomForm, setRegRoomForm] = useState(EMPTY_ROOM)

  // ── Edit room ─────────────────────────────────────────────────────────────
  const [editRoomId,       setEditRoomId]       = useState('')
  const [editRoomForm,     setEditRoomForm]     = useState<EditRoomForm>({ new_id: '', name: '', max_capacity: '30', target_temp: '22', building: '', floor: '' })
  const [editRoomModalOpen, setEditRoomModalOpen] = useState(false)
  const [pendingRoom, setPendingRoom] = useState<{ original: Room; form: EditRoomForm } | null>(null)

  // ── Register sensor ───────────────────────────────────────────────────────
  const [regSensorForm, setRegSensorForm] = useState({ id: '', room_id: '' })

  // ── Edit sensor ───────────────────────────────────────────────────────────
  const [editSensorId,       setEditSensorId]       = useState('')
  const [editSensorNewId,    setEditSensorNewId]    = useState('')
  const [editSensorRoomId,   setEditSensorRoomId]   = useState('')
  const [editSensorModalOpen, setEditSensorModalOpen] = useState(false)
  const [pendingSensor, setPendingSensor] = useState<{
    original: SensorDevice; newSensorId: string; newRoomId: string; newRoomName: string
  } | null>(null)

  // ── Edit room cascade flags (shown in confirmation modal) ────────────────
  const [cascadeReservations, setCascadeReservations] = useState(true)
  const [cascadeSensors,      setCascadeSensors]      = useState(true)

  // ── Delete room modal ─────────────────────────────────────────────────────
  const [deleteRoomModalOpen,  setDeleteRoomModalOpen]  = useState(false)
  const [roomImpact,           setRoomImpact]           = useState<RoomImpact | null>(null)
  const [impactLoading,        setImpactLoading]        = useState(false)
  const [deleteRoomConfirm,    setDeleteRoomConfirm]    = useState('')

  // ── Orphan-inheritance warning modal (register room flow) ─────────────────
  const [orphanWarningOpen, setOrphanWarningOpen] = useState(false)
  const [orphanData,        setOrphanData]        = useState<OrphanData | null>(null)
  const [orphanConfirm,     setOrphanConfirm]     = useState('')

  // ── Delete sensor modal ───────────────────────────────────────────────────
  const [deleteSensorModalOpen, setDeleteSensorModalOpen] = useState(false)
  const [deleteSensorConfirm,   setDeleteSensorConfirm]   = useState('')

  // ── Helpers ───────────────────────────────────────────────────────────────

  const showToast = (type: Toast['type'], message: string) => {
    setToast({ type, message })
    setTimeout(() => setToast(null), 4500)
  }

  const refreshRooms = useCallback(() =>
    api.get<Room[]>('/admin/rooms').then(res => {
      const data = Array.isArray(res.data) ? res.data : []
      setRooms(data)
      return data
    }), [])

  const refreshDevices = useCallback(() =>
    api.get<SensorDevice[]>('/admin/devices').then(res => {
      setDevices(Array.isArray(res.data) ? res.data : [])
    }), [])

  useEffect(() => {
    Promise.all([refreshRooms(), refreshDevices()])
      .then(([roomList]) => {
        if (roomList.length > 0) setRegSensorForm(f => ({ ...f, room_id: roomList[0].id }))
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [refreshRooms, refreshDevices])

  // ── Room actions ──────────────────────────────────────────────────────────

  function selectEditRoom(id: string) {
    setEditRoomId(id)
    const room = rooms.find(r => r.id === id)
    if (room) setEditRoomForm({
      new_id: room.id, name: room.name, max_capacity: String(room.max_capacity), target_temp: String(room.target_temp),
      building: room.building ?? '', floor: room.floor == null ? '' : String(room.floor),
    })
  }

  async function doRegisterRoom() {
    await api.post('/admin/rooms', {
      id: regRoomForm.id.trim(),
      name: regRoomForm.name.trim(),
      max_capacity: Number(regRoomForm.max_capacity) || 0,
      target_temp: Number(regRoomForm.target_temp) || 0,
      building: regRoomForm.building.trim() || null,
      floor: regRoomForm.floor === '' ? null : Number(regRoomForm.floor),
    })
    showToast('success', `Aula '${regRoomForm.id.trim()}' registrada correctamente.`)
    setRegRoomForm(EMPTY_ROOM)
    await refreshRooms()
  }

  async function handleRegisterRoom(e: React.FormEvent) {
    e.preventDefault()
    const id = regRoomForm.id.trim()
    if (!id) return
    setRoomSubmitting(true)
    try {
      const { data } = await api.get<{ has_orphans: boolean; reservations_count: number; sensors_count: number }>(
        `/admin/rooms/check-orphans/${encodeURIComponent(id)}`
      )
      if (data.has_orphans) {
        setOrphanData({ reservations_count: data.reservations_count, sensors_count: data.sensors_count })
        setOrphanConfirm('')
        setOrphanWarningOpen(true)
        return  // pause — user must confirm inheritance in the warning modal
      }
      await doRegisterRoom()
    } catch (err: unknown) {
      const detail = getApiErrorDetail(err)
      showToast('error', detail ?? 'No se pudo registrar el aula.')
    } finally {
      setRoomSubmitting(false)
    }
  }

  async function confirmOrphanInheritance() {
    if (orphanConfirm !== regRoomForm.id.trim()) return
    setOrphanWarningOpen(false)
    setOrphanData(null)
    setRoomSubmitting(true)
    try {
      await doRegisterRoom()
    } catch (err: unknown) {
      const detail = getApiErrorDetail(err)
      showToast('error', detail ?? 'No se pudo registrar el aula.')
    } finally {
      setRoomSubmitting(false)
    }
  }

  function openEditRoomModal(e: React.FormEvent) {
    e.preventDefault()
    if (!editRoomId) return
    const original = rooms.find(r => r.id === editRoomId)
    if (!original) return
    setPendingRoom({ original, form: { ...editRoomForm } })
    setCascadeReservations(true)
    setCascadeSensors(true)
    setEditRoomModalOpen(true)
  }

  async function confirmEditRoom() {
    if (!pendingRoom) return
    setRoomSubmitting(true)
    setEditRoomModalOpen(false)
    const idChanged = pendingRoom.form.new_id && pendingRoom.form.new_id !== pendingRoom.original.id
    try {
      await api.put(`/admin/rooms/${pendingRoom.original.id}`, {
        ...pendingRoom.form,
        max_capacity: Number(pendingRoom.form.max_capacity) || 0,
        target_temp: Number(pendingRoom.form.target_temp) || 0,
        building: pendingRoom.form.building.trim() || null,
        floor: pendingRoom.form.floor === '' ? null : Number(pendingRoom.form.floor),
      }, {
        params: { cascade_sensors: cascadeSensors, cascade_reservations: cascadeReservations },
      })
      const label = idChanged ? pendingRoom.form.new_id : pendingRoom.original.id
      showToast('success', `Aula '${label}' actualizada correctamente.`)
      setPendingRoom(null)
      setEditRoomId('')
      setEditRoomForm({ new_id: '', name: '', max_capacity: '30', target_temp: '22', building: '', floor: '' })
      await refreshRooms()
    } catch (err: unknown) {
      const detail = getApiErrorDetail(err)
      showToast('error', detail ?? 'No se pudo actualizar el aula.')
    } finally { setRoomSubmitting(false) }
  }

  // ── Sensor actions ────────────────────────────────────────────────────────

  function selectEditSensor(id: string) {
    setEditSensorId(id)
    setEditSensorNewId(id)
    const dev = devices.find(d => d.sensor_id === id)
    setEditSensorRoomId(dev?.room_id ?? '')
  }

  async function handleRegisterSensor(e: React.FormEvent) {
    e.preventDefault()
    if (!regSensorForm.room_id) return
    setSensorSubmitting(true)
    try {
      await api.post('/admin/sensors', {
        id: regSensorForm.id.trim(),
        room_id: regSensorForm.room_id,
      })
      showToast('success', `Sensor '${regSensorForm.id}' aprovisionado. Estado inicial: inactivo.`)
      setRegSensorForm(f => ({ ...f, id: '' }))
      await refreshDevices()
    } catch (err: unknown) {
      const detail = getApiErrorDetail(err)
      showToast('error', detail ?? 'No se pudo registrar el sensor.')
    } finally { setSensorSubmitting(false) }
  }

  function openEditSensorModal(e: React.FormEvent) {
    e.preventDefault()
    if (!editSensorId) return
    const original = devices.find(d => d.sensor_id === editSensorId)
    if (!original) return
    const newRoom = rooms.find(r => r.id === editSensorRoomId)
    setPendingSensor({
      original,
      newSensorId: editSensorNewId.trim() || editSensorId,
      newRoomId: editSensorRoomId,
      newRoomName: editSensorRoomId ? (newRoom?.name ?? editSensorRoomId) : '(Sin asignar)',
    })
    setEditSensorModalOpen(true)
  }

  async function confirmEditSensor() {
    if (!pendingSensor) return
    setSensorSubmitting(true)
    setEditSensorModalOpen(false)
    const idChanged = pendingSensor.newSensorId !== pendingSensor.original.sensor_id
    try {
      await api.put(`/admin/sensors/${pendingSensor.original.sensor_id}`, {
        room_id: pendingSensor.newRoomId || null,
        ...(idChanged ? { new_id: pendingSensor.newSensorId } : {}),
      })
      const label = idChanged ? pendingSensor.newSensorId : pendingSensor.original.sensor_id
      showToast('success', `Sensor '${label}' actualizado correctamente.`)
      setPendingSensor(null)
      setEditSensorId('')
      setEditSensorNewId('')
      setEditSensorRoomId('')
      await refreshDevices()
    } catch (err: unknown) {
      const detail = getApiErrorDetail(err)
      showToast('error', detail ?? 'No se pudo actualizar el sensor.')
    } finally { setSensorSubmitting(false) }
  }

  // ── Delete room handlers ──────────────────────────────────────────────────

  async function openDeleteRoomModal() {
    if (!editRoomId) return
    setDeleteRoomModalOpen(true)
    setDeleteRoomConfirm('')
    setRoomImpact(null)
    setImpactLoading(true)
    try {
      const { data } = await api.get<RoomImpact>(`/admin/rooms/${editRoomId}/impact`)
      setRoomImpact(data)
    } catch {
      setRoomImpact({ reservations_count: 0, sensors_count: 0 })
    } finally {
      setImpactLoading(false)
    }
  }

  async function confirmDeleteRoom() {
    if (!editRoomId || deleteRoomConfirm !== editRoomId) return
    setRoomSubmitting(true)
    setDeleteRoomModalOpen(false)
    try {
      await api.delete(`/admin/rooms/${editRoomId}`)
      showToast('success', `Aula '${editRoomId}' eliminada definitivamente.`)
      setEditRoomId('')
      setEditRoomForm({ new_id: '', name: '', max_capacity: '30', target_temp: '22', building: '', floor: '' })
      setDeleteRoomConfirm('')
      setRoomImpact(null)
      await Promise.all([refreshRooms(), refreshDevices()])
    } catch (err: unknown) {
      const detail = getApiErrorDetail(err)
      showToast('error', detail ?? 'No se pudo eliminar el aula.')
    } finally { setRoomSubmitting(false) }
  }

  // ── Delete sensor handlers ────────────────────────────────────────────────

  async function confirmDeleteSensor() {
    if (!editSensorId || deleteSensorConfirm !== editSensorId) return
    setSensorSubmitting(true)
    setDeleteSensorModalOpen(false)
    try {
      await api.delete(`/admin/sensors/${editSensorId}`)
      showToast('success', `Sensor '${editSensorId}' eliminado definitivamente.`)
      setEditSensorId('')
      setEditSensorRoomId('')
      setDeleteSensorConfirm('')
      await refreshDevices()
    } catch (err: unknown) {
      const detail = getApiErrorDetail(err)
      showToast('error', detail ?? 'No se pudo eliminar el sensor.')
    } finally { setSensorSubmitting(false) }
  }

  // ── Derived ───────────────────────────────────────────────────────────────

  const roomOptions = groupedRoomOptions(rooms)
  // Sensor-edit variant: prepend the "detach" option (value='') so admins can orphan a sensor
  const sensorRoomOptions = [
    { value: '', label: '(Ninguna / Dejar Huérfano)' },
    ...roomOptions,
  ]
  const sensorOptions = devices.map(d => ({
    value: d.sensor_id,
    label: `${d.sensor_id}${d.room_name ? ` (${d.room_name})` : ''}`,
  }))
  const currentDevice = devices.find(d => d.sensor_id === editSensorId) ?? null

  const inputCls = "field"
  const roomFilter = useRoomFilter(rooms)
  const sortedRooms = [...roomFilter.filtered].sort(compareRooms)
  const roomPage = usePage(sortedRooms, 10)
  const sensorsOf = (id: string) => devices.filter(d => d.room_id === id)
  const numInputCls = `${inputCls} ${NUM_INPUT_MODS}`
  const labelCls = "field-label"

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-4">

      {/* Header */}
      <div className="flex items-center gap-3">
        <div>
          <h1 className="page-title">Infraestructura</h1>
          <p className="mt-1 text-xs text-slate-400">Aprovisionamiento y configuración de aulas y sensores IoT</p>
        </div>
      </div>

      {/* Toast */}
      {toast && (
        <div className={`flex items-center justify-between gap-3 rounded-lg px-4 py-3 text-sm ${
          toast.type === 'success'
            ? 'bg-emerald-900/40 border border-emerald-500/40 text-emerald-300'
            : 'bg-red-900/40 border border-red-500/40 text-red-300'
        }`}>
          <span className="flex items-center gap-2">
            {toast.type === 'success'
              ? <CheckCircle2 size={16} className="shrink-0" />
              : <AlertCircle size={16} className="shrink-0" />}
            {toast.message}
          </span>
          <button onClick={() => setToast(null)} className="opacity-60 hover:opacity-100 transition-opacity">
            <X size={14} />
          </button>
        </div>
      )}

      {loading ? (
        <div className="flex items-center gap-2 text-slate-400 text-sm py-12">
          <RefreshCw size={14} className="animate-spin" /> Cargando infraestructura…
        </div>
      ) : (

        <>
        {/* ── Rooms table: list → detail instead of a dropdown (rule 11) ── */}
        <div className="surface p-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h2 className="section-title">Aulas registradas · {rooms.length}</h2>
            <RoomFilters rooms={rooms} state={roomFilter.state} onChange={roomFilter.setState} />
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="table-head">
                  <th className="py-2 pr-4 font-normal">Aula</th>
                  <th className="py-2 pr-4 font-normal">Ubicación</th>
                  <th className="py-2 pr-4 font-normal">Capacidad</th>
                  <th className="py-2 pr-4 font-normal">Temp. objetivo</th>
                  <th className="py-2 pr-4 font-normal">Sensores</th>
                  <th className="py-2 font-normal" />
                </tr>
              </thead>
              <tbody>
                {roomPage.rows.map(r => (
                  <tr key={r.id} className={`table-row ${editRoomId === r.id ? 'bg-slate-800/50' : ''}`}>
                    <td className="py-2 pr-4"><span className="font-medium text-slate-100">{r.id}</span> <span className="text-slate-400">{shortName(r)}</span></td>
                    <td className="py-2 pr-4 text-slate-300">{locationLabel(r)}</td>
                    <td className="py-2 pr-4 tabular-nums text-slate-300">{r.max_capacity}</td>
                    <td className="py-2 pr-4 tabular-nums text-slate-300">{r.target_temp} °C</td>
                    <td className="py-2 pr-4 text-xs text-slate-400">{sensorsOf(r.id).map(d => d.sensor_id).join(', ') || '—'}</td>
                    <td className="py-2 text-right">
                      <button className="btn btn-ghost py-1" onClick={() => { setRoomTab('edit'); selectEditRoom(r.id) }}>
                        <Pencil size={13} /> Editar
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {sortedRooms.length === 0 && <p className="py-4 text-sm text-slate-400">Ningún aula coincide con los filtros.</p>}
          <Pagination {...roomPage} noun="aulas" />
        </div>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 lg:items-start">

          {/* ── Left column: Aulas ───────────────────────────────────────────── */}
          <div className="surface overflow-hidden flex flex-col h-full">

            {/* Card header */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-700">
              <h2 className="flex items-center gap-2 text-slate-100 text-sm font-semibold">
                <Building2 size={15} className="text-slate-400 shrink-0" />
                Aulas
                <span className="text-slate-500 font-normal text-xs">(Infraestructura Física)</span>
              </h2>
              <TabBar
                active={roomTab}
                onChange={v => { setRoomTab(v as RoomTab); setEditRoomModalOpen(false) }}
                tabs={[
                  { key: 'register', label: 'Registrar', icon: <PlusCircle size={11} /> },
                  { key: 'edit',     label: 'Editar',     icon: <Pencil size={11} /> },
                ]}
              />
            </div>

            <div className="p-5 flex flex-col flex-1 overflow-hidden">

              {/* ── Registrar Aula ────────────────────────────────────────── */}
              {roomTab === 'register' && (
                <form onSubmit={handleRegisterRoom} className="flex flex-col flex-1 justify-between overflow-hidden">
                  <div className="flex-1 min-h-0 overflow-y-auto pr-2 space-y-4">
                    <div>
                      <label className={labelCls}>ID del Aula</label>
                      <input type="text" required placeholder="ej. AULA-101"
                        value={regRoomForm.id}
                        onChange={e => setRegRoomForm(f => ({ ...f, id: e.target.value }))}
                        className={inputCls}
                      />
                    </div>
                    <div>
                      <label className={labelCls}>Nombre</label>
                      <input type="text" required placeholder="ej. Laboratorio de Física"
                        value={regRoomForm.name}
                        onChange={e => setRegRoomForm(f => ({ ...f, name: e.target.value }))}
                        className={inputCls}
                      />
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <div>
                        <label className={labelCls}>Capacidad Máxima</label>
                        <input type="number" required min={1}
                          value={regRoomForm.max_capacity}
                          onChange={e => setRegRoomForm(f => ({ ...f, max_capacity: e.target.value }))}
                          onBlur={e => setRegRoomForm(f => ({ ...f, max_capacity: e.target.value === '' ? '0' : e.target.value }))}
                          className={numInputCls}
                        />
                      </div>
                      <div>
                        <label className={labelCls}>Temp. Objetivo (°C)</label>
                        <input type="number" required min={10} max={35} step={0.5}
                          value={regRoomForm.target_temp}
                          onChange={e => setRegRoomForm(f => ({ ...f, target_temp: e.target.value }))}
                          onBlur={e => setRegRoomForm(f => ({ ...f, target_temp: e.target.value === '' ? '0' : e.target.value }))}
                          className={numInputCls}
                        />
                      </div>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <div>
                        <label className={labelCls}>Edificio</label>
                        <input type="text" placeholder="ej. M" maxLength={10}
                          value={regRoomForm.building}
                          onChange={e => setRegRoomForm(f => ({ ...f, building: e.target.value.toUpperCase() }))}
                          className={inputCls}
                        />
                      </div>
                      <div>
                        <label className={labelCls}>Piso</label>
                        <input type="number" placeholder="ej. 6" min={-5} max={99}
                          value={regRoomForm.floor}
                          onChange={e => setRegRoomForm(f => ({ ...f, floor: e.target.value }))}
                          className={numInputCls}
                        />
                      </div>
                    </div>
                  </div>
                  <div className="pt-4 border-t border-slate-700/50 flex justify-end">
                    <button type="submit" disabled={roomSubmitting}
                      className="btn btn-primary"
                    >
                      {roomSubmitting
                        ? <><RefreshCw size={13} className="animate-spin" /> Guardando…</>
                        : <><PlusCircle size={13} /> Registrar Aula</>}
                    </button>
                  </div>
                </form>
              )}

              {/* ── Editar Aula ───────────────────────────────────────────── */}
              {roomTab === 'edit' && (
                <form onSubmit={openEditRoomModal} className="flex flex-col flex-1 justify-between overflow-hidden">
                  <div className="flex-1 min-h-0 overflow-y-auto pr-2 space-y-4">
                    <SearchableSelect
                      options={roomOptions}
                      value={editRoomId}
                      onChange={selectEditRoom}
                      placeholder="Busca el aula a editar…"
                      label="Seleccionar Aula"
                      icon={<DoorOpen size={16} />}
                    />
                    {!editRoomId && (
                      <p className="text-xs text-slate-500">
                        Selecciona un aula para cargar sus datos actuales.
                      </p>
                    )}
                    {editRoomId && (
                      <>
                        <p className="text-xs text-emerald-400 flex items-center gap-1">
                          <CheckCircle2 size={11} /> Aula {editRoomId} cargada — modifica y revisa antes de guardar.
                        </p>
                        <div>
                          <label className={labelCls}>ID del Aula</label>
                          <input type="text" required
                            value={editRoomForm.new_id}
                            onChange={e => setEditRoomForm(f => ({ ...f, new_id: e.target.value }))}
                            className={inputCls}
                          />
                        </div>
                        <div>
                          <label className={labelCls}>Nombre</label>
                          <input type="text" required
                            value={editRoomForm.name}
                            onChange={e => setEditRoomForm(f => ({ ...f, name: e.target.value }))}
                            className={inputCls}
                          />
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                          <div>
                            <label className={labelCls}>Capacidad Máxima</label>
                            <input type="number" required min={1}
                              value={editRoomForm.max_capacity}
                              onChange={e => setEditRoomForm(f => ({ ...f, max_capacity: e.target.value }))}
                              onBlur={e => setEditRoomForm(f => ({ ...f, max_capacity: e.target.value === '' ? '0' : e.target.value }))}
                              className={numInputCls}
                            />
                          </div>
                          <div>
                            <label className={labelCls}>Temp. Objetivo (°C)</label>
                            <input type="number" required min={10} max={35} step={0.5}
                              value={editRoomForm.target_temp}
                              onChange={e => setEditRoomForm(f => ({ ...f, target_temp: e.target.value }))}
                              onBlur={e => setEditRoomForm(f => ({ ...f, target_temp: e.target.value === '' ? '0' : e.target.value }))}
                              className={numInputCls}
                            />
                          </div>
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                          <div>
                            <label className={labelCls}>Edificio</label>
                            <input type="text" maxLength={10}
                              value={editRoomForm.building}
                              onChange={e => setEditRoomForm(f => ({ ...f, building: e.target.value.toUpperCase() }))}
                              className={inputCls}
                            />
                          </div>
                          <div>
                            <label className={labelCls}>Piso</label>
                            <input type="number" min={-5} max={99}
                              value={editRoomForm.floor}
                              onChange={e => setEditRoomForm(f => ({ ...f, floor: e.target.value }))}
                              className={numInputCls}
                            />
                          </div>
                        </div>
                      </>
                    )}
                  </div>
                  <div className="pt-4 border-t border-slate-700/50 flex items-center justify-between">
                    {editRoomId ? (
                      <button
                        type="button"
                        onClick={openDeleteRoomModal}
                        className="flex items-center gap-1.5 text-sm text-red-500 hover:bg-red-500/10 px-3 py-2 rounded-lg transition-colors"
                      >
                        <Trash2 size={13} /> Eliminar aula
                      </button>
                    ) : <span />}
                    <button type="submit" disabled={!editRoomId || roomSubmitting}
                      className="btn btn-primary"
                    >
                      {roomSubmitting
                        ? <><RefreshCw size={13} className="animate-spin" /> Procesando…</>
                        : <><Pencil size={13} /> Revisar y guardar</>}
                    </button>
                  </div>
                </form>
              )}

            </div>
          </div>

          {/* ── Right column: Sensores ───────────────────────────────────────── */}
          <div className="surface overflow-hidden flex flex-col h-full">

            {/* Card header */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-700">
              <h2 className="flex items-center gap-2 text-slate-100 text-sm font-semibold">
                <Cpu size={15} className="text-slate-400 shrink-0" />
                Sensores
                <span className="text-slate-500 font-normal text-xs">(Hardware IoT)</span>
              </h2>
              <TabBar
                active={sensorTab}
                onChange={v => { setSensorTab(v as SensorTab); setEditSensorModalOpen(false) }}
                tabs={[
                  { key: 'register', label: 'Registrar', icon: <PlusCircle size={11} /> },
                  { key: 'edit',     label: 'Editar',     icon: <Pencil size={11} /> },
                ]}
              />
            </div>

            <div className="p-5 flex flex-col flex-1 overflow-hidden">

              {/* ── Registrar Sensor ──────────────────────────────────────── */}
              {sensorTab === 'register' && (
                <form onSubmit={handleRegisterSensor} className="flex flex-col flex-1 justify-between overflow-hidden">
                  <div className="flex-1 min-h-0 overflow-y-auto pr-2 space-y-4">
                    <div>
                      <label className={labelCls}>ID del Sensor</label>
                      <input type="text" required placeholder="ej. sensor-lab-101-a"
                        value={regSensorForm.id}
                        onChange={e => setRegSensorForm(f => ({ ...f, id: e.target.value }))}
                        className={inputCls}
                      />
                    </div>
                    <div>
                      {rooms.length === 0 ? (
                        <div className="flex items-center gap-2 text-amber-400 text-sm bg-amber-900/20 border border-amber-500/30 rounded-lg px-3 py-2.5">
                          <AlertCircle size={14} className="shrink-0" />
                          No hay aulas registradas. Registra una antes de añadir sensores.
                        </div>
                      ) : (
                        <SearchableSelect
                          options={roomOptions}
                          value={regSensorForm.room_id}
                          onChange={v => setRegSensorForm(f => ({ ...f, room_id: v }))}
                          placeholder="Selecciona un aula…"
                          label="Aula Asignada"
                          icon={<DoorOpen size={16} />}
                        />
                      )}
                    </div>
                    <div className="flex items-start gap-2 bg-slate-900/50 border border-slate-700/60 rounded-lg px-3 py-2.5">
                      <Info size={13} className="text-slate-500 shrink-0 mt-0.5" />
                      <p className="text-xs text-slate-400">
                        Sensores nuevos se inicializan{' '}
                        <strong className="text-slate-300">apagados y sin control AC</strong>.
                        Actívalos desde el Dashboard del aula tras la instalación física.
                      </p>
                    </div>
                  </div>
                  <div className="pt-4 border-t border-slate-700/50 flex justify-end">
                    <button type="submit"
                      disabled={sensorSubmitting || !regSensorForm.room_id || rooms.length === 0}
                      className="btn btn-primary"
                    >
                      {sensorSubmitting
                        ? <><RefreshCw size={13} className="animate-spin" /> Guardando…</>
                        : <><PlusCircle size={13} /> Registrar Sensor</>}
                    </button>
                  </div>
                </form>
              )}

              {/* ── Editar Sensor ─────────────────────────────────────────── */}
              {sensorTab === 'edit' && (
                <form onSubmit={openEditSensorModal} className="flex flex-col flex-1 justify-between overflow-hidden">
                  <div className="flex-1 min-h-0 overflow-y-auto pr-2 space-y-4">
                    <SearchableSelect
                      options={sensorOptions}
                      value={editSensorId}
                      onChange={selectEditSensor}
                      placeholder="Busca el sensor a reasignar…"
                      label="Seleccionar Sensor"
                      icon={<Radio size={16} />}
                    />
                    {!editSensorId && (
                      <p className="text-xs text-slate-500">
                        Selecciona un sensor para ver su aula actual y reasignarlo.
                      </p>
                    )}
                    {editSensorId && (
                      <>
                        <p className="text-xs text-emerald-400 flex items-center gap-1">
                          <CheckCircle2 size={11} /> Sensor {editSensorId} seleccionado.
                        </p>

                        {/* Current assignment */}
                        <div className="bg-slate-900/50 border border-slate-700 rounded-lg px-4 py-3">
                          <p className="text-xs text-slate-500 mb-1">Aula actual</p>
                          <p className="text-slate-200 font-medium text-sm">
                            {currentDevice?.room_name ?? currentDevice?.room_id ?? '—'}
                            {currentDevice?.room_name && (
                              <span className="ml-2 text-xs text-slate-500">({currentDevice.room_id})</span>
                            )}
                          </p>
                          <p className={`text-xs mt-1 ${currentDevice?.is_active ? 'text-emerald-400' : 'text-slate-500'}`}>
                            {currentDevice?.is_active ? 'Activo' : 'Inactivo'}
                            {' · '}
                            {currentDevice?.control_enabled ? 'Control AC habilitado' : 'Control AC deshabilitado'}
                          </p>
                        </div>

                        {/* New sensor ID */}
                        <div>
                          <label className={labelCls}>ID del Sensor</label>
                          <input type="text" required
                            value={editSensorNewId}
                            onChange={e => setEditSensorNewId(e.target.value)}
                            className={inputCls}
                          />
                        </div>

                        {/* New room picker — includes "(Ninguna)" to detach sensor */}
                        <SearchableSelect
                          options={sensorRoomOptions}
                          value={editSensorRoomId}
                          onChange={v => setEditSensorRoomId(v)}
                          placeholder="Nueva aula destino…"
                          label="Nueva Aula"
                          icon={<DoorOpen size={16} />}
                        />
                      </>
                    )}
                  </div>
                  <div className="pt-4 border-t border-slate-700/50 flex items-center justify-between">
                    {editSensorId ? (
                      <button
                        type="button"
                        onClick={() => { setDeleteSensorConfirm(''); setDeleteSensorModalOpen(true) }}
                        className="flex items-center gap-1.5 text-sm text-red-500 hover:bg-red-500/10 px-3 py-2 rounded-lg transition-colors"
                      >
                        <Trash2 size={13} /> Eliminar sensor
                      </button>
                    ) : <span />}
                    <button type="submit"
                      disabled={!editSensorId || sensorSubmitting || ((editSensorRoomId || null) === (currentDevice?.room_id ?? null) && editSensorNewId.trim() === editSensorId)}
                      className="btn btn-primary"
                    >
                      {sensorSubmitting
                        ? <><RefreshCw size={13} className="animate-spin" /> Procesando…</>
                        : <><Pencil size={13} /> Revisar y reasignar</>}
                    </button>
                  </div>
                </form>
              )}

            </div>
          </div>

        </div>
        </>
      )}

      {/* ── Modal: Confirmar edición de aula ──────────────────────────────── */}
      {editRoomModalOpen && pendingRoom && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
          <div className="surface rounded-lg shadow-2xl w-full max-w-2xl">

            <div className="flex items-center justify-between px-6 py-4 border-b border-slate-700">
              <h3 className="text-sm font-semibold text-white flex items-center gap-2">
                <Pencil size={16} className="text-blue-400" /> Confirmar Actualización de Aula
              </h3>
              <button onClick={() => setEditRoomModalOpen(false)}
                className="text-slate-400 hover:text-slate-100 transition-colors"
              >
                <X size={18} />
              </button>
            </div>

            <div className="p-6 grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="surface-inset p-4 space-y-4">
                <p className="text-xs font-semibold text-slate-400 flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-slate-500 inline-block" /> Datos Actuales
                </p>
                <DataRow label="ID"                   value={pendingRoom.original.id} />
                <DataRow label="Nombre"               value={pendingRoom.original.name} />
                <DataRow label="Capacidad"            value={`${pendingRoom.original.max_capacity} personas`} />
                <DataRow label="Temperatura Objetivo" value={`${pendingRoom.original.target_temp} °C`} />
                <DataRow label="Ubicación" value={locationLabel(pendingRoom.original)} />
              </div>
              <div className="bg-blue-900/20 border border-blue-500/30 rounded-lg p-4 space-y-4">
                <p className="text-xs font-semibold text-blue-400 flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-blue-400 inline-block" /> Nuevos Datos
                </p>
                <DataRow
                  label="ID"
                  value={pendingRoom.form.new_id || pendingRoom.original.id}
                  changed={!!pendingRoom.form.new_id && pendingRoom.form.new_id !== pendingRoom.original.id}
                />
                <DataRow label="Nombre" value={pendingRoom.form.name}
                  changed={pendingRoom.form.name !== pendingRoom.original.name}
                />
                <DataRow label="Capacidad" value={`${pendingRoom.form.max_capacity} personas`}
                  changed={Number(pendingRoom.form.max_capacity) !== pendingRoom.original.max_capacity}
                />
                <DataRow label="Ubicación"
                  value={locationLabel({ building: pendingRoom.form.building || null, floor: pendingRoom.form.floor === '' ? null : Number(pendingRoom.form.floor) })}
                  changed={(pendingRoom.form.building || null) !== (pendingRoom.original.building ?? null) || (pendingRoom.form.floor === '' ? null : Number(pendingRoom.form.floor)) !== (pendingRoom.original.floor ?? null)}
                />
                <DataRow label="Temperatura Objetivo" value={`${pendingRoom.form.target_temp} °C`}
                  changed={Number(pendingRoom.form.target_temp) !== pendingRoom.original.target_temp}
                />
              </div>
            </div>

            {/* Cascade-impact options — only when ID is being renamed */}
            {pendingRoom && !!pendingRoom.form.new_id && pendingRoom.form.new_id !== pendingRoom.original.id && (
              <div className="mx-6 mb-4 bg-amber-950/40 border border-amber-700/50 rounded-lg px-4 py-3 space-y-3">
                <p className="text-xs font-semibold text-amber-400 flex items-center gap-1.5">
                  <TriangleAlert size={12} className="shrink-0" /> Actualización en cascada del cambio de ID
                </p>
                <p className="text-xs text-amber-300/70 leading-relaxed">
                  Desmarca para dejar esos registros atados al ID anterior — quedarán como huérfanos históricos de auditoría.
                </p>
                <label className="flex items-center gap-2.5 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={cascadeReservations}
                    onChange={e => setCascadeReservations(e.target.checked)}
                    className="w-3.5 h-3.5 rounded border-amber-600 bg-amber-900/30 accent-amber-500 shrink-0 cursor-pointer"
                  />
                  <span className="text-xs text-amber-200 select-none">
                    Modificar el ID en todas las reservas asociadas a esta aula.
                  </span>
                </label>
                <label className="flex items-center gap-2.5 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={cascadeSensors}
                    onChange={e => setCascadeSensors(e.target.checked)}
                    className="w-3.5 h-3.5 rounded border-amber-600 bg-amber-900/30 accent-amber-500 shrink-0 cursor-pointer"
                  />
                  <span className="text-xs text-amber-200 select-none">
                    Modificar la asociación de ID en todos los sensores instalados.
                  </span>
                </label>
                {(!cascadeReservations || !cascadeSensors) && (
                  <p className="text-xs text-slate-400 flex items-center gap-1.5 pt-1">
                    <Info size={11} className="shrink-0 text-slate-500" />
                    Los registros desmarcados conservarán el ID{' '}
                    <span className="font-mono text-amber-400">{pendingRoom.original.id}</span>{' '}
                    y serán accesibles via la auditoría de huérfanos.
                  </p>
                )}
              </div>
            )}

            <div className="flex items-center justify-end gap-3 px-6 pb-5">
              <button type="button" onClick={() => setEditRoomModalOpen(false)}
                className="px-4 py-2 text-sm font-medium text-slate-300 bg-slate-700 hover:bg-slate-600 rounded-lg transition-colors"
              >
                Cancelar
              </button>
              <button type="button" onClick={confirmEditRoom} disabled={roomSubmitting}
                className="btn btn-primary"
              >
                {roomSubmitting
                  ? <><RefreshCw size={13} className="animate-spin" /> Actualizando…</>
                  : <><CheckCircle2 size={14} /> Sí, Guardar</>}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Modal: Eliminar Aula ──────────────────────────────────────────── */}
      {deleteRoomModalOpen && editRoomId && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/75 backdrop-blur-sm">
          <div className="bg-slate-900 border border-red-900/60 rounded-xl shadow-2xl w-full max-w-lg">

            <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800">
              <h3 className="text-sm font-semibold text-white flex items-center gap-2">
                <Trash2 size={16} className="text-red-500" /> Eliminar Aula Permanentemente
              </h3>
              <button onClick={() => setDeleteRoomModalOpen(false)}
                className="text-slate-500 hover:text-slate-200 transition-colors"
              >
                <X size={18} />
              </button>
            </div>

            <div className="px-6 py-5 space-y-5">

              {/* Impact — orphan info */}
              <div className="flex items-start gap-3 bg-red-950/50 border border-red-800/50 rounded-lg px-4 py-3">
                <TriangleAlert size={16} className="text-red-400 shrink-0 mt-0.5" />
                {impactLoading ? (
                  <p className="text-sm text-slate-400 flex items-center gap-2">
                    <RefreshCw size={12} className="animate-spin" /> Calculando impacto…
                  </p>
                ) : (
                  <div className="text-sm leading-relaxed space-y-1.5">
                    <p className="text-red-300">
                      <strong>Acción irreversible.</strong> La estructura del aula se eliminará de forma permanente.
                    </p>
                    {(roomImpact?.reservations_count ?? 0) > 0 && (
                      <p className="text-amber-300">
                        <span className="font-semibold">{roomImpact!.reservations_count} reserva{roomImpact!.reservations_count !== 1 ? 's' : ''}</span>{' '}
                        quedarán como registros históricos huérfanos (auditoría).
                      </p>
                    )}
                    {(roomImpact?.sensors_count ?? 0) > 0 && (
                      <p className="text-amber-300">
                        <span className="font-semibold">{roomImpact!.sensors_count} sensor{roomImpact!.sensors_count !== 1 ? 'es' : ''}</span>{' '}
                        quedarán sin asignación de aula (hardware IoT preservado).
                      </p>
                    )}
                    {(roomImpact?.reservations_count ?? 0) === 0 && (roomImpact?.sensors_count ?? 0) === 0 && (
                      <p className="text-slate-400">Esta aula no tiene reservas ni sensores asociados.</p>
                    )}
                  </div>
                )}
              </div>

              {/* Confirmation input */}
              <div>
                <label className="field-label">
                  Escribe el ID del aula para confirmar
                </label>
                <input
                  type="text"
                  placeholder={editRoomId}
                  value={deleteRoomConfirm}
                  onChange={e => setDeleteRoomConfirm(e.target.value)}
                  className="field font-mono focus:border-red-500 focus:ring-red-500/40"
                />
              </div>
            </div>

            <div className="flex items-center justify-end gap-3 px-6 pb-5">
              <button type="button" onClick={() => setDeleteRoomModalOpen(false)}
                className="btn btn-secondary"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={confirmDeleteRoom}
                disabled={roomSubmitting || deleteRoomConfirm !== editRoomId}
                className="btn btn-danger"
              >
                {roomSubmitting
                  ? <><RefreshCw size={13} className="animate-spin" /> Eliminando…</>
                  : <><Trash2 size={13} /> Eliminar Definitivamente</>}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Modal: Confirmar reasignación de sensor ───────────────────────── */}
      {editSensorModalOpen && pendingSensor && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
          <div className="surface rounded-lg shadow-2xl w-full max-w-2xl">

            <div className="flex items-center justify-between px-6 py-4 border-b border-slate-700">
              <h3 className="text-sm font-semibold text-white flex items-center gap-2">
                <Radio size={16} className="text-blue-400" /> Confirmar Reasignación de Sensor
              </h3>
              <button onClick={() => setEditSensorModalOpen(false)}
                className="text-slate-400 hover:text-slate-100 transition-colors"
              >
                <X size={18} />
              </button>
            </div>

            <div className="p-6 grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="surface-inset p-4 space-y-4">
                <p className="text-xs font-semibold text-slate-400 flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-slate-500 inline-block" /> Asignación Actual
                </p>
                <DataRow label="Sensor ID"    value={pendingSensor.original.sensor_id} />
                <DataRow label="Aula Asignada" value={pendingSensor.original.room_name ?? pendingSensor.original.room_id ?? '(Sin asignar)'} />
                <DataRow label="Estado"        value={pendingSensor.original.is_active ? 'Activo' : 'Inactivo'} />
              </div>
              <div className="bg-blue-900/20 border border-blue-500/30 rounded-lg p-4 space-y-4">
                <p className="text-xs font-semibold text-blue-400 flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-blue-400 inline-block" /> Nueva Asignación
                </p>
                <DataRow
                  label="Sensor ID"
                  value={pendingSensor.newSensorId}
                  changed={pendingSensor.newSensorId !== pendingSensor.original.sensor_id}
                />
                <DataRow
                  label="Aula Asignada"
                  value={pendingSensor.newRoomName || '(Sin asignar)'}
                  changed={(pendingSensor.newRoomId || null) !== (pendingSensor.original.room_id ?? null)}
                />
                <DataRow label="Estado" value={pendingSensor.original.is_active ? 'Activo' : 'Inactivo'} />
              </div>
            </div>

            <div className="flex items-center justify-end gap-3 px-6 pb-5">
              <button type="button" onClick={() => setEditSensorModalOpen(false)}
                className="px-4 py-2 text-sm font-medium text-slate-300 bg-slate-700 hover:bg-slate-600 rounded-lg transition-colors"
              >
                Cancelar
              </button>
              <button type="button" onClick={confirmEditSensor} disabled={sensorSubmitting}
                className="btn btn-primary"
              >
                {sensorSubmitting
                  ? <><RefreshCw size={13} className="animate-spin" /> Actualizando…</>
                  : <><CheckCircle2 size={14} /> Sí, Reasignar</>}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Modal: Eliminar Sensor ────────────────────────────────────────── */}
      {deleteSensorModalOpen && editSensorId && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/75 backdrop-blur-sm">
          <div className="bg-slate-900 border border-red-900/60 rounded-xl shadow-2xl w-full max-w-md">

            <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800">
              <h3 className="text-sm font-semibold text-white flex items-center gap-2">
                <Trash2 size={16} className="text-red-500" /> Eliminar Sensor Permanentemente
              </h3>
              <button onClick={() => setDeleteSensorModalOpen(false)}
                className="text-slate-500 hover:text-slate-200 transition-colors"
              >
                <X size={18} />
              </button>
            </div>

            <div className="px-6 py-5 space-y-5">
              <div className="flex items-start gap-3 bg-red-950/50 border border-red-800/50 rounded-lg px-4 py-3">
                <TriangleAlert size={16} className="text-red-400 shrink-0 mt-0.5" />
                <p className="text-sm text-red-300 leading-relaxed">
                  <strong>Advertencia:</strong> El sensor{' '}
                  <span className="font-mono text-red-200">{editSensorId}</span>{' '}
                  será eliminado de la base de datos. Las lecturas históricas en MongoDB se
                  conservan como auditoría física.
                </p>
              </div>

              <div>
                <label className="field-label">
                  Escribe el ID del sensor físico para confirmar
                </label>
                <input
                  type="text"
                  placeholder={editSensorId}
                  value={deleteSensorConfirm}
                  onChange={e => setDeleteSensorConfirm(e.target.value)}
                  className="field font-mono focus:border-red-500 focus:ring-red-500/40"
                />
              </div>
            </div>

            <div className="flex items-center justify-end gap-3 px-6 pb-5">
              <button type="button" onClick={() => setDeleteSensorModalOpen(false)}
                className="btn btn-secondary"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={confirmDeleteSensor}
                disabled={sensorSubmitting || deleteSensorConfirm !== editSensorId}
                className="btn btn-danger"
              >
                {sensorSubmitting
                  ? <><RefreshCw size={13} className="animate-spin" /> Eliminando…</>
                  : <><Trash2 size={13} /> Eliminar Definitivamente</>}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Modal: Herencia de huérfanos al registrar aula ───────────────── */}
      {orphanWarningOpen && orphanData && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
          <div className="bg-slate-900 border border-amber-700/60 rounded-xl shadow-2xl w-full max-w-lg">

            <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800">
              <h3 className="text-sm font-semibold text-white flex items-center gap-2">
                <TriangleAlert size={16} className="text-amber-400" /> Historial Persistente Detectado
              </h3>
              <button
                onClick={() => { setOrphanWarningOpen(false); setOrphanData(null) }}
                className="text-slate-500 hover:text-slate-200 transition-colors"
              >
                <X size={18} />
              </button>
            </div>

            <div className="px-6 py-5 space-y-5">

              <div className="bg-amber-950/40 border border-amber-700/50 rounded-lg px-4 py-4 space-y-2">
                <p className="text-sm text-amber-200 leading-relaxed">
                  <span className="font-semibold text-amber-300">⚠ ATENCIÓN:</span>{' '}
                  El ID de aula{' '}
                  <span className="font-mono text-white bg-slate-800 px-1.5 py-0.5 rounded text-xs">{regRoomForm.id.trim()}</span>{' '}
                  cuenta con historial persistente en el sistema.
                </p>
                <div className="flex gap-4 pt-1">
                  <div className="flex items-center gap-2 text-sm">
                    <span className="font-semibold text-amber-300">{orphanData.reservations_count}</span>
                    <span className="text-amber-200/70">reserva{orphanData.reservations_count !== 1 ? 's' : ''} huérfana{orphanData.reservations_count !== 1 ? 's' : ''}</span>
                  </div>
                  <div className="flex items-center gap-2 text-sm">
                    <span className="font-semibold text-amber-300">{orphanData.sensors_count}</span>
                    <span className="text-amber-200/70">sensor{orphanData.sensors_count !== 1 ? 'es' : ''} huérfano{orphanData.sensors_count !== 1 ? 's' : ''}</span>
                  </div>
                </div>
                <p className="text-xs text-amber-300/70 leading-relaxed pt-1">
                  Si continúas, estos elementos se vincularán automáticamente al aula nueva al compartir el mismo ID.
                </p>
              </div>

              <div>
                <label className="field-label">
                  Escribe el ID del aula para confirmar la re-asociación o modifica el ID en el formulario anterior para evitarlo
                </label>
                <input
                  type="text"
                  placeholder={regRoomForm.id.trim()}
                  value={orphanConfirm}
                  onChange={e => setOrphanConfirm(e.target.value)}
                  className="w-full bg-black border border-amber-700/50 rounded-lg px-3 py-2.5 text-sm text-slate-100 focus:outline-none focus:border-amber-500 focus:ring-1 focus:ring-amber-500/40 transition placeholder-slate-600 font-mono"
                  autoFocus
                />
              </div>

            </div>

            <div className="flex items-center justify-end gap-3 px-6 pb-5">
              <button
                type="button"
                onClick={() => { setOrphanWarningOpen(false); setOrphanData(null) }}
                className="btn btn-secondary"
              >
                Cancelar — modificar ID
              </button>
              <button
                type="button"
                onClick={confirmOrphanInheritance}
                disabled={orphanConfirm !== regRoomForm.id.trim() || roomSubmitting}
                className="flex items-center gap-2 px-5 py-2 text-sm font-semibold text-white bg-amber-600 hover:bg-amber-500 disabled:bg-slate-700 disabled:text-slate-500 disabled:cursor-not-allowed rounded-lg transition-colors"
              >
                {roomSubmitting
                  ? <><RefreshCw size={13} className="animate-spin" /> Creando…</>
                  : <><CheckCircle2 size={14} /> Aceptar y Enlazar</>}
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  )
}
