import { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react'
import { useAuth } from './AuthContext'
import api from '../api/client'

export interface EmergencyEntry {
  room_id: string
  room_name: string
  sensor_id: string
  co_ppm: number | null
  is_simulated: boolean
  timestamp: string
  // CS5055 (opcionales): alarma local del nodo (buzzer/LED, ventilador 100 %)
  // frente a detección solo en servidor por co_ppm > 50.
  alarm_active?: boolean | null
  fan_pwm?: number | null
  source?: 'local' | 'servidor' | null
}

interface EmergencyContextType {
  realEmergencies: EmergencyEntry[]
  simulatedEmergencies: EmergencyEntry[]
  isEmergency: boolean
  isPopupDismissed: boolean
  dismissPopup: () => void
  reopenPopup: () => void
  clearSimulated: () => void
}

const EmergencyContext = createContext<EmergencyContextType>({
  realEmergencies: [],
  simulatedEmergencies: [],
  isEmergency: false,
  isPopupDismissed: false,
  dismissPopup: () => {},
  reopenPopup: () => {},
  clearSimulated: () => {},
})

export function useEmergency() {
  return useContext(EmergencyContext)
}

export function EmergencyProvider({ children }: { children: React.ReactNode }) {
  const { user, token } = useAuth()
  const [realEmergencies, setRealEmergencies]         = useState<EmergencyEntry[]>([])
  const [simulatedEmergencies, setSimulatedEmergencies] = useState<EmergencyEntry[]>([])
  const [isPopupDismissed, setIsPopupDismissed]       = useState(false)

  // Key = roomId:isSimulated — detects new entries to reopen popup
  const prevKeysRef = useRef<Set<string>>(new Set())

  // A CO alarm is safety information: every authenticated role polls it (guest
  // included), and the state is NOT wiped on route changes — a real alarm must
  // stay visible wherever the user navigates. Layout decides what to show where.
  const canPoll = !!user

  const poll = useCallback(async () => {
    if (!canPoll || !token) return
    try {
      // Shared axios client: injects X-API-Key (client.ts) and the Bearer token
      // (AuthContext interceptor) — a raw fetch here missed the API key and the
      // router-wide require_api_key gate returned 403, so emergencies never showed.
      const { data } = await api.get<{ real: EmergencyEntry[]; simulated: EmergencyEntry[] }>('/sensors/emergencies')

      const real      = Array.isArray(data?.real)      ? data.real      : []
      const simulated = Array.isArray(data?.simulated) ? data.simulated : []

      console.log('Emergencias recibidas:', { real: real.length, simulated: simulated.length })

      setRealEmergencies(real)
      setSimulatedEmergencies(simulated)

      const entries = [...real, ...simulated]

      if (entries.length === 0) {
        prevKeysRef.current = new Set()
        setIsPopupDismissed(false)
        return
      }

      // Reopen popup when a room not seen before appears
      const currentKeys = new Set(entries.map(e => `${e.room_id}:${e.is_simulated}`))
      const hasNewEntry = [...currentKeys].some(k => !prevKeysRef.current.has(k))
      if (hasNewEntry) setIsPopupDismissed(false)
      prevKeysRef.current = currentKeys
    } catch {
      // Network/auth errors must not crash or spam the user
    }
  }, [canPoll, token])

  useEffect(() => {
    if (!canPoll) {
      setRealEmergencies([])
      setSimulatedEmergencies([])
      return
    }
    poll()
    const id = setInterval(poll, 5_000)
    return () => clearInterval(id)
  }, [canPoll, poll])

  const isEmergency = realEmergencies.length > 0 || simulatedEmergencies.length > 0

  // Instant local wipe of simulated alerts — the dashboard calls this right
  // after DELETE /sensors/simulated so the orange state drops without waiting
  // for the next polling cycle.
  const clearSimulated = useCallback(() => {
    setSimulatedEmergencies([])
    prevKeysRef.current = new Set([...prevKeysRef.current].filter(k => !k.endsWith(':true')))
  }, [])

  return (
    <EmergencyContext.Provider
      value={{
        realEmergencies,
        simulatedEmergencies,
        isEmergency,
        isPopupDismissed,
        dismissPopup: () => setIsPopupDismissed(true),
        reopenPopup: () => setIsPopupDismissed(false),
        clearSimulated,
      }}
    >
      {children}
    </EmergencyContext.Provider>
  )
}
