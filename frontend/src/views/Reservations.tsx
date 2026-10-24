import { useState, useEffect, useCallback, useMemo, type MouseEvent } from 'react'
import { useSearchParams } from 'react-router-dom'
import { ChevronLeft, ChevronRight, Plus, Trash2, RefreshCw, AlertTriangle, CheckCircle2, AlertCircle, X, Search } from 'lucide-react'
import api, { getApiErrorDetail } from '../api/client'
import { useAuth } from '../context/AuthContext'
import { NUM_INPUT_MODS } from '../utils/formStyles'
import {
  buildingLabel, buildingsOf, compareRooms, floorLabel, locationLabel, matchesQuery, roomOptions, shortName, type Room,
} from '../utils/rooms'
import { RoomFilters, useRoomFilter } from '../components/RoomFilters'
import SearchableSelect from '../components/SearchableSelect'
import { Card, Chip, Dialog, PageHeader, Pagination, Tabs, usePage } from '../components/ui'

// Reservations are organised around the user's task, and scale to 100+ rooms (rule 11):
// · "Buscar aula": state the need (date, time, people) → only rooms that are free and fit.
// · "Agenda": the familiar day grid, but for one floor at a time.
// · "Reservas": mine / all, searchable and paged, grouped by day.

interface Reservation {
  id: number
  room_id: string
  room_name?: string
  user_id: number
  username?: string
  start_time: string   // naive local wall-clock (America/Lima), stored verbatim by the backend
  end_time: string
  expected_occupancy: number
}

interface FormState { id: number | null; room_id: string; date: string; start: string; end: string; people: string }
type View = 'buscar' | 'agenda' | 'reservas'

const DAY_START = 7    // bookable window, local hours
const DAY_END = 22
const STEP_MIN = 30
const TIMES = Array.from({ length: ((DAY_END - DAY_START) * 60) / STEP_MIN + 1 }, (_, i) => {
  const m = DAY_START * 60 + i * STEP_MIN
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
})
const HOURS = Array.from({ length: DAY_END - DAY_START }, (_, i) => DAY_START + i)

