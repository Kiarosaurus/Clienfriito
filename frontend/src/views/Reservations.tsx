import { useState, useEffect, useCallback, useMemo } from 'react'
import { Plus, Trash2, RefreshCw, AlertTriangle, CheckCircle2, AlertCircle, X, Search } from 'lucide-react'
import api, { getApiErrorDetail } from '../api/client'
import { useAuth } from '../context/AuthContext'
import { NUM_INPUT_MODS } from '../utils/formStyles'
import { locationLabel, matchesQuery, roomOptions, shortName, type Room } from '../utils/rooms'
import SearchableSelect from '../components/SearchableSelect'
import { Card, Chip, Dialog, PageHeader, Pagination, usePage, type Tone } from '../components/ui'

// In this project a reservation is a signal for the thermal control, not a room-booking
// system (PROYECTO_REDEFINIDO §2 and §6.4):
// · its expected occupancy drives pre-cooling before the class (feed-forward);
// · after the class it is contrasted with the occupancy measured from CO₂, which
//   reveals rooms that were booked but stayed (almost) empty;
// · a collaborator may only operate a room's devices during an active reservation (RF-37).

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

interface Occupancy { reservation_id: number; samples: number; actual_avg: number | null; actual_peak: number | null }

interface FormState { id: number | null; room_id: string; date: string; start: string; end: string; people: string }

const DAY_START = 7
const DAY_END = 22
const STEP_MIN = 30
const TIMES = Array.from({ length: ((DAY_END - DAY_START) * 60) / STEP_MIN + 1 }, (_, i) => {
  const m = DAY_START * 60 + i * STEP_MIN
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
})

