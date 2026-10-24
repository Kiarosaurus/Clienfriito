import { useState, useEffect, useCallback, useMemo, type MouseEvent } from 'react'
import { ChevronLeft, ChevronRight, Plus, Trash2, RefreshCw, AlertTriangle, CheckCircle2, AlertCircle, X } from 'lucide-react'
import api, { getApiErrorDetail } from '../api/client'
import { NUM_INPUT_MODS } from '../utils/formStyles'
import { Card, Chip, Dialog, PageHeader } from '../components/ui'

// Reservation booking follows the familiar room-calendar pattern:
// 1. a day agenda (rooms × hours) shows what is taken; click a free slot to book it,
//    click a booking to edit it;
// 2. the upcoming list groups bookings by day, with past ones collapsed;
// 3. one dialog for create/edit with date + from/to times and live conflict checks.

interface Room { id: string; name: string; max_capacity: number }

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

const DAY_START = 7    // agenda window, local hours
const DAY_END = 22
const STEP_MIN = 30
const TIMES = Array.from({ length: ((DAY_END - DAY_START) * 60) / STEP_MIN + 1 }, (_, i) => {
  const m = DAY_START * 60 + i * STEP_MIN
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
})
const HOURS = Array.from({ length: DAY_END - DAY_START }, (_, i) => DAY_START + i)