// ── Date helpers (local wall-clock time) ──────────────────────────────────────
const pad = (n: number) => String(n).padStart(2, '0')
const dateKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const hhmm = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`
const at = (date: string, time: string) => new Date(`${date}T${time}:00`)
const addDays = (date: string, n: number) => { const d = new Date(`${date}T00:00:00`); d.setDate(d.getDate() + n); return dateKey(d) }
const minutesOf = (d: Date) => d.getHours() * 60 + d.getMinutes()
const shortRange = (s: Date, e: Date) => {
  const f = (d: Date) => (d.getMinutes() ? `${d.getHours()}:${pad(d.getMinutes())}` : `${d.getHours()}`)
  return `${f(s)}–${f(e)} h`
}

function longDate(date: string) {
  const s = new Date(`${date}T00:00:00`).toLocaleDateString('es', { weekday: 'long', day: 'numeric', month: 'long' })
  return s.charAt(0).toUpperCase() + s.slice(1)
}
function dayLabel(date: string, today: string) {
  if (date === today) return 'Hoy'
  if (date === addDays(today, 1)) return 'Mañana'
  if (date === addDays(today, -1)) return 'Ayer'
  return longDate(date)
}

// Next half hour from now, inside the bookable window.
function nextSlot(): { date: string; start: string; end: string } {
  const d = new Date()
  const m = Math.ceil((minutesOf(d) + 1) / STEP_MIN) * STEP_MIN
  if (m < DAY_START * 60 || m + 60 > DAY_END * 60) {
    const date = m < DAY_START * 60 ? dateKey(d) : addDays(dateKey(d), 1)
    return { date, start: `${pad(DAY_START + 1)}:00`, end: `${pad(DAY_START + 2)}:00` }
  }
  const t = (x: number) => `${pad(Math.floor(x / 60))}:${pad(x % 60)}`
  return { date: dateKey(d), start: t(m), end: t(m + 60) }
}

const overlaps = (r: Reservation, s: number, e: number) =>
  new Date(r.start_time).getTime() < e && new Date(r.end_time).getTime() > s

// Backend errors come in English; show the actionable ones in Spanish.
function friendlyError(err: unknown, fallback: string) {
  const status = (err as { response?: { status?: number } })?.response?.status
  if (status === 409) return 'El aula ya está reservada en ese horario.'
  if (status === 400) return 'La hora de fin debe ser posterior a la de inicio.'
  if (status === 403) return 'Tu rol no puede gestionar reservas.'
  return getApiErrorDetail(err) ?? fallback
}

function TimeSelect({ value, onChange, from, label }: { value: string; onChange: (v: string) => void; from?: string; label: string }) {
  return (
    <label className="block">
      <span className="field-label">{label}</span>
      <select className="field tabular-nums" value={value} onChange={e => onChange(e.target.value)}>
        {(from ? TIMES.slice(1) : TIMES.slice(0, -1)).map(t => <option key={t} disabled={!!from && t <= from}>{t}</option>)}
      </select>
    </label>
  )
}

// ── View ──────────────────────────────────────────────────────────────────────
export default function Reservations() {
  const { user } = useAuth()
  const [params, setParams] = useSearchParams()
  const view = (params.get('vista') as View) || 'buscar'
  const setView = (v: View) => setParams(v === 'buscar' ? {} : { vista: v }, { replace: true })

  const [rooms, setRooms] = useState<Room[]>([])
  const [reservations, setReservations] = useState<Reservation[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [toast, setToast] = useState<{ type: 'ok' | 'error'; text: string } | null>(null)
  const [form, setForm] = useState<FormState | null>(null)
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [toDelete, setToDelete] = useState<Reservation | null>(null)
  const [now, setNow] = useState(Date.now())
  const today = dateKey(new Date(now))

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(t)
  }, [])

  const notify = (type: 'ok' | 'error', text: string) => {
    setToast({ type, text })
    setTimeout(() => setToast(null), 4000)
  }

  const load = useCallback(() => Promise.all([
    api.get<Room[]>('/admin/rooms'),
    api.get<Reservation[]>('/admin/reservations'),
  ])
    .then(([r, res]) => {
      setRooms(Array.isArray(r.data) ? r.data : [])
      setReservations(Array.isArray(res.data) ? res.data : [])
      setError(null)
    })
    .catch(err => setError(getApiErrorDetail(err) ?? 'No se pudieron cargar las reservas.'))
    .finally(() => setLoading(false)), [])

  useEffect(() => { load() }, [load])

  const roomById = useMemo(() => Object.fromEntries(rooms.map(r => [String(r.id), r])), [rooms])

  // ── Create / edit ───────────────────────────────────────────────────────────
  function openNew(preset?: Partial<FormState>) {
    const slot = nextSlot()
    setFormError(null)
    setForm({ id: null, room_id: '', date: slot.date, start: slot.start, end: slot.end, people: '1', ...preset })
  }

  function openEdit(r: Reservation) {
    const s = new Date(r.start_time), e = new Date(r.end_time)
    setFormError(null)
    setForm({ id: r.id, room_id: String(r.room_id), date: dateKey(s), start: hhmm(s), end: hhmm(e), people: String(r.expected_occupancy) })
  }

  const capacity = form ? roomById[form.room_id]?.max_capacity : undefined
  const conflict = form && form.room_id ? reservations.find(r =>
    String(r.room_id) === form.room_id && r.id !== form.id &&
    overlaps(r, at(form.date, form.start).getTime(), at(form.date, form.end).getTime()),
  ) : undefined
  const problems: string[] = []
  if (form) {
    if (!form.room_id) problems.push('Elige un aula.')
    if (form.end <= form.start) problems.push('La hora de fin debe ser posterior a la de inicio.')
    const n = Number(form.people)
    if (!n || n < 1) problems.push('Indica cuántas personas asistirán.')
    else if (capacity && n > capacity) problems.push(`El aula admite como máximo ${capacity} personas.`)
    if (conflict) {
      problems.push(`Choca con la reserva de ${conflict.username ?? 'otro usuario'} de ${hhmm(new Date(conflict.start_time))} a ${hhmm(new Date(conflict.end_time))}.`)
    }
  }
  const startsInPast = form && form.id === null && at(form.date, form.start).getTime() < now

  async function save() {
    if (!form || problems.length) return
    setSaving(true); setFormError(null)
    const payload = {
      room_id: form.room_id,
      start_time: `${form.date}T${form.start}:00`,
      end_time: `${form.date}T${form.end}:00`,
      expected_occupancy: Number(form.people),
    }
    try {
      if (form.id === null) await api.post('/admin/reservations', payload)
      else await api.put(`/admin/reservations/${form.id}`, payload)
      notify('ok', form.id === null ? `Reserva creada: ${form.room_id}, ${dayLabel(form.date, today).toLowerCase()} ${form.start}–${form.end}.` : 'Cambios guardados.')
      setForm(null)
      load()
    } catch (err) {
      setFormError(friendlyError(err, 'No se pudo guardar la reserva.'))
    } finally { setSaving(false) }
  }

  async function remove() {
    if (!toDelete) return
    setSaving(true)
    try {
      await api.delete(`/admin/reservations/${toDelete.id}`)
      notify('ok', 'Reserva eliminada.')
      setToDelete(null)
      setForm(null)
      load()
    } catch (err) {
      notify('error', friendlyError(err, 'No se pudo eliminar la reserva.'))
    } finally { setSaving(false) }
  }

  const options = useMemo(() => roomOptions(rooms), [rooms])

  return (
    <div className="space-y-4">
      <PageHeader title="Reservas" subtitle="Busca un aula libre para tu clase o revisa las reservas existentes.">
        <button className="btn btn-primary" onClick={() => openNew()} disabled={loading || rooms.length === 0}>
          <Plus size={16} /> Nueva reserva
        </button>
      </PageHeader>

      {error && <Card className="border-red-500/40 text-sm text-red-300">{error}</Card>}

      <Tabs<View>
        value={view}
        onChange={setView}
        items={[
          { value: 'buscar', label: 'Buscar aula' },
          { value: 'agenda', label: 'Agenda por piso' },
          { value: 'reservas', label: 'Reservas' },
        ]}
      />

      {loading ? (
        <p className="flex items-center gap-2 py-8 text-sm text-slate-400"><RefreshCw size={14} className="animate-spin" /> Cargando…</p>
      ) : view === 'buscar' ? (
        <FindRoom rooms={rooms} reservations={reservations} onBook={p => openNew(p)} />
      ) : view === 'agenda' ? (
        <Agenda rooms={rooms} reservations={reservations} now={now} today={today} onNew={openNew} onOpen={openEdit} />
      ) : (
        <ReservationsTab
          reservations={reservations} rooms={roomById} username={user?.username ?? ''}
          now={now} today={today} onOpen={openEdit} onDelete={setToDelete}
        />
      )}

      {/* ── Create / edit dialog ── */}
      {form && (
        <Dialog
          title={form.id === null ? 'Nueva reserva' : 'Editar reserva'}
          onClose={() => setForm(null)}
          footer={<>
            {form.id !== null && (
              <button className="btn btn-ghost text-red-300 hover:text-red-200" onClick={() => setToDelete(reservations.find(r => r.id === form.id) ?? null)}>
                <Trash2 size={14} /> Eliminar
              </button>
            )}
            <span className="flex-1" />
            <button className="btn btn-secondary" onClick={() => setForm(null)}>Cancelar</button>
            <button className="btn btn-primary" onClick={save} disabled={saving || problems.length > 0}>
              {saving && <RefreshCw size={14} className="animate-spin" />}
              {form.id === null ? 'Reservar' : 'Guardar cambios'}
            </button>
          </>}
        >
          <form className="grid grid-cols-2 gap-3" onSubmit={e => { e.preventDefault(); save() }}>
            <div className="col-span-2">
              <SearchableSelect
                label="Aula"
                options={options}
                value={form.room_id}
                onChange={v => setForm({ ...form, room_id: v })}
                placeholder="Busca por código, nombre o edificio…"
                maxVisibleItems={7}
              />
            </div>
            <label className="col-span-2 block">
              <span className="field-label">Fecha</span>
              <input type="date" className="field" value={form.date} onChange={e => e.target.value && setForm({ ...form, date: e.target.value })} required />
            </label>
            <TimeSelect label="Desde" value={form.start} onChange={start => {
              // Moving the start keeps the same duration.
              const steps = Math.max(1, TIMES.indexOf(form.end) - TIMES.indexOf(form.start))
              setForm({ ...form, start, end: TIMES[Math.min(TIMES.indexOf(start) + steps, TIMES.length - 1)] })
            }} />
            <TimeSelect label="Hasta" value={form.end} from={form.start} onChange={end => setForm({ ...form, end })} />
            <label className="col-span-2 block">
              <span className="field-label">Personas esperadas</span>
              <input
                type="number" min={1} max={capacity} className={`field ${NUM_INPUT_MODS}`}
                value={form.people} onChange={e => setForm({ ...form, people: e.target.value })}
              />
              <span className="mt-1 block text-xs text-slate-500">
                {capacity ? `Capacidad del aula: ${capacity}. ` : ''}Se usa para pre-enfriar el aula antes de la clase.
              </span>
            </label>
            <button type="submit" className="hidden" />
          </form>

          <div className="mt-3 space-y-2">
            {problems.length === 0 && !formError && (
              <p className="flex items-center gap-2 text-xs text-emerald-300"><CheckCircle2 size={14} /> Horario disponible.</p>
            )}
            {problems.map(p => (
              <p key={p} className="flex items-start gap-2 text-xs text-red-300"><AlertCircle size={14} className="mt-px shrink-0" /> {p}</p>
            ))}
            {startsInPast && problems.length === 0 && (
              <p className="flex items-start gap-2 text-xs text-amber-300"><AlertTriangle size={14} className="mt-px shrink-0" /> La hora de inicio ya pasó.</p>
            )}
            {formError && <p className="flex items-start gap-2 text-xs text-red-300"><AlertCircle size={14} className="mt-px shrink-0" /> {formError}</p>}
          </div>
        </Dialog>
      )}

      {/* ── Delete confirmation ── */}
      {toDelete && (
        <Dialog
          size="sm"
          title="¿Eliminar reserva?"
          onClose={() => setToDelete(null)}
          footer={<>
            <span className="flex-1" />
            <button className="btn btn-secondary" onClick={() => setToDelete(null)}>Cancelar</button>
            <button className="btn btn-danger" onClick={remove} disabled={saving}>
              {saving && <RefreshCw size={14} className="animate-spin" />} Eliminar
            </button>
          </>}
        >
          <p className="text-sm text-slate-300">
            {toDelete.room_id} · {dayLabel(dateKey(new Date(toDelete.start_time)), today).toLowerCase()},{' '}
            {hhmm(new Date(toDelete.start_time))}–{hhmm(new Date(toDelete.end_time))}
            {toDelete.username && <> · {toDelete.username}</>}
          </p>
          <p className="mt-2 text-xs text-slate-400">Esta acción no se puede deshacer.</p>
        </Dialog>
      )}

      {toast && (
        <div className={`surface fixed bottom-6 left-1/2 z-[70] flex -translate-x-1/2 items-center gap-2 px-4 py-2 text-sm shadow-xl ${toast.type === 'ok' ? 'text-emerald-300' : 'text-red-300'}`}>
          {toast.type === 'ok' ? <CheckCircle2 size={16} /> : <AlertCircle size={16} />}
          {toast.text}
          <button className="btn btn-ghost -mr-2 px-1.5 py-1" onClick={() => setToast(null)} aria-label="Cerrar"><X size={14} /></button>
        </div>
      )}
    </div>
  )
}

// ── Buscar aula: state the need, get only the rooms that fit ──────────────────
function FindRoom({ rooms, reservations, onBook }: {
  rooms: Room[]
  reservations: Reservation[]
  onBook: (p: Partial<FormState>) => void
}) {
  const [q, setQ] = useState(() => ({ ...nextSlot(), people: '20', building: '' }))
  const people = Math.max(1, Number(q.people) || 1)
  const s = at(q.date, q.start).getTime(), e = at(q.date, q.end).getTime()
  const valid = q.end > q.start

  const busy = useMemo(() => new Set(reservations.filter(r => overlaps(r, s, e)).map(r => String(r.room_id))), [reservations, s, e])
  const fitting = rooms.filter(r => r.max_capacity >= people && (!q.building || (r.building ?? '') === q.building))
  const free = valid
    ? fitting
      .filter(r => !busy.has(String(r.id)))
      // Best fit first: the smallest room that holds everyone, then by location.
      .sort((a, b) => a.max_capacity - b.max_capacity || compareRooms(a, b))
    : []
  const page = usePage(free, 10)

  return (
    <div className="space-y-4">
      <Card title="¿Qué necesitas?">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-6">
          <label className="col-span-2 block">
            <span className="field-label">Fecha</span>
            <input type="date" className="field" value={q.date} onChange={ev => ev.target.value && setQ({ ...q, date: ev.target.value })} />
          </label>
          <TimeSelect label="Desde" value={q.start} onChange={start => {
            const steps = Math.max(1, TIMES.indexOf(q.end) - TIMES.indexOf(q.start))
            setQ({ ...q, start, end: TIMES[Math.min(TIMES.indexOf(start) + steps, TIMES.length - 1)] })
          }} />
          <TimeSelect label="Hasta" value={q.end} from={q.start} onChange={end => setQ({ ...q, end })} />
          <label className="block">
            <span className="field-label">Personas</span>
            <input type="number" min={1} className={`field ${NUM_INPUT_MODS}`} value={q.people} onChange={ev => setQ({ ...q, people: ev.target.value })} />
          </label>
          <label className="block">
            <span className="field-label">Edificio</span>
            <select className="field" value={q.building} onChange={ev => setQ({ ...q, building: ev.target.value })}>
              <option value="">Cualquiera</option>
              {buildingsOf(rooms).map(b => <option key={b} value={b}>{buildingLabel(b || null)}</option>)}
            </select>
          </label>
        </div>
      </Card>

      <Card
        title={valid ? `${free.length} ${free.length === 1 ? 'aula libre' : 'aulas libres'}` : 'Revisa el horario'}
        aside={valid && <span>{longDate(q.date)}, {q.start}–{q.end} · {people} personas · de {fitting.length} aulas con capacidad suficiente</span>}
      >
        {!valid ? (
          <p className="text-sm text-slate-400">La hora de fin debe ser posterior a la de inicio.</p>
        ) : free.length === 0 ? (
          <p className="text-sm text-slate-400">
            No hay aulas libres que cumplan. Prueba otro horario{q.building ? ', otro edificio' : ''} o menos personas.
          </p>
        ) : <>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px]">
              <thead>
                <tr className="table-head">
                  <th className="py-2 pr-4 font-normal">Aula</th>
                  <th className="py-2 pr-4 font-normal">Ubicación</th>
                  <th className="py-2 pr-4 font-normal">Capacidad</th>
                  <th className="py-2 font-normal" />
                </tr>
              </thead>
              <tbody>
                {page.rows.map((r, i) => (
                  <tr key={r.id} className="table-row">
                    <td className="py-2 pr-4 text-sm">
                      <span className="font-medium text-slate-100">{r.id}</span>
                      <span className="ml-2 text-slate-400">{shortName(r)}</span>
                      {page.page === 1 && i === 0 && <span className="ml-2"><Chip tone="info">Mejor ajuste</Chip></span>}
                    </td>
                    <td className="py-2 pr-4 text-sm text-slate-300">{locationLabel(r)}</td>
                    <td className="py-2 pr-4 text-sm tabular-nums text-slate-300">{r.max_capacity} personas</td>
                    <td className="py-2 text-right">
                      <button className="btn btn-secondary py-1.5" onClick={() => onBook({ room_id: String(r.id), date: q.date, start: q.start, end: q.end, people: String(people) })}>
                        Reservar
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination {...page} noun="aulas" />
        </>}
      </Card>
    </div>
  )
}

// ── Agenda: the day grid, one floor at a time ─────────────────────────────────
function Agenda({ rooms, reservations, now, today, onNew, onOpen }: {
  rooms: Room[]
  reservations: Reservation[]
  now: number
  today: string
  onNew: (p: Partial<FormState>) => void
  onOpen: (r: Reservation) => void
}) {
  const first = [...rooms].sort(compareRooms)[0]
  const [day, setDay] = useState(today)
  const filter = useRoomFilter(rooms, { building: first?.building ?? '', floor: first ? String(first.floor ?? -1) : '' })
  const visible = [...filter.filtered].sort(compareRooms)
  const page = usePage(visible, 12)

  const dayStart = at(day, '00:00').getTime()
  const dayEnd = dayStart + 86_400_000
  const ofDay = reservations.filter(r => overlaps(r, dayStart, dayEnd))
  const span = (DAY_END - DAY_START) * 60
  const pct = (min: number) => `${((Math.min(Math.max(min, DAY_START * 60), DAY_END * 60) - DAY_START * 60) / span) * 100}%`
  const nowMin = minutesOf(new Date(now))
  const showNow = day === today && nowMin >= DAY_START * 60 && nowMin <= DAY_END * 60
  const pastUntil = day < today ? DAY_END * 60 : day === today ? nowMin : 0

  function onTrackClick(e: MouseEvent<HTMLDivElement>, roomId: string) {
    const rect = e.currentTarget.getBoundingClientRect()
    const frac = Math.min(Math.max((e.clientX - rect.left) / rect.width, 0), 0.999)
    let m = DAY_START * 60 + Math.floor((frac * span) / STEP_MIN) * STEP_MIN
    m = Math.min(m, DAY_END * 60 - 60)
    const t = (x: number) => `${pad(Math.floor(x / 60))}:${pad(x % 60)}`
    onNew({ room_id: roomId, date: day, start: t(m), end: t(m + 60) })
  }

  const where = filter.state.building
    ? `${buildingLabel(filter.state.building || null)}${filter.state.floor ? ` · ${floorLabel(filter.state.floor === '-1' ? null : Number(filter.state.floor))}` : ''}`
    : 'Todos los edificios'

  return (
    <Card
      title={`${day === today ? 'Hoy · ' : ''}${longDate(day)}`}
      aside={<>
        <button className="btn btn-secondary px-2 py-1.5" onClick={() => setDay(addDays(day, -1))} aria-label="Día anterior"><ChevronLeft size={16} /></button>
        <button className="btn btn-secondary py-1.5" onClick={() => setDay(today)} disabled={day === today}>Hoy</button>
        <button className="btn btn-secondary px-2 py-1.5" onClick={() => setDay(addDays(day, 1))} aria-label="Día siguiente"><ChevronRight size={16} /></button>
        <input type="date" value={day} onChange={e => e.target.value && setDay(e.target.value)} className="field w-auto py-1.5" aria-label="Ir a fecha" />
      </>}
    >
      <div className="mb-3">
        <RoomFilters rooms={rooms} state={filter.state} onChange={filter.setState}>
          <span className="ml-auto text-xs text-slate-400">{where} · {visible.length} aulas</span>
        </RoomFilters>
      </div>

      {visible.length === 0 ? (
        <p className="py-6 text-sm text-slate-400">Ningún aula coincide con los filtros.</p>
      ) : (
        <div className="overflow-x-auto">
          <div className="min-w-[720px]">
            <div className="flex">
              <div className="w-24 shrink-0" />
              <div className="relative h-5 flex-1">
                {HOURS.map(h => (
                  <span key={h} className="absolute -translate-x-1/2 text-xs text-slate-500 tabular-nums first:translate-x-0" style={{ left: pct(h * 60) }}>{pad(h)}</span>
                ))}
              </div>
            </div>
            {page.rows.map(room => {
              const items = ofDay.filter(r => String(r.room_id) === String(room.id))
              return (
                <div key={room.id} className="flex border-t border-slate-800">
                  <div className="w-24 shrink-0 py-2 pr-2" title={room.name}>
                    <p className="text-sm font-medium text-slate-200">{room.id}</p>
                    <p className="text-xs text-slate-500">{room.max_capacity} personas</p>
                  </div>
                  <div className="group relative h-14 flex-1 cursor-pointer" onClick={e => onTrackClick(e, String(room.id))} title="Clic para reservar este horario">
                    {HOURS.map(h => <span key={h} className="pointer-events-none absolute inset-y-0 border-l border-slate-800/80" style={{ left: pct(h * 60) }} />)}
                    <span className="pointer-events-none absolute inset-0 rounded bg-blue-500/0 transition-colors group-hover:bg-blue-500/[0.04]" />
                    {pastUntil > DAY_START * 60 && <span className="pointer-events-none absolute inset-y-0 left-0 bg-slate-950/50" style={{ width: pct(pastUntil) }} />}
                    {items.map(r => {
                      const s = new Date(r.start_time), e = new Date(r.end_time)
                      const sMin = s.getTime() < dayStart ? 0 : minutesOf(s)
                      const eMin = e.getTime() >= dayEnd ? 24 * 60 : minutesOf(e)
                      const isPast = e.getTime() <= now
                      const live = s.getTime() <= now && !isPast
                      return (
                        <button
                          key={r.id}
                          onClick={ev => { ev.stopPropagation(); onOpen(r) }}
                          title={`${hhmm(s)}–${hhmm(e)} · ${r.username ?? '—'} · ${r.expected_occupancy} personas`}
                          className={`absolute inset-y-1.5 overflow-hidden rounded-md border px-2 text-left text-xs transition-colors ${
                            live ? 'border-sky-500/60 bg-sky-500/15 text-sky-100 hover:bg-sky-500/25'
                              : isPast ? 'border-slate-700 bg-slate-800/50 text-slate-400 hover:bg-slate-800'
                                : 'border-slate-600 bg-slate-800 text-slate-100 hover:border-blue-500'
                          }`}
                          style={{ left: pct(sMin), width: `calc(${pct(eMin)} - ${pct(sMin)})` }}
                        >
                          <span className="block truncate font-medium tabular-nums">{shortRange(s, e)}</span>
                          <span className="block truncate text-slate-400">{r.username ?? '—'} · {r.expected_occupancy} pers.</span>
                        </button>
                      )
                    })}
                    {showNow && <span className="pointer-events-none absolute inset-y-0 z-10 w-px bg-sky-400" style={{ left: pct(nowMin) }} />}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}
      <Pagination {...page} noun="aulas" />
    </Card>
  )
}

// ── Reservas: mine / all, searchable, paged, grouped by day ───────────────────
function ReservationsTab({ reservations, rooms, username, now, today, onOpen, onDelete }: {
  reservations: Reservation[]
  rooms: Record<string, Room>
  username: string
  now: number
  today: string
  onOpen: (r: Reservation) => void
  onDelete: (r: Reservation) => void
}) {
  const [whose, setWhose] = useState<'mine' | 'all'>('mine')
  const [when, setWhen] = useState<'upcoming' | 'past'>('upcoming')
  const [query, setQuery] = useState('')

  const q = query.trim().toLowerCase()
  const list = reservations
    .filter(r => whose === 'all' || r.username === username)
    .filter(r => (when === 'upcoming') === (new Date(r.end_time).getTime() > now))
    .filter(r => {
      if (!q) return true
      const room = rooms[String(r.room_id)]
      return (room ? matchesQuery(room, q) : String(r.room_id).toLowerCase().includes(q)) || (r.username ?? '').toLowerCase().includes(q)
    })
    .sort((a, b) => (when === 'upcoming' ? 1 : -1) * a.start_time.localeCompare(b.start_time))
  const page = usePage(list, 15)

  return (
    <Card>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="segmented">
          <button className={`segmented-item ${whose === 'mine' ? 'segmented-item-active' : ''}`} onClick={() => setWhose('mine')}>Mías</button>
          <button className={`segmented-item ${whose === 'all' ? 'segmented-item-active' : ''}`} onClick={() => setWhose('all')}>Todas</button>
        </div>
        <div className="segmented">
          <button className={`segmented-item ${when === 'upcoming' ? 'segmented-item-active' : ''}`} onClick={() => setWhen('upcoming')}>Próximas</button>
          <button className={`segmented-item ${when === 'past' ? 'segmented-item-active' : ''}`} onClick={() => setWhen('past')}>Pasadas</button>
        </div>
        <label className="relative">
          <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500" />
          <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Aula o usuario…" className="field w-48 pl-8" aria-label="Buscar reserva" />
        </label>
      </div>

      {list.length === 0
        ? <p className="py-4 text-sm text-slate-400">
            {whose === 'mine' ? `No tienes reservas ${when === 'upcoming' ? 'próximas' : 'pasadas'}.` : 'No hay reservas.'}
          </p>
        : <ReservationList items={page.rows} today={today} now={now} rooms={rooms} onOpen={onOpen} onDelete={onDelete} showUser={whose === 'all'} />}
      <Pagination {...page} noun="reservas" />
    </Card>
  )
}

function ReservationList({ items, today, now, rooms, onOpen, onDelete, showUser }: {
  items: Reservation[]
  today: string
  now: number
  rooms: Record<string, Room>
  onOpen: (r: Reservation) => void
  onDelete: (r: Reservation) => void
  showUser: boolean
}) {
  const groups: [string, Reservation[]][] = []
  for (const r of items) {
    const k = dateKey(new Date(r.start_time))
    const last = groups[groups.length - 1]
    if (last && last[0] === k) last[1].push(r)
    else groups.push([k, [r]])
  }
  return (
    <div className="space-y-3">
      {groups.map(([date, rs]) => (
        <div key={date}>
          <p className="mb-1 text-xs text-slate-400">{dayLabel(date, today)}</p>
          <ul className="divide-y divide-slate-800 rounded-lg border border-slate-800">
            {rs.map(r => {
              const s = new Date(r.start_time), e = new Date(r.end_time)
              const live = s.getTime() <= now && e.getTime() > now
              const room = rooms[String(r.room_id)]
              return (
                <li key={r.id} className="group flex items-center gap-3 px-3 py-2 transition-colors hover:bg-slate-800/40">
                  <button className="flex min-w-0 flex-1 items-center gap-3 text-left" onClick={() => onOpen(r)}>
                    <span className="w-24 shrink-0 text-sm tabular-nums text-slate-100">{hhmm(s)}–{hhmm(e)}</span>
                    <span className="min-w-0 flex-1 truncate text-sm text-slate-200">
                      <b className="font-medium">{r.room_id}</b>
                      <span className="text-slate-400"> {room ? `${shortName(room)} · ${locationLabel(room)}` : ''}</span>
                    </span>
                    {showUser && <span className="hidden w-32 truncate text-xs text-slate-400 sm:block">{r.username ?? '—'}</span>}
                    <span className="w-20 text-right text-xs tabular-nums text-slate-400">{r.expected_occupancy}{room ? ` / ${room.max_capacity}` : ''} pers.</span>
                    <span className="w-20 shrink-0 text-right">{live && <Chip tone="info">En curso</Chip>}</span>
                  </button>
                  <button className="btn btn-ghost px-2 py-1 opacity-60 group-hover:opacity-100" onClick={() => onDelete(r)} aria-label="Eliminar reserva" title="Eliminar">
                    <Trash2 size={14} />
                  </button>
                </li>
              )
            })}
          </ul>
        </div>
      ))}
    </div>
  )
}
