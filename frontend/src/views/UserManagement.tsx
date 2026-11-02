import { useState, useEffect, useCallback, useMemo } from 'react'
import { RefreshCw, Search } from 'lucide-react'
import api, { getApiErrorDetail } from '../api/client'
import { useAuth } from '../context/AuthContext'
import { Pagination, usePage } from '../components/ui'

// Every account in one list: pending ones first (they wait for an admin), then active,
// then inactive. Each row offers only the action that fits its state.

interface UserRow {
  user_id: number
  username: string
  role: string
  status: string
}

type Status = 'pending' | 'active' | 'inactive'
type Filter = 'all' | Status

const ROLE_LABELS: Record<string, string> = { admin: 'Administrador', collaborator: 'Colaborador', guest: 'Visitante' }
const STATUS: Record<Status, { label: string; dot: string }> = {
  pending: { label: 'Pendiente de aprobación', dot: 'bg-amber-400' },
  active: { label: 'Activo', dot: 'bg-emerald-400' },
  inactive: { label: 'Inactivo', dot: 'bg-slate-500' },
}
const ORDER: Record<string, number> = { pending: 0, active: 1, inactive: 2 }

export default function UserManagement() {
  const { user: currentUser } = useAuth()
  const [users, setUsers] = useState<UserRow[]>([])
  const [filter, setFilter] = useState<Filter>('all')
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<number | null>(null)

  const fetchUsers = useCallback(() => {
    setLoading(true)
    api.get<UserRow[]>('/admin/users')
      .then(res => { setUsers(res.data); setError(null) })
      .catch(err => setError(getApiErrorDetail(err) ?? 'No se pudieron cargar los usuarios.'))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => { fetchUsers() }, [fetchUsers])

  async function setStatus(userId: number, status: Status) {
    setBusy(userId)
    try {
      await api.patch(`/admin/users/${userId}/status`, { status })
      setUsers(prev => prev.map(u => u.user_id === userId ? { ...u, status } : u))
      setError(null)
    } catch (err: unknown) {
      setError(getApiErrorDetail(err) ?? 'No se pudo cambiar el estado.')
    } finally {
      setBusy(null)
    }
  }

  const counts = useMemo(() => ({
    all: users.length,
    pending: users.filter(u => u.status === 'pending').length,
    active: users.filter(u => u.status === 'active').length,
    inactive: users.filter(u => u.status === 'inactive').length,
  }), [users])

  const q = query.trim().toLowerCase()
  const list = users
    .filter(u => (filter === 'all' || u.status === filter) && (!q || u.username.toLowerCase().includes(q)))
    .sort((a, b) => (ORDER[a.status] ?? 9) - (ORDER[b.status] ?? 9) || a.username.localeCompare(b.username, 'es'))
  const page = usePage(list, 25)

  const FILTERS: [Filter, string][] = [['all', 'Todos'], ['pending', 'Pendientes'], ['active', 'Activos'], ['inactive', 'Inactivos']]

  return (
    <div className="flex flex-col gap-4 lg:h-full lg:min-h-0">
      <div className="flex shrink-0 flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="page-title">Usuarios</h1>
          <p className="mt-1 text-sm text-slate-400">
            Todas las cuentas. {counts.pending > 0
              ? `${counts.pending} ${counts.pending === 1 ? 'espera' : 'esperan'} tu aprobación.`
              : 'No hay cuentas por aprobar.'}
          </p>
        </div>
      </div>

      {error && <p className="text-sm text-red-300">{error}</p>}

      <section className="surface flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-slate-800 p-3">
          <label className="relative">
            <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500" />
            <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Buscar usuario…" className="field w-56 pl-8" aria-label="Buscar usuario" />
          </label>
          <div className="segmented">
            {FILTERS.map(([k, label]) => (
              <button key={k} onClick={() => setFilter(k)} className={`segmented-item ${filter === k ? 'segmented-item-active' : ''}`}>
                {label} <span className="tabular-nums text-slate-500">{counts[k]}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-auto">
          {loading && users.length === 0 ? (
            <p className="flex items-center justify-center gap-2 py-12 text-sm text-slate-400"><RefreshCw size={14} className="animate-spin" /> Cargando…</p>
          ) : list.length === 0 ? (
            <p className="py-12 text-center text-sm text-slate-500">Ningún usuario coincide.</p>
          ) : (
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="table-head">
                  <th className="px-4 py-2.5 text-left font-normal">Usuario</th>
                  <th className="px-4 py-2.5 text-left font-normal">Rol</th>
                  <th className="px-4 py-2.5 text-left font-normal">Estado</th>
                  <th className="px-4 py-2.5 text-right font-normal">Acciones</th>
                </tr>
              </thead>
              <tbody>
                {page.rows.map(u => {
                  const isSelf = u.username === currentUser?.username
                  const st = STATUS[u.status as Status]
                  return (
                    <tr key={u.user_id} className="border-b border-slate-800">
                      <td className="px-4 py-3">
                        <span className="font-medium text-slate-100">{u.username}</span>
                        {isSelf && <span className="ml-2 text-xs text-slate-500">(tú)</span>}
                      </td>
                      <td className="px-4 py-3 text-slate-300">{ROLE_LABELS[u.role] ?? u.role}</td>
                      <td className="px-4 py-3">
                        <span className="flex items-center gap-1.5 text-slate-300">
                          <span className={`h-1.5 w-1.5 rounded-full ${st?.dot ?? 'bg-slate-500'}`} />{st?.label ?? u.status}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center justify-end gap-2">
                          {isSelf ? (
                            <span className="text-xs text-slate-500">—</span>
                          ) : busy === u.user_id ? (
                            <RefreshCw size={14} className="animate-spin text-slate-400" />
                          ) : u.status === 'pending' ? (
                            <>
                              <button className="btn btn-ghost py-1 text-slate-300" onClick={() => setStatus(u.user_id, 'inactive')}>Rechazar</button>
                              <button className="btn btn-primary py-1" onClick={() => setStatus(u.user_id, 'active')}>Aprobar</button>
                            </>
                          ) : u.status === 'active' ? (
                            <button className="btn btn-secondary py-1" onClick={() => setStatus(u.user_id, 'inactive')}>Desactivar</button>
                          ) : (
                            <button className="btn btn-secondary py-1" onClick={() => setStatus(u.user_id, 'active')}>Reactivar</button>
                          )}
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>
        <div className="shrink-0 border-t border-slate-800 px-4 py-2"><Pagination {...page} noun="usuarios" /></div>
      </section>
    </div>
  )
}
