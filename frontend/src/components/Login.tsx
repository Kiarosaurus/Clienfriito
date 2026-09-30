import { useState, type FormEvent } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { LogIn, AlertCircle, RefreshCw } from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import { getApiErrorDetail } from '../api/client'
import Logo from './Logo'

export default function Login() {
  const { login } = useAuth()
  const navigate = useNavigate()

  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError(null)
    try {
      await login(username, password)
      navigate('/', { replace: true })
    } catch (err: unknown) {
      const detail =
        getApiErrorDetail(err)
      setError(detail ?? 'Credenciales incorrectas. Inténtalo de nuevo.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-slate-900 flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        {/* Logo / Title */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-blue-600/15 border border-blue-500/30 mb-4">
            <Logo size={40} />
          </div>
          <h1 className="text-2xl font-bold text-white">Climate Cognitive</h1>
          <p className="text-slate-400 text-sm mt-1">Sistema de Monitoreo IoT</p>
        </div>

        {/* Card */}
        <div className="bg-slate-800 border border-slate-700 rounded-2xl p-8 shadow-xl">
          <h2 className="text-lg font-semibold text-slate-100 mb-6">Iniciar sesión</h2>

          {error && (
            <div className="flex items-center gap-2 bg-red-900/30 border border-red-500/40 rounded-lg px-4 py-3 mb-5 text-sm text-red-300">
              <AlertCircle size={16} className="shrink-0" />
              {error}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label htmlFor="login-username" className="block text-xs font-medium text-slate-400 mb-1.5 uppercase tracking-wide">
                Usuario
              </label>
              <input
                id="login-username"
                type="text"
                required
                autoComplete="username"
                value={username}
                onChange={e => setUsername(e.target.value)}
                placeholder="admin"
                className="w-full bg-slate-700 border border-slate-600 rounded-lg px-4 py-2.5 text-slate-100 text-sm placeholder-slate-500 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500/50 transition"
              />
            </div>

            <div>
              <label htmlFor="login-password" className="block text-xs font-medium text-slate-400 mb-1.5 uppercase tracking-wide">
                Contraseña
              </label>
              <input
                id="login-password"
                type="password"
                required
                autoComplete="current-password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder="••••••••"
                className="w-full bg-slate-700 border border-slate-600 rounded-lg px-4 py-2.5 text-slate-100 text-sm placeholder-slate-500 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500/50 transition"
              />
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-500 disabled:bg-slate-600 disabled:cursor-not-allowed text-white font-semibold py-2.5 rounded-lg text-sm transition-colors mt-2"
            >
              {loading ? (
                <><RefreshCw size={16} className="animate-spin" /> Verificando…</>
              ) : (
                <><LogIn size={16} /> Entrar</>
              )}
            </button>
          </form>
        </div>

        <p className="text-center text-slate-500 text-xs mt-4">
          ¿No tienes cuenta?{' '}
          <Link to="/register" className="text-blue-400 hover:underline">Registrarse</Link>
        </p>
      </div>
    </div>
  )
}
