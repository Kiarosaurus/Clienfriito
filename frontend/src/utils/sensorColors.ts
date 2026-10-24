// Semantic threshold levels + colors for sensor readings.
// Single source of truth shared by GlobalDashboard (metric cards + table) and
// RoomDetail (table). Dentro de rango → gris neutro (#7a96b5, texto secundario);
// fuera de rango escala amarillo (#eab308) → naranja (#f97316) → rojo (#ef4444).

export type SensorLevel = 'normal' | 'atencion' | 'elevado' | 'alerta'

export interface LevelTokens {
  text: string    // text color — icon, status text, table cell
  bar: string     // border-left accent
  ring: string    // icon chip bg + ring tint
  label: string   // human status label
}

const LEVELS: Record<SensorLevel, LevelTokens> = {
  normal:   { text: 'text-[#7a96b5]',  bar: 'border-l-[#7a96b5]',  ring: 'bg-slate-500/10 ring-slate-500/30',   label: 'Normal' },
  atencion: { text: 'text-yellow-500', bar: 'border-l-yellow-500', ring: 'bg-yellow-500/10 ring-yellow-500/30', label: 'Atención' },
  elevado:  { text: 'text-orange-500', bar: 'border-l-orange-500', ring: 'bg-orange-500/10 ring-orange-500/30', label: 'Elevado' },
  alerta:   { text: 'text-red-500',    bar: 'border-l-red-500',    ring: 'bg-red-500/10 ring-red-500/30',       label: 'Alerta' },
}

// ── Level classifiers ─────────────────────────────────────────────────────────
// Temperatura: desviación absoluta respecto al target ajustado del aula.
export function levelTemp(value: number, target: number): SensorLevel {
  const d = Math.abs(value - target)
  if (d <= 1) return 'normal'
  if (d <= 2) return 'atencion'
  if (d <= 3) return 'elevado'
  return 'alerta'
}
export function levelHumedad(value: number): SensorLevel {
  if (value < 60) return 'normal'
  if (value <= 70) return 'atencion'
  if (value <= 80) return 'elevado'
  return 'alerta'
}
export function levelCO2(value: number): SensorLevel {
  if (value < 800) return 'normal'
  if (value <= 1200) return 'atencion'
  if (value <= 1500) return 'elevado'
  return 'alerta'
}
export function levelCO(value: number): SensorLevel {
  if (value < 10) return 'normal'
  if (value <= 30) return 'atencion'
  if (value <= 50) return 'elevado'
  return 'alerta'
}

// ── Token / label accessors ───────────────────────────────────────────────────
export function sensorTokens(level: SensorLevel): LevelTokens {
  return LEVELS[level]
}
export function getStatusLabel(level: SensorLevel): string {
  return LEVELS[level].label
}

// ── Text-class helpers (reading tables) ───────────────────────────────────────
export function getColorTemp(value: number, target: number): string {
  return LEVELS[levelTemp(value, target)].text
}
export function getColorHumedad(value: number): string {
  return LEVELS[levelHumedad(value)].text
}
export function getColorCO2(value: number): string {
  return LEVELS[levelCO2(value)].text
}
export function getColorCO(value: number): string {
  return LEVELS[levelCO(value)].text
}
