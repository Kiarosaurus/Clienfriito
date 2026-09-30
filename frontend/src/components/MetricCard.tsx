import type { ReactNode } from 'react'
import { AlertTriangle, TrendingUp } from 'lucide-react'

// ── Status color system ───────────────────────────────────────────────────────
// Single source of truth for the "estado de un vistazo" palette used across every
// metric card in the app. Verde=Normal, Amarillo=Atención, Naranja=Elevado, Rojo=Alerta.
export type MetricStatus = 'normal' | 'warning' | 'elevated' | 'alert'

interface StatusTokens {
  bar: string    // left accent bar
  ring: string   // icon chip ring + tint
  icon: string   // icon / sub-text color
  dot: string    // legend dot bg
  label: string  // human label
}

export const STATUS_TOKENS: Record<MetricStatus, StatusTokens> = {
  normal:   { bar: 'border-l-emerald-500', ring: 'bg-emerald-500/10 ring-emerald-500/30', icon: 'text-emerald-400', dot: 'bg-emerald-500', label: 'Normal' },
  warning:  { bar: 'border-l-amber-400',   ring: 'bg-amber-400/10 ring-amber-400/30',     icon: 'text-amber-400',   dot: 'bg-amber-400',   label: 'Atención' },
  elevated: { bar: 'border-l-orange-500',  ring: 'bg-orange-500/10 ring-orange-500/30',   icon: 'text-orange-400',  dot: 'bg-orange-500',  label: 'Elevado' },
  alert:    { bar: 'border-l-red-500',     ring: 'bg-red-500/10 ring-red-500/30',         icon: 'text-red-400',     dot: 'bg-red-500',     label: 'Alerta' },
}

// ── Threshold helpers ─────────────────────────────────────────────────────────
export function tempStatus(t?: number | null): MetricStatus {
  if (t == null) return 'normal'
  if (t > 40) return 'alert'
  if (t > 30) return 'elevated'
  if (t > 27) return 'warning'
  return 'normal'
}
export function humidityStatus(h?: number | null): MetricStatus {
  if (h == null) return 'normal'
  if (h > 95) return 'alert'
  if (h > 70) return 'warning'
  return 'normal'
}
export function co2Status(c?: number | null): MetricStatus {
  if (c == null) return 'normal'
  if (c > 1500) return 'alert'
  if (c > 800) return 'elevated'
  if (c > 600) return 'warning'
  return 'normal'
}
export function coStatus(c?: number | null): MetricStatus {
  if (c == null) return 'normal'
  if (c > 50) return 'alert'
  if (c > 35) return 'elevated'
  if (c > 9) return 'warning'
  return 'normal'
}

// Default sub-line glyph: trend arrow when calm, warning triangle when not.
function defaultStatusIcon(status: MetricStatus): ReactNode {
  return status === 'normal'
    ? <TrendingUp size={12} />
    : <AlertTriangle size={12} />
}

// ── Card ──────────────────────────────────────────────────────────────────────
export function MetricCard({
  icon, label, value, unit, status = 'normal', statusText, statusIcon, sub, tone,
}: {
  icon: ReactNode
  label: string
  value: string
  unit?: string
  status?: MetricStatus
  statusText?: string
  statusIcon?: ReactNode | null  // null → suppress glyph, undefined → default glyph
  sub?: string                   // neutral descriptor shown when no status text
  tone?: { bar: string; ring: string; icon: string }  // override accent (border/chip/text)
}) {
  const t = tone ? { ...STATUS_TOKENS[status], ...tone } : STATUS_TOKENS[status]
  const glyph = statusIcon === null ? null : (statusIcon ?? defaultStatusIcon(status))
  return (
    <div className={`group bg-slate-800/60 border border-slate-700/60 border-l-4 ${t.bar} rounded-xl p-4 flex flex-col gap-3 transition-colors hover:bg-slate-800`}>
      <span className={`w-9 h-9 rounded-lg ring-1 flex items-center justify-center ${t.ring} ${t.icon}`}>
        {icon}
      </span>
      <div>
        <p className="text-xs text-slate-400">{label}</p>
        <p className="text-2xl font-bold text-white leading-tight tabular-nums">
          {value}
          {unit && <span className="text-sm font-medium text-slate-400 ml-0.5">{unit}</span>}
        </p>
      </div>
      {(statusText || sub) && (
        <div className="flex flex-col gap-0.5">
          {statusText && (
            <p className={`flex items-center gap-1 text-xs font-medium ${t.icon}`}>{glyph}{statusText}</p>
          )}
          {sub && <p className="text-xs text-slate-500">{sub}</p>}
        </div>
      )}
    </div>
  )
}

// ── Legend ────────────────────────────────────────────────────────────────────
// Compact "sistema de colores de estado" strip — reusable wherever the palette
// needs explaining.
export function StatusLegend({ className = '' }: { className?: string }) {
  const items: [MetricStatus, string][] = [
    ['normal', 'dentro de rango'],
    ['warning', 'revisa pronto'],
    ['elevated', 'acción sugerida'],
    ['alert', 'intervención urgente'],
  ]
  return (
    <div className={`flex flex-wrap items-center gap-x-5 gap-y-2 ${className}`}>
      {items.map(([s, desc]) => {
        const t = STATUS_TOKENS[s]
        return (
          <span key={s} className="flex items-center gap-2 text-xs">
            <span className={`w-2.5 h-2.5 rounded-full ${t.dot}`} />
            <span className="font-semibold text-slate-200">{t.label}</span>
            <span className="text-slate-500">· {desc}</span>
          </span>
        )
      })}
    </div>
  )
}
