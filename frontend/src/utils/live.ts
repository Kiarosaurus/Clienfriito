// Estado "en vivo" compartido por las vistas (CS5055):
//  - useHealth(): un único sondeo de /health (15 s) para todas las vistas montadas.
//    Indica quién controla, si el ML está cargado y si el puente MQTT está activo.
//  - useNow(): reloj que fuerza a recalcular "en línea / hace X s" sin nuevas lecturas.
import { useEffect, useState, useSyncExternalStore } from 'react'
import axios from 'axios'
import type { HealthInfo } from '../types'

const HEALTH_POLL_MS = 15_000

type HealthSnapshot = { data: HealthInfo | null; online: boolean | null; fetchedAt: number | null }

let snapshot: HealthSnapshot = { data: null, online: null, fetchedAt: null }
const listeners = new Set<() => void>()
let timer: ReturnType<typeof setInterval> | null = null
let inflight = false

function emit(next: HealthSnapshot) {
  snapshot = next
  listeners.forEach(l => l())
}

export async function refreshHealth() {
  if (inflight) return
  inflight = true
  try {
    const { data } = await axios.get<HealthInfo>('/health')
    emit({ data: data ?? null, online: true, fetchedAt: Date.now() })
  } catch {
    emit({ data: snapshot.data, online: false, fetchedAt: Date.now() })
  } finally {
    inflight = false
  }
}

function subscribe(cb: () => void) {
  listeners.add(cb)
  if (!timer) {
    refreshHealth()
    timer = setInterval(refreshHealth, HEALTH_POLL_MS)
  }
  return () => {
    listeners.delete(cb)
    if (listeners.size === 0 && timer) {
      clearInterval(timer)
      timer = null
    }
  }
}

export function useHealth(): HealthSnapshot {
  return useSyncExternalStore(subscribe, () => snapshot)
}

/** true solo si /health confirma el puente MQTT conectado. */
export function mqttConnected(h: HealthInfo | null | undefined): boolean {
  return h?.mqtt === 'connected'
}

/** Rótulo honesto de la vía de ingesta (no afirma MQTT si el puente no está conectado). */
export function ingestLabel(h: HealthInfo | null | undefined): string {
  if (mqttConnected(h)) return 'telemetría MQTT (puente conectado)'
  if (h?.mqtt === 'disconnected') return 'ingesta HTTP (puente MQTT desconectado)'
  return 'ingesta HTTP (puente MQTT desactivado)'
}

/** Reloj de pared que se actualiza cada `ms` (por defecto 5 s). */
export function useNow(ms = 5_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(t)
  }, [ms])
  return now
}

/** Texto "actualizado hace X s" para la última recarga de datos. */
export function updatedAgo(lastMs: number | null, now: number): string {
  if (lastMs == null) return 'sin actualizar'
  const s = Math.max(0, Math.round((now - lastMs) / 1000))
  return s < 60 ? `actualizado hace ${s} s` : `actualizado hace ${Math.round(s / 60)} min`
}