// ── Date helpers (everything in local wall-clock time) ────────────────────────
const pad = (n: number) => String(n).padStart(2, '0')
const dateKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const hhmm = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`
const at = (date: string, time: string) => new Date(`${date}T${time}:00`)
const addDays = (date: string, n: number) => { const d = new Date(`${date}T00:00:00`); d.setDate(d.getDate() + n); return dateKey(d) }
const minutesOf = (d: Date) => d.getHours() * 60 + d.getMinutes()
// Compact range for narrow agenda blocks: "17–18 h", "9:30–11 h".
const shortRange = (s: Date, e: Date) => {
  const f = (d: Date) => (d.getMinutes() ? `${d.getHours()}:${pad(d.getMinutes())}` : `${d.getHours()}`)
  return `${f(s)}–${f(e)} h`
}

function dayLabel(date: string, today: string) {
  if (date === today) return 'Hoy'
  if (date === addDays(today, 1)) return 'Mañana'
  if (date === addDays(today, -1)) return 'Ayer'
  const s = new Date(`${date}T00:00:00`).toLocaleDateString('es', { weekday: 'long', day: 'numeric', month: 'long' })
  return s.charAt(0).toUpperCase() + s.slice(1)
}

// Next free half hour from now, clamped to the agenda window.
function nextSlot(): { date: string; start: string; end: string } {
  const d = new Date()
  const m = Math.ceil((minutesOf(d) + 1) / STEP_MIN) * STEP_MIN
  if (m < DAY_START * 60 || m + 60 > DAY_END * 60) {
    const date = m < DAY_START * 60 ? dateKey(d) : addDays(dateKey(d), 1)
    return { date, start: `${pad(DAY_START + 1)}:00`, end: `${pad(DAY_START + 2)}:00` }
  }
  return { date: dateKey(d), start: `${pad(Math.floor(m / 60))}:${pad(m % 60)}`, end: `${pad(Math.floor((m + 60) / 60))}:${pad((m + 60) % 60)}` }
}

// Backend errors come in English; show the ones a user can act on in Spanish.
function friendlyError(err: unknown, fallback: string) {
  const status = (err as { response?: { status?: number } })?.response?.status
  if (status === 409) return 'El aula ya está reservada en ese horario.'
  if (status === 400) return 'La hora de fin debe ser posterior a la de inicio.'
  if (status === 403) return 'Tu rol no puede gestionar reservas.'
  return getApiErrorDetail(err) ?? fallback
}

// ── View ──────────────────────────────────────────────────────────────────────
export default function Reservations() {
  const [rooms, setRooms] = useState<Room[]>([])
  const [reservations, setReservations] = useState<Reservation[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [toast, setToast] = useState<{ type: 'ok' | 'error'; text: string } | null>(null)
  const [day, setDay] = useState(() => dateKey(new Date()))
  const [form, setForm] = useState<FormState | null>(null)
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [toDelete, setToDelete] = useState<Reservation | null>(null)
  const [showPast, setShowPast] = useState(false)
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

  // ── Derived lists ───────────────────────────────────────────────────────────
  const dayStart = at(day, '00:00').getTime()
  const dayEnd = dayStart + 86_400_000
  const ofDay = reservations.filter(r => new Date(r.start_time).getTime() < dayEnd && new Date(r.end_time).getTime() > dayStart)
  const upcoming = reservations
    .filter(r => new Date(r.end_time).getTime() > now)
    .sort((a, b) => a.start_time.localeCompare(b.start_time))
  const past = reservations
    .filter(r => new Date(r.end_time).getTime() <= now)
    .sort((a, b) => b.start_time.localeCompare(a.start_time))

  // ── Form ────────────────────────────────────────────────────────────────────
  function openNew(preset?: Partial<FormState>) {
    const slot = nextSlot()
    setFormError(null)
    setForm({ id: null, room_id: String(rooms[0]?.id ?? ''), date: slot.date, start: slot.start, end: slot.end, people: '1', ...preset })
  }

  function openEdit(r: Reservation) {
    const s = new Date(r.start_time), e = new Date(r.end_time)
    setFormError(null)
    setForm({ id: r.id, room_id: String(r.room_id), date: dateKey(s), start: hhmm(s), end: hhmm(e), people: String(r.expected_occupancy) })
  }

  const capacity = form ? roomById[form.room_id]?.max_capacity : undefined
  const conflict = form ? reservations.find(r =>
    String(r.room_id) === form.room_id && r.id !== form.id &&
    new Date(r.start_time).getTime() < at(form.date, form.end).getTime() &&
    new Date(r.end_time).getTime() > at(form.date, form.start).getTime(),
  ) : undefined
  const problems: string[] = []
  if (form) {
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
      notify('ok', form.id === null ? 'Reserva creada.' : 'Cambios guardados.')
      setDay(form.date)
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

  // Click on an empty part of a room row → new booking at that half hour.
  function onTrackClick(e: MouseEvent<HTMLDivElement>, roomId: string) {
    const rect = e.currentTarget.getBoundingClientRect()
    const frac = Math.min(Math.max((e.clientX - rect.left) / rect.width, 0), 0.999)
    let m = DAY_START * 60 + Math.floor((frac * (DAY_END - DAY_START) * 60) / STEP_MIN) * STEP_MIN
    m = Math.min(m, DAY_END * 60 - 60)
    const t = (x: number) => `${pad(Math.floor(x / 60))}:${pad(x % 60)}`
    openNew({ room_id: roomId, date: day, start: t(m), end: t(m + 60) })
  }

  const span = (DAY_END - DAY_START) * 60
  const pct = (min: number) => `${((Math.min(Math.max(min, DAY_START * 60), DAY_END * 60) - DAY_START * 60) / span) * 100}%`
  const nowMin = minutesOf(new Date(now))
  const showNow = day === today && nowMin >= DAY_START * 60 && nowMin <= DAY_END * 60
  // Shade the part of the day that already passed.
  const pastUntil = day < today ? DAY_END * 60 : day === today ? nowMin : 0

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <div className="space-y-4">
      <PageHeader title="Reservas" subtitle="Elige un horario libre en la agenda o crea una reserva nueva.">
        <button className="btn btn-primary" onClick={() => openNew()} disabled={loading || rooms.length === 0}>
          <Plus size={16} /> Nueva reserva
        </button>
      </PageHeader>

      {error && <Card className="border-red-500/40 text-sm text-red-300">{error}</Card>}

      {/* ── Day agenda ── */}
      <Card
        title={day === today
          ? `Hoy · ${new Date(`${day}T00:00:00`).toLocaleDateString('es', { weekday: 'long', day: 'numeric', month: 'long' })}`
          : dayLabel(day, today)}
        aside={<>
          <button className="btn btn-secondary px-2 py-1.5" onClick={() => setDay(addDays(day, -1))} aria-label="Día anterior"><ChevronLeft size={16} /></button>
          <button className="btn btn-secondary py-1.5" onClick={() => setDay(today)} disabled={day === today}>Hoy</button>
          <button className="btn btn-secondary px-2 py-1.5" onClick={() => setDay(addDays(day, 1))} aria-label="Día siguiente"><ChevronRight size={16} /></button>
          <input type="date" value={day} onChange={e => e.target.value && setDay(e.target.value)} className="field w-auto py-1.5" aria-label="Ir a fecha" />
        </>}
      >
        {loading ? (
          <p className="flex items-center gap-2 py-8 text-sm text-slate-400"><RefreshCw size={14} className="animate-spin" /> Cargando agenda…</p>
        ) : (
          <div className="overflow-x-auto">
            <div className="min-w-[720px]">
              {/* Hour ruler */}
              <div className="flex">
                <div className="w-24 shrink-0" />
                <div className="relative h-5 flex-1">
                  {HOURS.map(h => (
                    <span key={h} className="absolute -translate-x-1/2 text-xs text-slate-500 tabular-nums first:translate-x-0" style={{ left: pct(h * 60) }}>
                      {pad(h)}
                    </span>
                  ))}
                </div>
              </div>

              {rooms.map(room => {
                const items = ofDay.filter(r => String(r.room_id) === String(room.id))
                return (
                  <div key={room.id} className="flex border-t border-slate-800">
                    <div className="w-24 shrink-0 py-2 pr-2" title={room.name}>
                      <p className="text-sm font-medium text-slate-200">{room.id}</p>
                      <p className="text-xs text-slate-500">{room.max_capacity} personas</p>
                    </div>
                    <div
                      className="group relative h-14 flex-1 cursor-pointer"
                      onClick={e => onTrackClick(e, String(room.id))}
                      title="Clic para reservar este horario"
                    >
                      {HOURS.map(h => (
                        <span key={h} className="pointer-events-none absolute inset-y-0 border-l border-slate-800/80" style={{ left: pct(h * 60) }} />
                      ))}
                      <span className="pointer-events-none absolute inset-0 rounded bg-blue-500/0 transition-colors group-hover:bg-blue-500/[0.04]" />
                      {pastUntil > DAY_START * 60 && (
                        <span className="pointer-events-none absolute inset-y-0 left-0 bg-slate-950/50" style={{ width: pct(pastUntil) }} title="Horario pasado" />
                      )}
                      {items.map(r => {
                        const s = new Date(r.start_time), e = new Date(r.end_time)
                        const sMin = s.getTime() < dayStart ? 0 : minutesOf(s)
                        const eMin = e.getTime() >= dayEnd ? 24 * 60 : minutesOf(e)
                        const isPast = e.getTime() <= now
                        const live = s.getTime() <= now && !isPast
                        return (
                          <button
                            key={r.id}
                            onClick={ev => { ev.stopPropagation(); openEdit(r) }}
                            title={`${hhmm(s)}–${hhmm(e)} · ${r.username ?? '—'} · ${r.expected_occupancy} personas`}
                            className={`absolute inset-y-1.5 overflow-hidden rounded-md border px-2 text-left text-xs transition-colors ${
                              live
                                ? 'border-sky-500/60 bg-sky-500/15 text-sky-100 hover:bg-sky-500/25'
                                : isPast
                                  ? 'border-slate-700 bg-slate-800/50 text-slate-400 hover:bg-slate-800'
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
        {!loading && ofDay.length === 0 && (
          <p className="mt-3 text-xs text-slate-500">No hay reservas este día. Haz clic en la fila de un aula para reservar ese horario.</p>
        )}
      </Card>

      {/* ── Upcoming list ── */}
      {!loading && (
        <Card title={`Próximas reservas · ${upcoming.length}`}>
          {upcoming.length === 0
            ? <p className="py-4 text-sm text-slate-400">No hay reservas próximas.</p>
            : <ReservationList items={upcoming} today={today} now={now} rooms={roomById} onOpen={openEdit} onDelete={setToDelete} />}

          {past.length > 0 && (
            <div className="mt-3 border-t border-slate-800 pt-3">
              <button className="btn btn-ghost -ml-3" onClick={() => setShowPast(v => !v)}>
                {showPast ? 'Ocultar' : 'Mostrar'} reservas pasadas ({past.length})
              </button>
              {showPast && <div className="mt-2 opacity-70"><ReservationList items={past} today={today} now={now} rooms={roomById} onOpen={openEdit} onDelete={setToDelete} /></div>}
            </div>
          )}
        </Card>
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
            <label className="col-span-2 block">
              <span className="field-label">Aula</span>
              <select className="field" value={form.room_id} onChange={e => setForm({ ...form, room_id: e.target.value })}>
                {rooms.map(r => <option key={r.id} value={String(r.id)}>{r.name} · {r.max_capacity} personas</option>)}
              </select>
            </label>
            <label className="col-span-2 block">
              <span className="field-label">Fecha</span>
              <input type="date" className="field" value={form.date} onChange={e => e.target.value && setForm({ ...form, date: e.target.value })} required />
            </label>
            <label className="block">
              <span className="field-label">Desde</span>
              <select className="field tabular-nums" value={form.start} onChange={e => {
                const start = e.target.value
                // Keep the same duration when moving the start time.
                const dur = Math.max(STEP_MIN, TIMES.indexOf(form.end) - TIMES.indexOf(form.start))
                const end = TIMES[Math.min(TIMES.indexOf(start) + (dur || 2), TIMES.length - 1)]
                setForm({ ...form, start, end })
              }}>
                {TIMES.slice(0, -1).map(t => <option key={t}>{t}</option>)}
              </select>
            </label>
            <label className="block">
              <span className="field-label">Hasta</span>
              <select className="field tabular-nums" value={form.end} onChange={e => setForm({ ...form, end: e.target.value })}>
                {TIMES.slice(1).map(t => <option key={t} disabled={t <= form.start}>{t}</option>)}
              </select>
            </label>
            <label className="col-span-2 block">
              <span className="field-label">Personas esperadas</span>
              <input
                type="number" min={1} max={capacity} className={`field ${NUM_INPUT_MODS}`}
                value={form.people} onChange={e => setForm({ ...form, people: e.target.value })}
              />
              <span className="mt-1 block text-xs text-slate-500">
                Capacidad del aula: {capacity ?? '—'}. Se usa para pre-enfriar el aula antes de la clase.
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

      {/* ── Toast ── */}
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

// Agenda-style list grouped by day.
function ReservationList({ items, today, now, rooms, onOpen, onDelete }: {
  items: Reservation[]
  today: string
  now: number
  rooms: Record<string, Room>
  onOpen: (r: Reservation) => void
  onDelete: (r: Reservation) => void
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
                      <span className="text-slate-400"> {room?.name.replace(String(r.room_id), '').trim()}</span>
                    </span>
                    <span className="hidden w-32 truncate text-xs text-slate-400 sm:block">{r.username ?? '—'}</span>
                    <span className="w-20 text-right text-xs tabular-nums text-slate-400">{r.expected_occupancy}{room ? ` / ${room.max_capacity}` : ''} pers.</span>
                    {live && <Chip tone="info">En curso</Chip>}
                  </button>
                  <button
                    className="btn btn-ghost px-2 py-1 opacity-60 group-hover:opacity-100"
                    onClick={() => onDelete(r)}
                    aria-label="Eliminar reserva"
                    title="Eliminar"
                  >
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
