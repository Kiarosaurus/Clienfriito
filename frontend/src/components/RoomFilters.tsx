import { useMemo, useState, type ReactNode } from 'react'
import { Search } from 'lucide-react'
import { buildingLabel, buildingsOf, floorLabel, floorsOf, matchesQuery, type Room } from '../utils/rooms'

export interface RoomFilterState {
  query: string
  building: string   // '' = all
  floor: string      // '' = all
}

export function useRoomFilter(rooms: Room[], initial?: Partial<RoomFilterState>) {
  const [state, setState] = useState<RoomFilterState>({ query: '', building: '', floor: '', ...initial })
  const filtered = useMemo(() => rooms.filter(r =>
    matchesQuery(r, state.query) &&
    (!state.building || (r.building ?? '') === state.building) &&
    (!state.floor || String(r.floor ?? -1) === state.floor),
  ), [rooms, state])
  const active = !!(state.query.trim() || state.building || state.floor)
  return { state, setState, filtered, active }
}

// Search + building + floor. Floors only list the selected building's floors.
export function RoomFilters({ rooms, state, onChange, children, requireBuilding = false }: {
  rooms: Room[]
  state: RoomFilterState
  onChange: (s: RoomFilterState) => void
  children?: ReactNode
  requireBuilding?: boolean
}) {
  const buildings = buildingsOf(rooms)
  const floors = state.building || requireBuilding ? floorsOf(rooms, state.building) : []
  return (
    <div className="flex flex-wrap items-center gap-2">
      <label className="relative">
        <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500" />
        <input
          value={state.query}
          onChange={e => onChange({ ...state, query: e.target.value })}
          placeholder="Buscar aula…"
          className="field w-48 pl-8"
          aria-label="Buscar aula"
        />
      </label>
      <select
        className="field w-auto"
        value={state.building}
        onChange={e => onChange({ ...state, building: e.target.value, floor: '' })}
        aria-label="Edificio"
      >
        {!requireBuilding && <option value="">Todos los edificios</option>}
        {buildings.map(b => <option key={b} value={b}>{buildingLabel(b || null)}</option>)}
      </select>
      <select
        className="field w-auto"
        value={state.floor}
        onChange={e => onChange({ ...state, floor: e.target.value })}
        disabled={!state.building}
        aria-label="Piso"
      >
        <option value="">Todos los pisos</option>
        {floors.map(f => <option key={f} value={String(f)}>{floorLabel(f === -1 ? null : f)}</option>)}
      </select>
      {children}
    </div>
  )
}
