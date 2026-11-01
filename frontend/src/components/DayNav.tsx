import { ChevronLeft, ChevronRight } from 'lucide-react'
import { parseUtc } from './ui'

// One local calendar day: ‹ weekday, date › plus a date field to jump. Shared by the
// room's "Aprendizaje" and "Historial" tabs. Fixed widths so nothing moves between days.

/** Local YYYY-MM-DD of an instant (the format of <input type="date">). */
export const localDay = (ms: number) => new Date(ms).toLocaleDateString('en-CA')

/** The day before/after an ISO day. */
export function shiftDay(isoDay: string, dir: -1 | 1): string {
  const [y, m, d] = isoDay.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + dir)).toISOString().slice(0, 10)
}

export default function DayNav({ date, start, end, dataStart, dataEnd, onChange }: {
  date: string            // local YYYY-MM-DD shown
  start: string           // the day's bounds and the data's, naive UTC
  end: string
  dataStart?: string | null
  dataEnd?: string | null
  onChange: (isoDay: string) => void
}) {
  const s = parseUtc(start).getTime(), e = parseUtc(end).getTime()
  const ds = dataStart ? parseUtc(dataStart).getTime() : -Infinity
  const de = dataEnd ? parseUtc(dataEnd).getTime() : Infinity
  return (
    <div className="flex items-center gap-1">
      <button className="btn btn-ghost px-1.5 py-1" aria-label="Día anterior" disabled={s <= ds} onClick={() => onChange(shiftDay(date, -1))}>
        <ChevronLeft size={16} />
      </button>
      <span className="inline-block w-[17.5rem] px-1 text-left text-sm text-slate-200 first-letter:uppercase">
        {new Date(s).toLocaleDateString('es', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
      </span>
      <button className="btn btn-ghost px-1.5 py-1" aria-label="Día siguiente" disabled={e > de} onClick={() => onChange(shiftDay(date, 1))}>
        <ChevronRight size={16} />
      </button>
      <input type="date" className="field ml-2 w-auto py-1 text-xs" aria-label="Ir a una fecha" value={date}
        min={Number.isFinite(ds) ? localDay(ds) : undefined} max={Number.isFinite(de) ? localDay(de) : undefined}
        onChange={ev => ev.target.value && onChange(ev.target.value)} />
    </div>
  )
}
