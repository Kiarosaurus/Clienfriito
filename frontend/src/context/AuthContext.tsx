import {
  createContext, useContext, useState, useEffect,
  useCallback, type ReactNode,
} from 'react'
import axios from 'axios'
import { jwtDecode } from 'jwt-decode'
import api, { authHandlers } from '../api/client'

// ── Types ─────────────────────────────────────────────────────────────────────

interface JwtPayload {
  sub: string
  role: string
  exp: number
}

interface User {
  username: string
  role: string
}

interface AuthContextType {
  user: User | null
  token: string | null
  isInitializing: boolean
  isSessionExpired: boolean
  clearSessionExpired: () => void
  login: (username: string, password: string) => Promise<void>
  logout: () => void
}

// ── Context ───────────────────────────────────────────────────────────────────

const AuthContext = createContext<AuthContextType | null>(null)

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider')
  return ctx
}

// ── Provider ──────────────────────────────────────────────────────────────────

function decodeUser(token: string): User | null {
  try {
    const { sub, role, exp } = jwtDecode<JwtPayload>(token)
    if (Date.now() / 1000 > exp) return null   // expired
    return { username: sub, role }
  } catch {
    return null
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState<string | null>(null)
  const [user, setUser] = useState<User | null>(null)
  const [isInitializing, setIsInitializing] = useState(true)
  const [isSessionExpired, setIsSessionExpired] = useState(false)

  // ── Bootstrap: hydrate auth state from storage before first route render ──

  useEffect(() => {
    const stored = sessionStorage.getItem('token')
    if (stored) {
      const decoded = decodeUser(stored)
      if (decoded) {
        setToken(stored)
        setUser(decoded)
      } else {
        sessionStorage.removeItem('token')   // expired or malformed
      }
    }
    setIsInitializing(false)
  }, [])

  // ── Axios interceptors ────────────────────────────────────────────────────

  useEffect(() => {
    const reqId = api.interceptors.request.use(config => {
      const t = sessionStorage.getItem('token')
      if (t) config.headers.Authorization = `Bearer ${t}`
      return config
    })
    return () => { api.interceptors.request.eject(reqId) }
  }, [])

  // Register the session-expired callback so client.ts interceptor can signal
  // auth failure without touching React state directly.
  useEffect(() => {
    authHandlers.onSessionExpired = () => {
      sessionStorage.clear()
      setToken(null)
      setUser(null)
      setIsSessionExpired(true)
    }
    return () => { authHandlers.onSessionExpired = null }
  }, [])

  // ── Actions ───────────────────────────────────────────────────────────────

  const login = useCallback(async (username: string, password: string) => {
    // OAuth2PasswordRequestForm requires application/x-www-form-urlencoded
    const body = new URLSearchParams({ username, password })
    const { data } = await axios.post<{ access_token: string }>(
      '/api/v1/auth/login',
      body,
    )
    const decoded = decodeUser(data.access_token)
    if (!decoded) throw new Error('Token inválido recibido del servidor')
    sessionStorage.setItem('token', data.access_token)
    setToken(data.access_token)
    setUser(decoded)
  }, [])

  const logout = useCallback(() => {
    sessionStorage.removeItem('token')
    setToken(null)
    setUser(null)
  }, [])

  const clearSessionExpired = useCallback(() => {
    setIsSessionExpired(false)
  }, [])

  if (isInitializing) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-950">
        <div className="flex items-center gap-3 text-slate-400">
          <svg className="animate-spin h-5 w-5 shrink-0" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          <span className="text-sm tracking-wide">Iniciando sesión…</span>
        </div>
      </div>
    )
  }

  return (
    <AuthContext.Provider value={{ user, token, isInitializing, isSessionExpired, clearSessionExpired, login, logout }}>
      {children}
    </AuthContext.Provider>
  )
}
