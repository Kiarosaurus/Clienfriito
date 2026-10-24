import type { ReactNode } from 'react'
import type { SensorLevel } from '../utils/sensorColors'

// Shared visual system (see .claude/CLAUDE.md, design rules).
// Classes live in index.css (@layer components). Text sizes: text-xs (labels, meta),
// text-sm (body, section titles), text-xl (page titles, KPI values).

// ── Status tones ──────────────────────────────────────────────────────────────
export type Tone = 'ok' | 'warn' | 'high' | 'alert' | 'info' | 'muted'

const TONE_TEXT: Record<Tone, string> = {
  ok: 'text-emerald-300',
  warn: 'text-amber-300',
  high: 'text-orange-300',
  alert: 'text-red-300',
  info: 'text-sky-300',
  muted: 'text-slate-400',
}
const TONE_CHIP: Record<Tone, string> = {
  ok: 'chip-ok', warn: 'chip-warn', high: 'chip-high', alert: 'chip-alert', info: 'chip-info', muted: 'chip-muted',
}
const TONE_DOT: Record<Tone, string> = {
  ok: 'bg-emerald-400',
  warn: 'bg-amber-400',
  high: 'bg-orange-400',
  alert: 'bg-red-400',
  info: 'bg-sky-400',
  muted: 'bg-slate-500',
}

export const toneText = (t: Tone) => TONE_TEXT[t]

export const LEVEL_TONE: Record<SensorLevel, Tone> = {
  normal: 'ok', atencion: 'warn', elevado: 'high', alerta: 'alert',
}

// Text color for a measured value: neutral when in range, status color otherwise.
export const valueText = (l: SensorLevel) => (l === 'normal' ? 'text-slate-200' : TONE_TEXT[LEVEL_TONE[l]])

export function Chip({ tone = 'muted', dot = false, pulse = false, children, title }: {
  tone?: Tone; dot?: boolean; pulse?: boolean; children: ReactNode; title?: string
}) {
  return (
    <span
      title={title}
      className={`chip ${TONE_CHIP[tone]}`}
    >
      {dot && <span className={`h-1.5 w-1.5 rounded-full ${TONE_DOT[tone]} ${pulse ? 'animate-pulse' : ''}`} />}
      {children}
    </span>
  )
}

// ── Containers ────────────────────────────────────────────────────────────────
export function Card({ title, aside, children, className = '' }: {
  title?: ReactNode; aside?: ReactNode; children: ReactNode; className?: string
}) {
  return (
    <section className={`surface p-4 ${className}`}>
      {(title || aside) && (
        <header className="mb-3 flex flex-wrap items-center justify-between gap-2">
          {title && <h2 className="section-title">{title}</h2>}
          {aside && <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">{aside}</div>}
        </header>
      )}
      {children}
    </section>
  )
}

export function PageHeader({ title, subtitle, children }: {
  title: ReactNode; subtitle?: ReactNode; children?: ReactNode
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="page-title">{title}</h1>
        {subtitle && <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-400">{subtitle}</div>}
      </div>
      {children && <div className="flex flex-wrap items-center gap-2">{children}</div>}
    </div>
  )
}

// Compact KPI: label + status chip on top, value below. Always 72 px tall.
export function Kpi({ label, value, unit, tone, status, hint }: {
  label: string; value: string; unit?: string; tone?: Tone; status?: string; hint?: string
}) {
  return (
    <div className="surface flex h-[72px] flex-col justify-between px-3 py-2" title={hint}>
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-xs text-slate-400">{label}</span>
        {status && <Chip tone={tone}>{status}</Chip>}
      </div>
      <p className="truncate text-xl font-semibold leading-none text-white tabular-nums">
        {value}
        {unit && value !== '—' && <span className="ml-1 text-sm font-normal text-slate-400">{unit}</span>}
      </p>
    </div>
  )
}

export function Tabs<T extends string>({ value, onChange, items }: {
  value: T; onChange: (v: T) => void; items: { value: T; label: string }[]
}) {
  return (
    <div role="tablist" className="flex gap-1 border-b border-slate-800">
      {items.map(it => (
        <button
          key={it.value}
          role="tab"
          aria-selected={value === it.value}
          onClick={() => onChange(it.value)}
          className={`-mb-px border-b-2 px-3 py-2 text-sm transition-colors ${
            value === it.value
              ? 'border-blue-500 text-white'
              : 'border-transparent text-slate-400 hover:text-slate-200'
          }`}
        >
          {it.label}
        </button>
      ))}
    </div>
  )
}

// ── Formatting ────────────────────────────────────────────────────────────────
export function fmt(n: number | null | undefined, dec = 1) {
  return n == null || Number.isNaN(n) ? '—' : n.toFixed(dec)
}

// Stored timestamps are naive UTC ("YYYY-MM-DDTHH:MM:SS.ffffff"): force UTC parse.
export function parseUtc(ts: string): Date {
  return new Date(/(Z|[+-]\d\d:?\d\d)$/.test(ts) ? ts : `${ts}Z`)
}

export function timeAgo(ts: string | Date | null | undefined, now = Date.now()): string {
  if (!ts) return 'sin lecturas'
  const d = typeof ts === 'string' ? parseUtc(ts) : ts
  const s = Math.max(0, Math.round((now - d.getTime()) / 1000))
  if (s < 60) return `hace ${s} s`
  if (s < 3600) return `hace ${Math.round(s / 60)} min`
  if (s < 86400) return `hace ${Math.round(s / 3600)} h`
  return d.toLocaleString('es', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
}

export function clockTime(ts: string | Date) {
  const d = typeof ts === 'string' ? parseUtc(ts) : ts
  return d.toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

// Node setpoint (hardware/firmware/src/sketch.ino). Rooms with a node are judged
// against it, since the node is the one acting on the room.
export const NODE_SETPOINT = 24.0

// A reading counts as "live" while the node keeps publishing (it sends every 1 s).
export const LIVE_SECONDS = 30

// ── Decisions in user language ────────────────────────────────────────────────
export const NODE_STATE: Record<string, { label: string; tone: Tone }> = {
  COOLING: { label: 'Enfriando', tone: 'info' },
  PRE_COOLING: { label: 'Pre-enfriando', tone: 'info' },
  HEATING: { label: 'Calentando', tone: 'high' },
  STANDBY: { label: 'En espera', tone: 'ok' },
  DISABLED: { label: 'Aula vacía', tone: 'muted' },
}

export const AI_STATE: Record<string, { label: string; tone: Tone }> = {
  ON: { label: 'Enfriar', tone: 'info' },
  STANDBY: { label: 'En espera', tone: 'ok' },
  DISABLED: { label: 'Apagado', tone: 'muted' },
}

export const MODEL_LABEL: Record<string, string> = {
  ml: 'Modelo ML',
  heuristic: 'Fórmula heurística',
  manual: 'Manual',
  none: 'Sin modelo',
}
