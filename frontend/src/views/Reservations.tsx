import { useEffect, useMemo, useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import api, { getApiErrorDetail } from '../api/client'
import { RoomFilters, useRoomFilter } from '../components/RoomFilters'
import { localDay, shiftDay } from '../components/DayNav'
import { compareRooms, locationLabel, shortName, type Room } from '../utils/rooms'

// "Horarios" is a read-only timetable: when each room is occupied (weekly classes and
// that week's reservations) and when it is free, one room at a time.
// Data: GET /admin/occupancy/week.

interface Block { room_id: string; day: number; start: string; end: string; kind: 'class' | 'reservation'; people: number; by: string | null }
interface Week { week_start: string; blocks: Block[] }

const H0 = 7, H1 = 22                        // visible hours
const DAY_NAMES = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom']

const minutes = (hm: string) => { const [h, m] = hm.split(':').map(Number); return h * 60 + m }
const hm = (min: number) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`
const top = (min: number) => `${((Math.max(min, H0 * 60) - H0 * 60) / ((H1 - H0) * 60)) * 100}%`
const height = (a: number, b: number) => `${((Math.min(b, H1 * 60) - Math.max(a, H0 * 60)) / ((H1 - H0) * 60)) * 100}%`
const mondayOf = (iso: string) => { const d = new Date(`${iso}T12:00:00`); return shiftDayBy(iso, -((d.getDay() + 6) % 7)) }
function shiftDayBy(iso: string, n: number) { let d = iso; for (let i = 0; i < Math.abs(n); i++) d = shiftDay(d, n < 0 ? -1 : 1); return d }
const dayNum = (iso: string) => Number(iso.slice(8, 10))
const monthName = (iso: string) => new Date(`${iso}T12:00:00`).toLocaleDateString('es', { month: 'long' })

// A block as drawn: one line when it lasts an hour, two when longer; the tooltip has it all.
interface Shown { key: string; a: number; b: number; dashed: boolean; line: string; head: string; sub: string; tip: string }

export default function Reservations() {
  const [rooms, setRooms] = useState<Room[]>([])
  const [week, setWeek] = useState<Week | null>(null)
  const [anchor, setAnchor] = useState(() => mondayOf(localDay(Date.now())))
  const [selected, setSelected] = useState<string>('')
  const [error, setError] = useState<string | null>(null)
  const [now, setNow] = useState(Date.now())
  const filter = useRoomFilter(rooms)

  useEffect(() => {
    api.get<Room[]>('/admin/rooms').then(r => setRooms([...r.data].sort(compareRooms))).catch(e => setError(getApiErrorDetail(e) ?? 'No se pudieron cargar las aulas.'))
    const t = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(t)
  }, [])
  useEffect(() => {
    let alive = true
    api.get<Week>(`/admin/occupancy/week?start=${anchor}`)
      .then(r => { if (alive) { setWeek(r.data); setError(null) } })
      .catch(e => alive && setError(getApiErrorDetail(e) ?? 'No se pudo cargar el horario.'))
    return () => { alive = false }
  }, [anchor])

  const visibleIds = useMemo(() => new Set(filter.filtered.map(r => r.id)), [filter.filtered])
  const blocks = useMemo(() => (week?.blocks ?? []).filter(b => visibleIds.has(b.room_id)), [week, visibleIds])
  // The chosen room, or the first one the filters leave.
  const room = filter.filtered.find(r => r.id === selected) ?? filter.filtered[0]

  // Classes run Monday to Saturday: no Sunday column.
  const today = localDay(now)
  const days = [0, 1, 2, 3, 4, 5]
  const todayIdx = days.find(d => shiftDayBy(anchor, d) === today)
  const nowMin = new Date(now).getHours() * 60 + new Date(now).getMinutes()

  const columns: Shown[][] = days.map(d => !room ? [] : blocks.filter(b => b.room_id === room.id && b.day === d).map(b => {
        const what = b.kind === 'class' ? 'Clase' : 'Reserva'
        return {
          key: `${b.room_id}-${b.day}-${b.start}`, a: minutes(b.start), b: minutes(b.end), dashed: b.kind === 'reservation',
          line: b.kind === 'class' ? `${b.start} · ${b.people} p.` : `${b.start} · Reserva`,
          head: `${b.start}–${b.end}`,
          sub: b.kind === 'class' ? `${b.people} personas` : `Reserva · ${b.people} p.`,
          tip: `${what} ${b.start}–${b.end}\n${b.people} personas${b.by ? ` · reservó ${b.by}` : ''}`,
        }
      }))

  const end = shiftDayBy(anchor, 6)
  const range = monthName(anchor) === monthName(end)
    ? `${dayNum(anchor)} – ${dayNum(end)} de ${monthName(end)}`
    : `${dayNum(anchor)} de ${monthName(anchor)} – ${dayNum(end)} de ${monthName(end)}`

  return (
    <div className="flex flex-col gap-4 lg:h-full lg:min-h-0">
      <div className="flex shrink-0 flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="page-title">Horarios</h1>
          <p className="mt-1 text-sm text-slate-400">Clases y reservas de cada aula: cuándo está ocupada y cuándo libre.</p>
        </div>
        <div className="flex items-center gap-2">
          <button className="btn btn-secondary px-2" aria-label="Semana anterior" onClick={() => setAnchor(a => shiftDayBy(a, -7))}><ChevronLeft size={16} /></button>
          <span className="w-56 text-center text-sm font-semibold text-white">{range}</span>
          <button className="btn btn-secondary px-2" aria-label="Semana siguiente" onClick={() => setAnchor(a => shiftDayBy(a, 7))}><ChevronRight size={16} /></button>
          <button className="btn btn-secondary" onClick={() => setAnchor(mondayOf(localDay(Date.now())))}>Esta semana</button>
        </div>
      </div>
      {error && <p className="text-sm text-red-300">{error}</p>}

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 lg:grid-cols-[17rem_minmax(0,1fr)]">
        {/* Rooms */}
        <aside className="surface flex min-h-0 flex-col overflow-hidden">
          <div className="border-b border-slate-800 p-3 [&_.field]:w-full [&>div]:flex-col [&>div]:items-stretch">
            <RoomFilters rooms={rooms} state={filter.state} onChange={filter.setState} />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {filter.filtered.map(r => (
              <button key={r.id} type="button" onClick={() => setSelected(r.id)} aria-pressed={room?.id === r.id}
                className={`flex w-full flex-col gap-0.5 border-b border-slate-800 px-4 py-2.5 text-left ${room?.id === r.id ? 'bg-slate-800' : 'hover:bg-slate-800/50'}`}>
                <span className="text-sm font-semibold text-white">{r.id}</span>
                <span className="text-xs text-slate-500">{locationLabel(r)}</span>
              </button>
            ))}
            {filter.filtered.length === 0 && <p className="px-4 py-6 text-center text-sm text-slate-500">Ninguna aula coincide con los filtros.</p>}
          </div>
        </aside>

        {/* Week */}
        <section className="surface flex min-h-[32rem] flex-col overflow-hidden">
          <header className="flex shrink-0 flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-slate-800 px-4 py-3">
            <h2 className="text-sm font-semibold text-white">{room?.id ?? 'Sin aulas'}</h2>
            {room && <span className="text-sm text-slate-400">{shortName(room)} · {locationLabel(room)}</span>}
          </header>
          <div className="grid shrink-0 border-b border-slate-800" style={{ gridTemplateColumns: `3.5rem repeat(${days.length}, minmax(0, 1fr))` }}>
            <span />
            {days.map(d => (
              <span key={d} className={`border-l border-slate-800 px-2.5 py-2 text-xs ${d === todayIdx ? 'font-semibold text-slate-100' : 'text-slate-400'}`}>
                {DAY_NAMES[d]} {dayNum(shiftDayBy(anchor, d))}{d === todayIdx && ' · hoy'}
              </span>
            ))}
          </div>
          <div className="relative grid min-h-0 flex-1" style={{ gridTemplateColumns: `3.5rem repeat(${days.length}, minmax(0, 1fr))` }}>
            <div className="relative">
              {Array.from({ length: H1 - H0 }, (_, i) => (
                <span key={i} className="absolute right-2 -translate-y-1/2 text-xs tabular-nums text-slate-500" style={{ top: top((H0 + i) * 60) }}>
                  {i === 0 ? '' : hm((H0 + i) * 60)}
                </span>
              ))}
            </div>
            {columns.map((col, i) => (
              <div key={days[i]} className="relative border-l border-slate-800">
                {Array.from({ length: H1 - H0 - 1 }, (_, h) => (
                  <span key={h} className="absolute inset-x-0 h-px bg-slate-800" style={{ top: top((H0 + h + 1) * 60) }} />
                ))}
                {col.map(b => (
                  <div key={b.key} title={b.tip}
                    className={`absolute inset-x-1 flex overflow-hidden rounded-md border bg-slate-800 px-2 ${b.b - b.a <= 60 ? 'items-center' : 'flex-col gap-0.5 py-1'} ${b.dashed ? 'border-dashed border-slate-500' : 'border-slate-700'}`}
                    style={{ top: `calc(${top(b.a)} + 2px)`, height: `calc(${height(b.a, b.b)} - 4px)` }}>
                    {b.b - b.a <= 60
                      ? <span className="truncate text-xs text-slate-300"><span className="font-medium text-slate-100">{b.line.split(' · ')[0]}</span> · {b.line.split(' · ').slice(1).join(' · ')}</span>
                      : <>
                        <span className="truncate text-xs font-medium text-slate-100">{b.head}</span>
                        <span className="truncate text-xs text-slate-400">{b.sub}</span>
                      </>}
                  </div>
                ))}
                {days[i] === todayIdx && nowMin >= H0 * 60 && nowMin <= H1 * 60 && (
                  <span className="absolute inset-x-0 h-0.5 bg-sky-400" style={{ top: top(nowMin) }} aria-label={`Ahora, ${hm(nowMin)}`} />
                )}
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  )
}
