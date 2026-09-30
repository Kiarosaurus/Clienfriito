import { lazy, Suspense, type ReactNode } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { useAuth } from './context/AuthContext'
import { EmergencyProvider } from './context/EmergencyContext'
import Layout from './components/Layout'
import Login from './components/Login'
import GlobalDashboard from './views/GlobalDashboard'
import RoomSearch from './views/RoomSearch'
import SensorSearch from './views/SensorSearch'
import Reservations from './views/Reservations'
import UserManagement from './views/UserManagement'
import Infrastructure from './views/Infrastructure'
import Register from './views/Register'

// Chart-heavy views load on demand — keeps Recharts out of the initial bundle.
const RoomDetail = lazy(() => import('./views/RoomDetail'))
const ROIReport  = lazy(() => import('./views/ROIReport'))

function RouteFallback() {
  return (
    <div className="flex items-center justify-center h-64 text-slate-500 text-sm">
      Cargando…
    </div>
  )
}

/** Redirects unauthenticated users to /login. When session expires, renders
 *  children so Layout's session-expired modal can display instead of hard redirect. */
function ProtectedRoute({ children }: { children: ReactNode }) {
  const { token, isInitializing, isSessionExpired } = useAuth()
  if (isInitializing) return null
  if (!token && !isSessionExpired) return <Navigate to="/login" replace />
  return <>{children}</>
}

/** RBAC gate: allows only users with role='admin'. Others land on the dashboard. */
function AdminRoute({ children }: { children: ReactNode }) {
  const { user, token, isInitializing, isSessionExpired } = useAuth()
  if (isInitializing) return null
  if (isSessionExpired) return null  // Layout's modal covers the screen
  if (!token) return <Navigate to="/login" replace />
  if (user?.role !== 'admin') return <Navigate to="/" replace />
  return <>{children}</>
}

/** RBAC gate: allows admin + collaborator. Guests are redirected to the dashboard. */
function CollaboratorRoute({ children }: { children: ReactNode }) {
  const { user, token, isInitializing, isSessionExpired } = useAuth()
  if (isInitializing) return null
  if (isSessionExpired) return null  // Layout's modal covers the screen
  if (!token) return <Navigate to="/login" replace />
  if (user?.role === 'guest') return <Navigate to="/" replace />
  return <>{children}</>
}

export default function App() {
  return (
    <BrowserRouter>
      <EmergencyProvider>
      <Suspense fallback={<RouteFallback />}>
      <Routes>
        {/* Public */}
        <Route path="/login"    element={<Login />} />
        <Route path="/register" element={<Register />} />

        {/* Protected — Layout wraps all */}
        <Route
          element={
            <ProtectedRoute>
              <Layout />
            </ProtectedRoute>
          }
        >
          <Route index element={<GlobalDashboard />} />
          <Route path="rooms"        element={<RoomSearch />} />
          <Route path="room/:id"     element={<RoomDetail />} />
          <Route
            path="sensors"
            element={
              <AdminRoute>
                <SensorSearch />
              </AdminRoute>
            }
          />
          <Route
            path="reservations"
            element={
              <CollaboratorRoute>
                <Reservations />
              </CollaboratorRoute>
            }
          />
          <Route
            path="admin/users"
            element={
              <AdminRoute>
                <UserManagement />
              </AdminRoute>
            }
          />
          <Route
            path="infrastructure"
            element={
              <AdminRoute>
                <Infrastructure />
              </AdminRoute>
            }
          />
          <Route
            path="roi"
            element={
              <AdminRoute>
                <ROIReport />
              </AdminRoute>
            }
          />
        </Route>

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      </Suspense>
      </EmergencyProvider>
    </BrowserRouter>
  )
}