// ── Date helpers (local wall-clock time) ──────────────────────────────────────
const pad = (n: number) => String(n).padStart(2, '0')
const dateKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const hhmm = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`
const at = (date: string, time: string) => new Date(`${date}T${time}:00`)
const addDays = (date: string, n: number) => { const d = new Date(`${date}T00:00:00`); d.setDate(d.getDate() + n); return dateKey(d) }
const minutesOf = (d: Date) => d.getHours() * 60 + d.getMinutes()

function dayLabel(date: string, today: string) {
  if (date === today) return 'Hoy'
  if (date === addDays(today, 1)) return 'Mañana'
  if (date === addDays(today, -1)) return 'Ayer'
  const s = new Date(`${date}T00:00:00`).toLocaleDateString('es', { weekday: 'long', day: 'numeric', month: 'long' })
  return s.charAt(0).toUpperCase() + s.slice(1)
}

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

function friendlyError(err: unknown, fallback: string) {
  const status = (err as { response?: { status?: number } })?.response?.status
  if (status === 409) return 'El aula ya tiene otra reserva en ese horario.'
  if (status === 400) return 'La hora de fin debe ser posterior a la de inicio.'
  if (status === 403) return 'Tu rol no puede gestionar reservas.'
  return getApiErrorDetail(err) ?? fallback
}

// Expected vs measured: the comparison this section exists for.
function verdict(expected: number, o?: Occupancy): { label: string; tone: Tone } | null {
  if (!o) return null
  if (o.samples === 0 || o.actual_peak == null) return { label: 'Sin lecturas', tone: 'muted' }
  if (o.actual_peak < expected * 0.5) return { label: 'Casi vacía', tone: 'warn' }
  if (o.actual_peak > expected * 1.2 && o.actual_peak - expected >= 3) return { label: 'Más de lo esperado', tone: 'high' }
  return { label: 'Según lo esperado', tone: 'ok' }
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
  const [rooms, setRooms] = useState<Room[]>([])
  const [reservations, setReservations] = useState<Reservation[]>([])
  const [occupancy, setOccupancy] = useState<Record<number, Occupancy>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [toast, setToast] = useState<{ type: 'ok' | 'error'; text: string } | null>(null)
  const [form, setForm] = useState<FormState | null>(null)
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [toDelete, setToDelete] = useState<Reservation | null>(null)
  const [whose, setWhose] = useState<'mine' | 'all'>('mine')
  const [when, setWhen] = useState<'upcoming' | 'past'>('upcoming')
  const [query, setQuery] = useState('')
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
  const options = useMemo(() => roomOptions(rooms), [rooms])

  // ── List ────────────────────────────────────────────────────────────────────
  const q = query.trim().toLowerCase()
  const list = reservations
    .filter(r => whose === 'all' || r.username === user?.username)
    .filter(r => (when === 'upcoming') === (new Date(r.end_time).getTime() > now))
    .filter(r => {
      if (!q) return true
      const room = roomById[String(r.room_id)]
      return (room ? matchesQuery(room, q) : String(r.room_id).toLowerCase().includes(q)) || (r.username ?? '').toLowerCase().includes(q)
    })
    .sort((a, b) => (when === 'upcoming' ? 1 : -1) * a.start_time.localeCompare(b.start_time))
  const page = usePage(list, 15)

  // Measured occupancy for the visible reservations that already started: one request per page.
  const startedIds = page.rows.filter(r => new Date(r.start_time).getTime() <= now).map(r => r.id)
  const idsKey = startedIds.join(',')
  useEffect(() => {
    if (!idsKey) return
    let cancelled = false
    api.get<Occupancy[]>(`/admin/reservations/occupancy?ids=${idsKey}`)
      .then(r => { if (!cancelled) setOccupancy(o => ({ ...o, ...Object.fromEntries((r.data ?? []).map(x => [x.reservation_id, x])) })) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [idsKey])

  // ── Create / edit ───────────────────────────────────────────────────────────
  function openNew() {
    setFormError(null)
    setForm({ id: null, room_id: '', ...nextSlot(), people: '' })
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
    if (!n || n < 1) problems.push('Indica cuántas personas esperas.')
    else if (capacity && n > capacity) problems.push(`El aula admite como máximo ${capacity} personas.`)
    if (conflict) {
      problems.push(`El aula ya tiene una reserva de ${conflict.username ?? 'otro usuario'} de ${hhmm(new Date(conflict.start_time))} a ${hhmm(new Date(conflict.end_time))}.`)
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
      notify('ok', form.id === null ? `Reserva registrada: ${form.room_id}, ${dayLabel(form.date, today).toLowerCase()} ${form.start}–${form.end}.` : 'Cambios guardados.')
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

  // Group the current page by day.
  const groups: [string, Reservation[]][] = []
  for (const r of page.rows) {
    const k = dateKey(new Date(r.start_time))
    const last = groups[groups.length - 1]
    if (last && last[0] === k) last[1].push(r)
    else groups.push([k, [r]])
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="Reservas"
        subtitle="Indica cuántas personas esperas en un aula y a qué hora. El sistema pre-enfría el aula antes de la clase y después compara lo esperado con la ocupación medida por CO₂."
      >
        <button className="btn btn-primary" onClick={openNew} disabled={loading || rooms.length === 0}>
          <Plus size={16} /> Nueva reserva
        </button>
      </PageHeader>

      {error && <Card className="border-red-500/40 text-sm text-red-300">{error}</Card>}

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

        {loading ? (
          <p className="flex items-center gap-2 py-6 text-sm text-slate-400"><RefreshCw size={14} className="animate-spin" /> Cargando…</p>
        ) : list.length === 0 ? (
          <p className="py-4 text-sm text-slate-400">
            {whose === 'mine' ? `No tienes reservas ${when === 'upcoming' ? 'próximas' : 'pasadas'}.` : `No hay reservas ${when === 'upcoming' ? 'próximas' : 'pasadas'}.`}
          </p>
        ) : (
          <div className="space-y-3">
            {groups.map(([date, rs]) => (
              <div key={date}>
                <p className="mb-1 text-xs text-slate-400">{dayLabel(date, today)}</p>
                <ul className="divide-y divide-slate-800 rounded-lg border border-slate-800">
                  {rs.map(r => {
                    const s = new Date(r.start_time), e = new Date(r.end_time)
                    const started = s.getTime() <= now
                    const live = started && e.getTime() > now
                    const room = roomById[String(r.room_id)]
                    const o = occupancy[r.id]
                    const v = started ? verdict(r.expected_occupancy, o) : null
                    return (
                      <li key={r.id} className="group flex items-center gap-3 px-3 py-2 transition-colors hover:bg-slate-800/40">
                        <button className="flex min-w-0 flex-1 items-center gap-3 text-left" onClick={() => openEdit(r)}>
                          <span className="w-24 shrink-0 text-sm tabular-nums text-slate-100">{hhmm(s)}–{hhmm(e)}</span>
                          <span className="min-w-0 flex-1 truncate text-sm text-slate-200">
                            <b className="font-medium">{r.room_id}</b>
                            <span className="text-slate-400"> {room ? `${shortName(room)} · ${locationLabel(room)}` : ''}</span>
                          </span>
                          {whose === 'all' && <span className="hidden w-28 truncate text-xs text-slate-400 lg:block">{r.username ?? '—'}</span>}
                          <span className="w-44 shrink-0 text-right text-xs tabular-nums text-slate-400">
                            {r.expected_occupancy} esperadas
                            {started && o && o.actual_peak != null && <> · <span className="text-slate-200">{o.actual_peak} medidas</span></>}
                          </span>
                          <span className="hidden w-36 shrink-0 text-right sm:block">
                            {live ? <Chip tone="info">En curso</Chip> : v ? <Chip tone={v.tone} title={o?.samples ? `Pico de ${o.actual_peak} y promedio de ${o.actual_avg} personas en ${o.samples} lecturas` : undefined}>{v.label}</Chip> : null}
                          </span>
                        </button>
                        <button className="btn btn-ghost px-2 py-1 opacity-60 group-hover:opacity-100" onClick={() => setToDelete(r)} aria-label="Eliminar reserva" title="Eliminar">
                          <Trash2 size={14} />
                        </button>
                      </li>
                    )
                  })}
                </ul>
              </div>
            ))}
          </div>
        )}
        <Pagination {...page} noun="reservas" />
        {when === 'past' && list.length > 0 && (
          <p className="mt-2 text-xs text-slate-500">
            "Medidas" es el pico de personas estimado por CO₂ durante la reserva. "Casi vacía" significa que no llegó ni a la mitad de lo esperado: el aula se pre-enfrió para más gente de la que hubo.
          </p>
        )}
      </Card>

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
              {form.id === null ? 'Registrar' : 'Guardar cambios'}
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
              const steps = Math.max(1, TIMES.indexOf(form.end) - TIMES.indexOf(form.start))
              setForm({ ...form, start, end: TIMES[Math.min(TIMES.indexOf(start) + steps, TIMES.length - 1)] })
            }} />
            <TimeSelect label="Hasta" value={form.end} from={form.start} onChange={end => setForm({ ...form, end })} />
            <label className="col-span-2 block">
              <span className="field-label">¿Cuántas personas esperas?</span>
              <input
                type="number" min={1} max={capacity} placeholder={capacity ? `Hasta ${capacity}` : ''} className={`field ${NUM_INPUT_MODS}`}
                value={form.people} onChange={e => setForm({ ...form, people: e.target.value })}
              />
              <span className="mt-1 block text-xs text-slate-500">
                El aula se pre-enfriará para esta cantidad antes de la hora de inicio. Durante la clase, el sistema ajusta según las personas que realmente detecta.
              </span>
            </label>
            <button type="submit" className="hidden" />
          </form>

          <div className="mt-3 space-y-2">
            {problems.length === 0 && !formError && (
              <p className="flex items-center gap-2 text-xs text-emerald-300"><CheckCircle2 size={14} /> Listo para registrar.</p>
            )}
            {problems.map(p => (
              <p key={p} className="flex items-start gap-2 text-xs text-red-300"><AlertCircle size={14} className="mt-px shrink-0" /> {p}</p>
            ))}
            {startsInPast && problems.length === 0 && (
              <p className="flex items-start gap-2 text-xs text-amber-300"><AlertTriangle size={14} className="mt-px shrink-0" /> La hora de inicio ya pasó: no habrá pre-enfriamiento.</p>
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
