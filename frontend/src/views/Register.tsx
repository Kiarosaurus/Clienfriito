import { useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { UserPlus, AlertCircle, RefreshCw, CheckCircle2 } from 'lucide-react'
import axios from 'axios'
import { getApiErrorDetail } from '../api/client'
import Logo from '../components/Logo'

const ROLES = ['guest', 'collaborator', 'admin'] as const

const ROLE_LABELS: Record<typeof ROLES[number], string> = {
  guest:        'Visitante',
  collaborator: 'Colaborador',
  admin:        'Administrador',
}

export default function Register() {
  const navigate = useNavigate()
  const [form, setForm] = useState({ username: '', password: '', role: 'guest' as typeof ROLES[number] })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  const [resultStatus, setResultStatus] = useState<string>('')

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError(null)
    try {
      const { data } = await axios.post('/api/v1/auth/register', form)
      setResultStatus(data.status)
      setDone(true)
    } catch (err: unknown) {
      const detail = getApiErrorDetail(err)
      setError(detail ?? 'Error al registrar usuario.')
    } finally {
      setLoading(false)
    }
  }

  if (done) {
    return (
      <div className="min-h-screen bg-slate-900 flex items-center justify-center px-4">
        <div className="w-full max-w-sm text-center space-y-4">
          <CheckCircle2 size={48} className="text-emerald-400 mx-auto" />
          <h2 className="text-xl font-bold text-white">Cuenta creada</h2>
          {resultStatus === 'pending' ? (
            <p className="text-slate-400 text-sm">
              Tu cuenta está <span className="text-amber-400 font-semibold">pendiente de aprobación</span>.
              Un administrador debe activarla antes de que puedas iniciar sesión.
            </p>
          ) : (
            <p className="text-slate-400 text-sm">
              Tu cuenta está <span className="text-emerald-400 font-semibold">activa</span>.
              Ya puedes iniciar sesión.
            </p>
          )}
          <button
            onClick={() => navigate('/login')}
            className="w-full bg-blue-600 hover:bg-blue-500 text-white font-semibold py-2.5 rounded-lg text-sm transition-colors mt-2"
          >
            Ir al login
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-slate-900 flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-blue-600/15 border border-blue-500/30 mb-4">
            <Logo size={40} />
          </div>
          <h1 className="text-2xl font-bold text-white">Climate Cognitive</h1>
          <p className="text-slate-400 text-sm mt-1">Crear cuenta</p>
        </div>

        <div className="bg-slate-800 border border-slate-700 rounded-2xl p-8 shadow-xl">
          <h2 className="text-lg font-semibold text-slate-100 mb-6">Registro</h2>

          {error && (
            <div className="flex items-center gap-2 bg-red-900/30 border border-red-500/40 rounded-lg px-4 py-3 mb-5 text-sm text-red-300">
              <AlertCircle size={16} className="shrink-0" />
              {error}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1.5 uppercase tracking-wide" htmlFor="reg-username">Usuario</label>
              <input
                id="reg-username"
                type="text"
                required
                value={form.username}
                onChange={e => setForm(f => ({ ...f, username: e.target.value }))}
                placeholder="mi_usuario"
                className="w-full bg-slate-700 border border-slate-600 rounded-lg px-4 py-2.5 text-slate-100 text-sm placeholder-slate-500 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500/50 transition"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1.5 uppercase tracking-wide" htmlFor="reg-password">Contraseña</label>
              <input
                id="reg-password"
                type="password"
                required
                minLength={6}
                value={form.password}
                onChange={e => setForm(f => ({ ...f, password: e.target.value }))}
                placeholder="••••••••"
                className="w-full bg-slate-700 border border-slate-600 rounded-lg px-4 py-2.5 text-slate-100 text-sm placeholder-slate-500 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500/50 transition"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1.5 uppercase tracking-wide" htmlFor="reg-role">Rol</label>
              <select
                id="reg-role"
                value={form.role}
                onChange={e => setForm(f => ({ ...f, role: e.target.value as typeof ROLES[number] }))}
                className="w-full bg-slate-700 border border-slate-600 rounded-lg px-4 py-2.5 text-slate-100 text-sm focus:outline-none focus:border-blue-500 transition"
              >
                {ROLES.map(r => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
              </select>
              {form.role !== 'guest' && (
                <p className="text-xs text-amber-400 mt-1.5">
                  Este rol requiere aprobación de un administrador.
                </p>
              )}
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-500 disabled:bg-slate-600 disabled:cursor-not-allowed text-white font-semibold py-2.5 rounded-lg text-sm transition-colors mt-2"
            >
              {loading ? <><RefreshCw size={16} className="animate-spin" /> Creando…</> : <><UserPlus size={16} /> Crear cuenta</>}
            </button>
          </form>
        </div>

        <p className="text-center text-slate-500 text-xs mt-4">
          ¿Ya tienes cuenta?{' '}
          <Link to="/login" className="text-blue-400 hover:underline">Iniciar sesión</Link>
        </p>
      </div>
    </div>
  )
}
