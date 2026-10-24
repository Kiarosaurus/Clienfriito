import { useState, useEffect, useCallback } from 'react'
import {
  CalendarDays, RefreshCw, AlertCircle, Users,
  Clock, CheckCircle2, PlusCircle, X, Pencil,
  Calendar, DoorOpen, Trash2, TriangleAlert,
} from 'lucide-react'
import api, { getApiErrorDetail } from '../api/client'
import { NUM_INPUT_MODS } from '../utils/formStyles'
import SearchableSelect from '../components/SearchableSelect'

interface Room { id: number; name: string; max_capacity: number }

interface Reservation {
  id: number
  room_id: number
  room_name?: string
  user_id: number
  username?: string
  start_time: string
  end_time: string
  expected_occupancy: number
}

interface Toast { type: 'success' | 'error'; message: string }

type Tab = 'new' | 'edit'

interface EditPayload {
  room_id: string
  start_time: string
  end_time: string
  expected_occupancy: number
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatDt(iso: string) {
  return new Date(iso).toLocaleString('es', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}

function toLocalInputValue(date: Date) {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function nowPlus(minutes: number) {
  const d = new Date()
  d.setMinutes(d.getMinutes() + minutes)
  return d
}

function reservationLabel(r: Reservation, rooms: Room[]) {
  const room = rooms.find(rm => String(rm.id) === String(r.room_id))
  const name = r.room_name ?? room?.name ?? `Aula ${r.room_id}`
  const cap = room?.max_capacity ?? 0
  const d = new Date(r.start_time)
  const pad = (n: number) => String(n).padStart(2, '0')
  const h = d.getHours()
  const ampm = h >= 12 ? 'PM' : 'AM'
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  return `${name} (Capacidad: ${cap}) - ${date} ${pad(h % 12 || 12)}:${pad(d.getMinutes())} ${ampm}`
}

// ── Sub-components ────────────────────────────────────────────────────────────

function DataRow({ label, value, changed }: { label: string; value: string; changed?: boolean }) {
  return (
    <div>
      <p className="text-xs text-slate-500 mb-0.5">{label}</p>
      <p className={`text-sm font-medium ${changed ? 'text-amber-300' : 'text-slate-200'}`}>
        {value}
        {changed && <span className="ml-1.5 text-xs bg-amber-500/20 text-amber-400 px-1 py-0.5 rounded">modificado</span>}
      </p>
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export default function Reservations() {
  const [rooms, setRooms] = useState<Room[]>([])
  const [reservations, setReservations] = useState<Reservation[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [toast, setToast] = useState<Toast | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [activeTab, setActiveTab] = useState<Tab>('new')
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [isModalOpen, setIsModalOpen] = useState(false)
  const [pendingEditData, setPendingEditData] = useState<{
    payload: EditPayload
    original: Reservation
  } | null>(null)

  const [deleteModalOpen, setDeleteModalOpen] = useState(false)
  const [deleteConfirm,   setDeleteConfirm]   = useState('')

  const [form, setForm] = useState({
    room_id: '',
    start_time: toLocalInputValue(nowPlus(5)),
    end_time: toLocalInputValue(nowPlus(65)),
    expected_occupancy: '1',
  })

  const showToast = (type: Toast['type'], message: string) => {
    setToast({ type, message })
    setTimeout(() => setToast(null), 4000)
  }

  const fetchReservations = useCallback(() => {
    api.get<Reservation[]>('/admin/reservations')
      .then(res => setReservations(Array.isArray(res.data) ? res.data : []))
      .catch(err => setError(getApiErrorDetail(err) ?? 'Error cargando reservas.'))
  }, [])

  useEffect(() => {
    Promise.all([
      api.get<Room[]>('/admin/rooms'),
      api.get<Reservation[]>('/admin/reservations'),
    ])
      .then(([roomsRes, resRes]) => {
        setRooms(Array.isArray(roomsRes.data) ? roomsRes.data : [])
        setReservations(Array.isArray(resRes.data) ? resRes.data : [])
        if (roomsRes.data.length > 0) {
          setForm(f => ({ ...f, room_id: String(roomsRes.data[0].id) }))
        }
      })
      .catch(err => setError(getApiErrorDetail(err) ?? 'Error cargando datos.'))
      .finally(() => setLoading(false))
  }, [])

  // ── Derived state ─────────────────────────────────────────────────────────

  const safeReservations = Array.isArray(reservations) ? reservations : []
  const now = Date.now()
  const upcoming = safeReservations.filter(r => r?.end_time && new Date(r.end_time).getTime() > now)
  const past = safeReservations.filter(r => r?.end_time && new Date(r.end_time).getTime() <= now)

  const reservationOptions = safeReservations.map(r => ({
    value: String(r.id),
    label: reservationLabel(r, rooms),
  }))

  const roomOptions = rooms.map(r => ({
    value: String(r.id),
    label: `${r.name} — capacidad ${r.max_capacity}`,
  }))

  // ── Handlers ──────────────────────────────────────────────────────────────

  function switchTab(tab: Tab) {
    setActiveTab(tab)
    if (tab === 'new') {
      setSelectedId(null)
      setForm({
        room_id: rooms.length > 0 ? String(rooms[0].id) : '',
        start_time: toLocalInputValue(nowPlus(5)),
        end_time: toLocalInputValue(nowPlus(65)),
        expected_occupancy: '1',
      })
    }
  }

  function handleReservationSelect(val: string) {
    if (!val) {
      setSelectedId(null)
      return
    }
    const r = safeReservations.find(r => String(r.id) === val)
    if (!r) return
    setSelectedId(r.id)
    setForm({
      room_id: String(r.room_id),
      start_time: toLocalInputValue(new Date(r.start_time)),
      end_time: toLocalInputValue(new Date(r.end_time)),
      expected_occupancy: String(r.expected_occupancy),
    })
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!form.room_id) return
    if (activeTab === 'edit' && !selectedId) return

    // Send naive local wall-clock (America/Lima) — the backend stores these
    // verbatim. Converting to UTC (.toISOString()) here used to shift every
    // reservation +5 h.
    const toNaiveLocal = (local: string) => (local.length === 16 ? `${local}:00` : local)
    const payload: EditPayload = {
      room_id: String(form.room_id),
      start_time: toNaiveLocal(form.start_time),
      end_time: toNaiveLocal(form.end_time),
      expected_occupancy: Number(form.expected_occupancy),
    }

    if (activeTab === 'edit') {
      const original = safeReservations.find(r => r.id === selectedId)
      if (!original) return
      setPendingEditData({ payload, original })
      setIsModalOpen(true)
      return
    }

    // POST — create new reservation
    setSubmitting(true)
    try {
      await api.post('/admin/reservations', payload)
      showToast('success', 'Reserva creada correctamente.')
      setForm(f => ({
        ...f,
        start_time: toLocalInputValue(nowPlus(5)),
        end_time: toLocalInputValue(nowPlus(65)),
        expected_occupancy: '1',
      }))
      fetchReservations()
    } catch (err: unknown) {
      console.error('[Reservations] create error:', err)
      const detail = getApiErrorDetail(err)
      showToast('error', detail ?? 'No se pudo crear la reserva.')
    } finally {
      setSubmitting(false)
    }
  }

  async function confirmEdit() {
    if (!pendingEditData || !selectedId) return
    setSubmitting(true)
    setIsModalOpen(false)
    try {
      await api.put(`/admin/reservations/${selectedId}`, pendingEditData.payload)
      showToast('success', 'Reserva actualizada correctamente.')
      fetchReservations()
      setPendingEditData(null)
    } catch (err: unknown) {
      console.error('[Reservations] update error:', err)
      const detail = getApiErrorDetail(err)
      showToast('error', detail ?? 'No se pudo actualizar la reserva.')
    } finally {
      setSubmitting(false)
    }
  }

  async function confirmDelete() {
    if (!selectedId || deleteConfirm !== String(selectedId)) return
    setSubmitting(true)
    setDeleteModalOpen(false)
    try {
      await api.delete(`/admin/reservations/${selectedId}`)
      showToast('success', `Reserva #${selectedId} eliminada definitivamente.`)
      setSelectedId(null)
      setDeleteConfirm('')
      setForm({
        room_id: rooms.length > 0 ? String(rooms[0].id) : '',
        start_time: toLocalInputValue(nowPlus(5)),
        end_time: toLocalInputValue(nowPlus(65)),
        expected_occupancy: '1',
      })
      fetchReservations()
    } catch (err: unknown) {
      const detail = getApiErrorDetail(err)
      showToast('error', detail ?? 'No se pudo eliminar la reserva.')
    } finally {
      setSubmitting(false)
    }
  }

  // ── Shared style tokens ───────────────────────────────────────────────────

  const inputCls = "w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2.5 text-sm text-slate-100 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500/50 transition placeholder-slate-500"
  const numInputCls = `${inputCls} ${NUM_INPUT_MODS}`
  const labelCls = "block text-xs font-medium text-slate-400 mb-1.5 uppercase tracking-wide"

  const TABS: { key: Tab; label: string; icon: React.ReactNode }[] = [
    { key: 'new',  label: 'Nueva Reserva',  icon: <PlusCircle size={14} /> },
    { key: 'edit', label: 'Editar Reserva', icon: <Pencil size={14} /> },
  ]

  // ── Section component ─────────────────────────────────────────────────────

  function Section({ title, items }: { title: string; items: Reservation[] }) {
    return (
      <div>
        <h2 className="text-sm font-semibold text-slate-400 uppercase tracking-wide mb-3">
          {title} <span className="text-slate-600">({items.length})</span>
        </h2>
        {items.length === 0 ? (
          <p className="text-slate-500 text-sm py-4 text-center bg-slate-800 rounded-xl border border-slate-700">Sin reservas</p>
        ) : (
          <div className="bg-slate-800 rounded-xl overflow-x-auto border border-slate-700">
            <table className="w-full min-w-[560px] text-sm">
              <thead>
                <tr className="text-slate-400 text-xs uppercase border-b border-slate-700 bg-slate-800/80">
                  {['Aula', 'Usuario', 'Inicio', 'Fin', 'Ocupantes'].map(h => (
                    <th key={h} className="text-left px-4 py-3">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {items.map(r => {
                  const active = new Date(r.start_time).getTime() <= now && new Date(r.end_time).getTime() > now
                  return (
                    <tr key={r.id} className={`border-b border-slate-700/50 last:border-0 ${active ? 'bg-blue-900/10' : ''}`}>
                      <td className="px-4 py-3 font-medium text-slate-200">
                        {r.room_name ?? `Aula ${r.room_id}`}
                        {active && (
                          <span className="ml-2 text-xs bg-blue-600/30 text-blue-300 px-1.5 py-0.5 rounded-full">
                            En curso
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-slate-300 text-xs">{r.username ?? `#${r.user_id}`}</td>
                      <td className="px-4 py-3 text-slate-400 text-xs">
                        <span className="flex items-center gap-1"><Clock size={11} />{formatDt(r.start_time)}</span>
                      </td>
                      <td className="px-4 py-3 text-slate-400 text-xs">{formatDt(r.end_time)}</td>
                      <td className="px-4 py-3">
                        <span className="flex items-center gap-1 text-slate-300 text-xs">
                          <Users size={11} />{r.expected_occupancy}
                        </span>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    )
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <CalendarDays size={22} className="text-blue-400" />
        <div>
          <h1 className="text-xl font-bold text-white">Reservas</h1>
          <p className="text-sm text-slate-400">Gestión de reservas de aulas</p>
        </div>
      </div>

      {/* Toast */}
      {toast && (
        <div className={`flex items-center justify-between gap-3 rounded-xl px-4 py-3 text-sm ${
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

      {/* Global error */}
      {error && (
        <div className="flex items-center gap-2 bg-red-900/30 border border-red-500/40 rounded-lg px-4 py-3 text-sm text-red-300">
          <AlertCircle size={16} className="shrink-0" /> {error}
        </div>
      )}

      {/* Form card */}
      <div className="bg-slate-800 border border-slate-700 rounded-xl p-6">

        {/* Tabs */}
        <div className="flex gap-1 bg-slate-900/50 border border-slate-700/60 rounded-xl p-1 w-fit mb-6">
          {TABS.map(t => (
            <button
              key={t.key}
              type="button"
              onClick={() => switchTab(t.key)}
              className={`flex items-center gap-2 px-4 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                activeTab === t.key
                  ? 'bg-blue-600 text-white shadow'
                  : 'text-slate-400 hover:text-slate-100'
              }`}
            >
              {t.icon} {t.label}
            </button>
          ))}
        </div>

        {loading ? (
          <div className="flex items-center gap-2 text-slate-400 text-sm py-4">
            <RefreshCw size={14} className="animate-spin" /> Cargando datos…
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">

            {/* Edit mode — reservation search */}
            {activeTab === 'edit' && (
              <div>
                <SearchableSelect
                  options={reservationOptions}
                  value={String(selectedId ?? '')}
                  onChange={handleReservationSelect}
                  placeholder="Escribe aula o fecha para buscar…"
                  label="Buscar reserva"
                  icon={<Calendar size={16} />}
                />
                {selectedId ? (
                  <p className="text-xs text-emerald-400 mt-1.5 flex items-center gap-1">
                    <CheckCircle2 size={11} /> Reserva #{selectedId} cargada — modifica los campos y confirma.
                  </p>
                ) : (
                  <p className="text-xs text-slate-500 mt-1.5">
                    Selecciona una reserva existente para editar sus datos.
                  </p>
                )}
              </div>
            )}

            {/* Shared form fields */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="md:col-span-2">
                <SearchableSelect
                  options={roomOptions}
                  value={form.room_id}
                  onChange={v => setForm(f => ({ ...f, room_id: v }))}
                  placeholder="Selecciona un aula…"
                  label="Aula"
                  icon={<DoorOpen size={16} />}
                />
              </div>

              <div>
                <label className={labelCls}>Inicio</label>
                <input
                  type="datetime-local"
                  required
                  value={form.start_time}
                  onChange={e => setForm(f => ({ ...f, start_time: e.target.value }))}
                  className={inputCls}
                />
              </div>

              <div>
                <label className={labelCls}>Fin</label>
                <input
                  type="datetime-local"
                  required
                  value={form.end_time}
                  min={form.start_time}
                  onChange={e => setForm(f => ({ ...f, end_time: e.target.value }))}
                  className={inputCls}
                />
              </div>

              <div>
                <label className={labelCls}>Ocupantes esperados</label>
                <input
                  type="number"
                  required
                  min={1}
                  max={(Array.isArray(rooms) ? rooms : []).find(r => String(r.id) === String(form.room_id))?.max_capacity ?? 999}
                  value={form.expected_occupancy}
                  onChange={e => setForm(f => ({ ...f, expected_occupancy: e.target.value }))}
                  onBlur={e => setForm(f => ({ ...f, expected_occupancy: e.target.value === '' ? '1' : e.target.value }))}
                  className={numInputCls}
                />
              </div>
            </div>

            {/* Submit + delete row */}
            <div className="flex items-center justify-between pt-1">
              {activeTab === 'edit' && selectedId ? (
                <button
                  type="button"
                  onClick={() => { setDeleteConfirm(''); setDeleteModalOpen(true) }}
                  className="flex items-center gap-1.5 text-sm text-red-500 hover:bg-red-500/10 px-3 py-2 rounded-lg transition-colors"
                >
                  <Trash2 size={13} /> Eliminar reserva
                </button>
              ) : <span />}
              <button
                type="submit"
                disabled={submitting || !form.room_id || (activeTab === 'edit' && !selectedId)}
                className="flex items-center gap-2 bg-blue-600 hover:bg-blue-500 disabled:bg-slate-600 disabled:cursor-not-allowed text-white font-semibold text-sm px-6 py-2.5 rounded-lg transition-colors"
              >
                {submitting ? (
                  <><RefreshCw size={14} className="animate-spin" /> {activeTab === 'new' ? 'Guardando…' : 'Actualizando…'}</>
                ) : activeTab === 'new' ? (
                  <><PlusCircle size={14} /> Crear reserva</>
                ) : (
                  <><Pencil size={14} /> Revisar y actualizar</>
                )}
              </button>
            </div>
          </form>
        )}
      </div>

      {/* ── Confirmation modal ────────────────────────────────────────────── */}
      {isModalOpen && pendingEditData && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
          <div className="bg-slate-800 border border-slate-700 rounded-2xl shadow-2xl w-full max-w-2xl">

            {/* Modal header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-slate-700">
              <h3 className="text-base font-semibold text-white flex items-center gap-2">
                <Pencil size={16} className="text-blue-400" />
                Confirmar Actualización de Reserva
              </h3>
              <button
                onClick={() => setIsModalOpen(false)}
                className="text-slate-400 hover:text-slate-100 transition-colors"
              >
                <X size={18} />
              </button>
            </div>

            {/* Before / After columns */}
            <div className="p-6 grid grid-cols-1 sm:grid-cols-2 gap-4">

              {/* Left — Datos Actuales */}
              <div className="bg-slate-700/40 border border-slate-600/50 rounded-xl p-4 space-y-4">
                <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-slate-500 inline-block" />
                  Datos Actuales
                </p>
                <DataRow
                  label="Aula"
                  value={pendingEditData.original.room_name ?? `Aula ${pendingEditData.original.room_id}`}
                />
                <DataRow label="Inicio" value={formatDt(pendingEditData.original.start_time)} />
                <DataRow label="Fin" value={formatDt(pendingEditData.original.end_time)} />
                <DataRow label="Ocupantes" value={String(pendingEditData.original.expected_occupancy)} />
              </div>

              {/* Right — Nuevos Datos */}
              <div className="bg-blue-900/20 border border-blue-500/30 rounded-xl p-4 space-y-4">
                <p className="text-xs font-semibold text-blue-400 uppercase tracking-wide flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-blue-400 inline-block" />
                  Nuevos Datos
                </p>
                <DataRow
                  label="Aula"
                  value={
                    rooms.find(r => String(r.id) === String(pendingEditData.payload.room_id))?.name
                    ?? `Aula ${pendingEditData.payload.room_id}`
                  }
                  changed={String(pendingEditData.payload.room_id) !== String(pendingEditData.original.room_id)}
                />
                <DataRow
                  label="Inicio"
                  value={formatDt(pendingEditData.payload.start_time)}
                  changed={pendingEditData.payload.start_time.slice(0, 16) !== pendingEditData.original.start_time.slice(0, 16)}
                />
                <DataRow
                  label="Fin"
                  value={formatDt(pendingEditData.payload.end_time)}
                  changed={pendingEditData.payload.end_time.slice(0, 16) !== pendingEditData.original.end_time.slice(0, 16)}
                />
                <DataRow
                  label="Ocupantes"
                  value={String(pendingEditData.payload.expected_occupancy)}
                  changed={pendingEditData.payload.expected_occupancy !== pendingEditData.original.expected_occupancy}
                />
              </div>
            </div>

            {/* Modal footer */}
            <div className="flex items-center justify-end gap-3 px-6 pb-5">
              <button
                type="button"
                onClick={() => setIsModalOpen(false)}
                className="px-4 py-2 text-sm font-medium text-slate-300 bg-slate-700 hover:bg-slate-600 rounded-lg transition-colors"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={confirmEdit}
                disabled={submitting}
                className="flex items-center gap-2 px-5 py-2 text-sm font-semibold text-white bg-blue-600 hover:bg-blue-500 disabled:bg-slate-600 disabled:cursor-not-allowed rounded-lg transition-colors"
              >
                {submitting
                  ? <><RefreshCw size={13} className="animate-spin" /> Actualizando…</>
                  : <><CheckCircle2 size={14} /> Sí, Actualizar</>}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Modal: Eliminar Reserva ───────────────────────────────────────── */}
      {deleteModalOpen && selectedId && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/75 backdrop-blur-sm">
          <div className="bg-slate-900 border border-red-900/60 rounded-2xl shadow-2xl w-full max-w-md">

            <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800">
              <h3 className="text-base font-semibold text-white flex items-center gap-2">
                <Trash2 size={16} className="text-red-500" /> Eliminar Reserva Permanentemente
              </h3>
              <button onClick={() => setDeleteModalOpen(false)}
                className="text-slate-500 hover:text-slate-200 transition-colors"
              >
                <X size={18} />
              </button>
            </div>

            <div className="px-6 py-5 space-y-5">
              <div className="flex items-start gap-3 bg-red-950/50 border border-red-800/50 rounded-xl px-4 py-3">
                <TriangleAlert size={16} className="text-red-400 shrink-0 mt-0.5" />
                <p className="text-sm text-red-300 leading-relaxed">
                  ¿Está seguro de que desea eliminar esta reserva?{' '}
                  <strong>Esta acción es irreversible.</strong>
                </p>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-400 mb-1.5 uppercase tracking-wide">
                  Escriba el ID de la reserva para confirmar
                </label>
                <input
                  type="text"
                  placeholder={String(selectedId)}
                  value={deleteConfirm}
                  onChange={e => setDeleteConfirm(e.target.value)}
                  className="w-full bg-black border border-slate-700 rounded-lg px-3 py-2.5 text-sm text-slate-100 focus:outline-none focus:border-red-500 focus:ring-1 focus:ring-red-500/50 transition placeholder-slate-600 font-mono"
                />
              </div>
            </div>

            <div className="flex items-center justify-end gap-3 px-6 pb-5">
              <button type="button" onClick={() => setDeleteModalOpen(false)}
                className="px-4 py-2 text-sm font-medium text-slate-300 bg-slate-800 hover:bg-slate-700 rounded-lg transition-colors border border-slate-700"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={confirmDelete}
                disabled={submitting || deleteConfirm !== String(selectedId)}
                className="flex items-center gap-2 px-5 py-2 text-sm font-semibold text-white bg-red-700 hover:bg-red-600 disabled:bg-slate-700 disabled:text-slate-500 disabled:cursor-not-allowed rounded-lg transition-colors"
              >
                {submitting
                  ? <><RefreshCw size={13} className="animate-spin" /> Eliminando…</>
                  : <><Trash2 size={13} /> Eliminar Definitivamente</>}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Reservation lists */}
      {!loading && (
        <>
          <Section title="Próximas / Activas" items={upcoming} />
          <Section title="Pasadas" items={past} />
        </>
      )}
    </div>
  )
}
