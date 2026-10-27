// Widgets del nodo ESP32 reutilizados por GlobalDashboard y RoomDetail (CS5055).
import type { ReactNode } from 'react'
import {
  Wifi, WifiOff, FlaskConical, Fan, Flame, BellRing, Bell, Zap, Gauge,
  Activity, ShieldCheck, Timer, Thermometer, GitCompare, Users, Siren, Repeat,
  Sigma, BrainCircuit, HelpCircle, Cpu, ShieldAlert,
} from 'lucide-react'
import type { CognitiveAction, DecisionState, HealthInfo, NodeMetrics, NodeTelemetry, OriginFilter, ReadingPower } from '../types'
import {
  decisionOf, decisionTokens, nodeOnline, ago, fanPwmOf, powerOf, fmtNum,
  formatDuration, mqttTopic, LATENCY_TARGET_MS, readingOrigin, originLabel, parseUtcMs,
  POWER_BASIS_TEXT, type LwtEntry, type OnlineState,
} from '../utils/node'
import { useHealth, mqttConnected, ingestLabel } from '../utils/live'

/** LWT del aula según /health, solo si el puente MQTT está conectado. */
export function lwtFor(health: HealthInfo | null | undefined, roomId: string | null | undefined): LwtEntry | null {
  if (!roomId || !mqttConnected(health)) return null
  return health?.node_status?.[roomId] ?? null
}

/** Periodo de muestreo conocido de la ventana de KPI (para el umbral de antigüedad). */
export function intervalOf(m: NodeMetrics | null | undefined): number | null {
  return m?.availability?.nominal_period_s ?? m?.data_quality?.median_interval_s ?? null
}

/** Estado del enlace con la misma prioridad en todas las vistas: LWT → antigüedad. */
export function useNodeOnline(
  reading: { timestamp?: string } | null | undefined,
  now: number | undefined,
  roomId?: string | null,
  intervalS?: number | null,
): OnlineState {
  const { data: health } = useHealth()
  return nodeOnline(reading, now, { lwt: lwtFor(health, roomId), intervalS })
}

// ── Badges ────────────────────────────────────────────────────────────────────

export function DecisionBadge({ state, className = '' }: { state: DecisionState | null; className?: string }) {
  const t = decisionTokens(state)
  return (
    <span title={t.desc} className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-0.5 text-[11px] font-semibold ${t.pill} ${className}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${t.dot}`} />
      {t.label}
    </span>
  )
}

/** Fail-safe local: con alarma CO el firmware fuerza el ventilador al 100 % e ignora la decisión del servidor. */
export function AlarmOverrideBadge({ reading }: { reading: { alarm_active?: boolean | null } | null | undefined }) {
  if (reading?.alarm_active !== true) return null
  return (
    <span
      title="Alarma CO local: el nodo fuerza el ventilador al 100 % y activa buzzer/LED; la decisión del servidor queda en pausa (fail-safe)."
      className="inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-[10px] font-bold text-red-200 bg-red-500/20 border-red-500/50"
    >
      <ShieldAlert size={11} /> OVERRIDE CO (local)
    </span>
  )
}

/** Texto que explica por qué la decisión mostrada no coincide con el ventilador al 100 %. */
export function overrideNote(reading: { alarm_active?: boolean | null } | null | undefined, action: Partial<CognitiveAction> | null | undefined): string | null {
  if (reading?.alarm_active !== true) return null
  const st = decisionOf(action)
  return `Decisión del servidor: ${st ?? 'sin decisión'}, ignorada por el fail-safe local (ventilador 100 %).`
}

export function NodeLinkBadge({ reading, now, roomId, intervalS }: {
  reading: (NodeTelemetry & { timestamp?: string }) | null
  now?: number
  roomId?: string | null
  intervalS?: number | null
}) {
  const st = useNodeOnline(reading, now, roomId, intervalS)
  const staleTxt = formatDuration(st.staleMs / 1000)
  const title = st.source === 'lwt'
    ? `Estado según el LWT del broker MQTT (${mqttTopic(roomId, 'status')})${st.lwtSinceMs != null ? `, desde ${new Date(st.lwtSinceMs).toLocaleTimeString('es')}` : ''}; tiene prioridad sobre la antigüedad de la lectura`
    : st.source === 'inferido'
      ? `Sin LWT del broker: inferido por la antigüedad de la última lectura (≤ ${staleTxt} = en línea; umbral = máx(3 × periodo de muestreo, 30 s))`
      : 'Sin lecturas del nodo'
  if (st.online == null) {
    return (
      <span title={title} className="inline-flex items-center gap-1 text-[11px] text-slate-500 bg-slate-800 border border-slate-700 rounded-full px-2 py-0.5">
        <HelpCircle size={11} /> Nodo sin dato
      </span>
    )
  }
  return (
    <span title={title} className={`inline-flex items-center gap-1 text-[11px] font-medium rounded-full px-2 py-0.5 border ${
      st.online
        ? 'text-emerald-300 bg-emerald-500/10 border-emerald-500/30'
        : 'text-red-300 bg-red-500/10 border-red-500/30'
    }`}>
      {st.online ? <Wifi size={11} /> : <WifiOff size={11} />}
      {st.online ? 'En línea' : 'Fuera de línea'}
      <span className="opacity-60 font-normal">· {st.source === 'lwt' ? 'LWT' : 'por antigüedad'}</span>
    </span>
  )
}

/** Solo para lecturas sintéticas (compatibilidad con vistas previas). */
export function SimulatedBadge({ reading, compact = false }: {
  reading: { is_simulated?: boolean | null; data_origin?: string | null } | null | undefined
  compact?: boolean
}) {
  if (readingOrigin(reading) !== 'simulado') return null
  return (
    <span title="Dato sintético: no proviene del nodo físico (A403)" className="inline-flex items-center gap-1 text-[10px] font-medium text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded-full px-2 py-0.5 whitespace-nowrap">
      <FlaskConical size={10} /> {compact ? 'Simulado' : originLabel(reading!)}
    </span>
  )
}

/** Procedencia de cualquier lectura: Nodo físico (marca explícita) / Simulado / Origen no declarado. */
export function OriginBadge({ reading, compact = false }: {
  reading: { is_simulated?: boolean | null; data_origin?: string | null } | null | undefined
  compact?: boolean
}) {
  if (!reading) return null
  const o = readingOrigin(reading)
  if (o === 'simulado') return <SimulatedBadge reading={reading} compact={compact} />
  if (o === 'node') {
    return (
      <span title="Lectura marcada data_origin='node' por el firmware o el puente MQTT" className="inline-flex items-center gap-1 text-[10px] font-medium text-emerald-300 bg-emerald-500/10 border border-emerald-500/30 rounded-full px-2 py-0.5 whitespace-nowrap">
        <Cpu size={10} /> Nodo físico
      </span>
    )
  }
  return (
    <span title="La lectura no declara procedencia (data_origin): no se asume que provenga del nodo físico" className="inline-flex items-center gap-1 text-[10px] font-medium text-slate-400 bg-slate-700/50 border border-slate-600 rounded-full px-2 py-0.5 whitespace-nowrap">
      <HelpCircle size={10} /> {compact ? 'Sin origen' : 'Origen no declarado'}
    </span>
  )
}

/** Conmutador de procedencia para KPI: solo nodo físico / todas. */
export function OriginToggle({ value, onChange }: { value: OriginFilter; onChange: (v: OriginFilter) => void }) {
  const opts: { v: OriginFilter; label: string }[] = [
    { v: 'node', label: 'Solo nodo físico' },
    { v: 'all', label: 'Todas (incl. simuladas)' },
  ]
  return (
    <div className="flex items-center gap-0.5 bg-slate-900/60 border border-slate-700 rounded-lg p-0.5">
      {opts.map(o => (
        <button
          key={o.v}
          type="button"
          onClick={() => onChange(o.v)}
          className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors ${
            value === o.v ? 'bg-slate-700 text-white' : 'text-slate-400 hover:text-slate-100'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

/** Aviso del respaldo automático "Solo nodo físico" → "Todas" (FE-3-03). */
export function OriginFallbackNotice({ active }: { active: boolean }) {
  if (!active) return null
  return (
    <div className="flex items-start gap-2 bg-amber-900/20 border border-amber-500/40 rounded-lg px-3 py-2 mb-3 text-xs text-amber-300">
      <FlaskConical size={13} className="shrink-0 mt-0.5" />
      <span>
        <strong>Sin lecturas del nodo físico</strong> (data_origin = “node”) en la ventana: se muestran todas las lecturas,
        de origen no declarado o simulado. No deben leerse como mediciones del nodo físico. Vuelve a
        “Solo nodo físico” cuando el firmware publique con esa marca.
      </span>
    </div>
  )
}

/** Resumen de procedencia de la ventana de KPI. */
export function originSummary(m: NodeMetrics | null): string | null {
  if (!m) return null
  const all = m.origin_counts_all
  const c = m.origin_counts
  const scope = m.origin_filter === 'node' ? 'solo nodo físico' : 'todas las lecturas'
  if (!all || !c) {
    return `${m.samples} lecturas${m.simulated_samples > 0 ? ` · ${m.simulated_samples} simuladas` : ''}`
  }
  return `${m.samples} lecturas (${scope}) · en la ventana: ${all.node} del nodo físico, ${all.simulado} simuladas, ${all.desconocido} sin origen declarado`
}

// ── Panel de actuadores ───────────────────────────────────────────────────────

function SourceTag({ source }: { source: string }) {
  const cls = source === 'medido' || source === 'reportado'
    ? 'text-emerald-400/80'
    : source === 'sin dato' ? 'text-slate-500' : 'text-amber-400/80'
  return <span className={`text-[10px] uppercase tracking-wide ${cls}`}>{source}</span>
}

export function ActuatorPanel({ reading, action }: {
  reading: (NodeTelemetry & { timestamp?: string; co_ppm?: number | null; power?: ReadingPower | null }) | null
  action?: Partial<CognitiveAction> | null
}) {
  const fan = fanPwmOf(reading, action)
  const pw: ReadingPower | null = powerOf(reading)
  const scopeNode = pw?.ina219_scope === 'node'
  const branchW = scopeNode ? pw?.total_w ?? null : pw?.actuator_w ?? null
  const alarm = reading?.alarm_active
  const heater = reading?.heater_on
  const note = overrideNote(reading, action)
  return (
    <div className="space-y-3">
      {note && (
        <div className="flex items-center gap-2 bg-red-900/30 border border-red-500/40 rounded-lg px-3 py-2 text-xs text-red-200">
          <AlarmOverrideBadge reading={reading} /> {note}
        </div>
      )}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
        {/* Ventilador PWM */}
        <div className="bg-slate-900/50 border border-slate-700/50 rounded-lg p-3">
          <div className="flex items-center justify-between mb-2">
            <p className="flex items-center gap-1.5 text-xs text-slate-400"><Fan size={13} className={fan.value ? 'text-sky-400 animate-spin [animation-duration:2s]' : 'text-slate-500'} /> Ventilador 12 V (PWM)</p>
            <SourceTag source={fan.source} />
          </div>
          <p className="text-xl font-bold text-white tabular-nums">{fmtNum(fan.value, ' %', 0)}</p>
          <div className="mt-2 h-1.5 rounded-full bg-slate-700 overflow-hidden">
            <div className="h-full bg-sky-500 transition-all" style={{ width: `${Math.max(0, Math.min(100, fan.value ?? 0))}%` }} />
          </div>
          <p className="text-[11px] text-slate-500 mt-1">
            {fan.source === 'reportado' ? 'Ciclo aplicado, reportado por el nodo (sin tacómetro)'
              : fan.source === 'comandado' ? 'Comando del servidor; el nodo aún no reporta el ciclo aplicado' : 'Sin dato'}
          </p>
        </div>
        {/* PTC */}
        <div className="bg-slate-900/50 border border-slate-700/50 rounded-lg p-3">
          <div className="flex items-center justify-between mb-2">
            <p className="flex items-center gap-1.5 text-xs text-slate-400"><Flame size={13} className={heater ? 'text-orange-400' : 'text-slate-500'} /> Calefactor PTC 12 V</p>
            <SourceTag source={heater == null ? 'sin dato' : 'reportado'} />
          </div>
          <p className={`text-xl font-bold ${heater ? 'text-orange-300' : heater === false ? 'text-slate-300' : 'text-slate-500'}`}>
            {heater == null ? 'Sin dato' : heater ? 'Encendido' : 'Apagado'}
          </p>
          <p className="text-[11px] text-slate-500 mt-1">Montaje por confirmar</p>
        </div>
        {/* Buzzer + LED */}
        <div className={`border rounded-lg p-3 ${alarm ? 'bg-red-900/30 border-red-500/50' : 'bg-slate-900/50 border-slate-700/50'}`}>
          <div className="flex items-center justify-between mb-2">
            <p className="flex items-center gap-1.5 text-xs text-slate-400">
              {alarm ? <BellRing size={13} className="text-red-400" /> : <Bell size={13} className="text-slate-500" />} Buzzer + LED RGB
            </p>
            <SourceTag source={alarm == null ? 'sin dato' : 'reportado'} />
          </div>
          <p className={`text-xl font-bold ${alarm ? 'text-red-300' : alarm === false ? 'text-slate-300' : 'text-slate-500'}`}>
            {alarm == null ? 'Sin dato' : alarm ? 'Alarma local' : 'Reposo'}
          </p>
          <p className="text-[11px] text-slate-500 mt-1">
            {alarm
              ? 'Fail-safe activo · ventilador forzado al 100 %'
              : 'Se dispara en el nodo con CO > 50 ppm, aun sin red (no depende del servidor)'}
          </p>
        </div>
        {/* INA219 — desglose calculado por el backend (misma regla que /roi) */}
        <div className="bg-slate-900/50 border border-slate-700/50 rounded-lg p-3">
          <div className="flex items-center justify-between mb-2">
            <p className="flex items-center gap-1.5 text-xs text-slate-400">
              <Zap size={13} className="text-yellow-400" /> {scopeNode ? 'Nodo total (INA219)' : 'Rama ventilador (INA219)'}
            </p>
            <SourceTag source={!pw || branchW == null ? 'sin dato' : pw.actuator_measured ? 'medido' : 'estimado'} />
          </div>
          <p className="text-xl font-bold text-white tabular-nums">{fmtNum(branchW, ' W', 2)}</p>
          <p className="text-[11px] text-slate-500 mt-1 tabular-nums">
            {!pw
              ? 'Sin desglose de potencia en la lectura'
              : pw.actuator_measured
                ? `${fmtNum(pw.current_ma, ' mA', 0)} · ${fmtNum(pw.bus_voltage_v, ' V', 2)}`
                : (POWER_BASIS_TEXT[pw.actuator_basis ?? 'sin dato'] ?? 'estimado')}
          </p>
          {pw && !scopeNode && (
            <p className="text-[11px] text-slate-400 mt-1 tabular-nums" title="Calculado por el backend: rama del actuador + electrónica (ESP32 + calentadores MQ + DHT11) nominal / eficiencia del buck, que no pasa por el shunt">
              Nodo total: <strong className="text-slate-200">{fmtNum(pw.total_w, ' W', 2)}</strong>{' '}
              <span className="text-amber-400/80">({pw.source ?? 'estimado'})</span>
              <span className="block text-slate-500">electrónica {fmtNum(pw.logic_w, ' W', 2)} estimada</span>
            </p>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Enlace del nodo ───────────────────────────────────────────────────────────

export function NodeLinkPanel({ roomId, sensorId, reading, metrics, now }: {
  roomId: string | null | undefined
  sensorId: string | null | undefined
  reading: (NodeTelemetry & { timestamp?: string }) | null
  metrics?: NodeMetrics | null
  now?: number
}) {
  const { data: health } = useHealth()
  const viaMqtt = mqttConnected(health)
  const intervalS = intervalOf(metrics)
  const st = useNodeOnline(reading, now, roomId, intervalS)
  const lat = reading?.latency_ms
  return (
    <div className="grid grid-cols-2 lg:grid-cols-5 gap-3 text-xs">
      <Info label="Nodo" value={<span className="font-mono">{sensorId ?? '—'}</span>} sub="ESP32 DevKit · WiFi" />
      {viaMqtt ? (
        <Info label="Ingesta · MQTT" value={<span className="font-mono text-[11px] break-all">{mqttTopic(roomId)}</span>} sub={`LWT: ${mqttTopic(roomId, 'status')} · cmd retenido: ${mqttTopic(roomId, 'cmd')}`} />
      ) : (
        <Info
          label="Ingesta"
          value={<span className="text-[12px]">HTTP POST /api/v1/sensors/</span>}
          sub={<>{ingestLabel(health)} · topic previsto <span className="font-mono">{mqttTopic(roomId)}</span></>}
        />
      )}
      <Info label="Última lectura" value={ago(st.lastSeenMs, now)} sub={<NodeLinkBadge reading={reading} now={now} roomId={roomId} intervalS={intervalS} />} />
      <Info label="Señal WiFi (RSSI)" value={fmtNum(reading?.rssi_dbm, ' dBm', 0)} sub={metrics?.rssi_avg_dbm != null ? `media ${fmtNum(metrics.rssi_avg_dbm, ' dBm', 0)}` : 'sin histórico'} />
      <Info
        label="Latencia sensado→actuación"
        value={<span className={lat == null ? '' : lat < LATENCY_TARGET_MS ? 'text-emerald-300' : 'text-red-300'}>{fmtNum(lat, ' ms', 0)}</span>}
        sub={`objetivo < ${LATENCY_TARGET_MS / 1000} s`}
      />
    </div>
  )
}

function Info({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="bg-slate-900/50 border border-slate-700/50 rounded-lg p-3 min-w-0">
      <p className="text-slate-400 mb-1">{label}</p>
      <div className="text-sm font-semibold text-slate-100">{value}</div>
      {sub && <div className="text-[11px] text-slate-500 mt-1">{sub}</div>}
    </div>
  )
}

// ── Indicadores de funcionamiento (métricas derivadas) ────────────────────────

type Tone = 'ok' | 'warn' | 'bad' | 'none'
const TONE: Record<Tone, string> = {
  ok: 'border-l-emerald-500 text-emerald-300',
  warn: 'border-l-amber-400 text-amber-300',
  bad: 'border-l-red-500 text-red-300',
  none: 'border-l-slate-600 text-slate-400',
}

function tonePct(v: number | null | undefined, good: number, fair: number): Tone {
  if (v == null) return 'none'
  return v >= good ? 'ok' : v >= fair ? 'warn' : 'bad'
}

function Kpi({ icon, label, value, sub, tone }: { icon: ReactNode; label: string; value: string; sub: string; tone: Tone }) {
  return (
    <div className={`bg-slate-900/50 border border-slate-700/50 border-l-4 rounded-lg p-3 ${TONE[tone].split(' ')[0]}`}>
      <p className="flex items-center gap-1.5 text-xs text-slate-400 mb-1"><span className={TONE[tone].split(' ')[1]}>{icon}</span>{label}</p>
      <p className={`text-xl font-bold tabular-nums ${tone === 'none' ? 'text-slate-500' : 'text-white'}`}>{value}</p>
      <p className="text-[11px] text-slate-500 mt-0.5 leading-snug">{sub}</p>
    </div>
  )
}

export function NodeKpiGrid({ metrics, compact = false }: { metrics: NodeMetrics | null; compact?: boolean }) {
  if (!metrics) {
    return <p className="text-xs text-slate-500">Indicadores no disponibles (sin conexión con /reports/node-metrics).</p>
  }
  if (metrics.samples === 0) {
    return (
      <p className="text-xs text-slate-500">
        {metrics.origin_filter === 'node'
          ? `Sin lecturas marcadas como nodo físico en las últimas ${metrics.window_hours} h. Cambia a “Todas” para ver los indicadores de las lecturas simuladas o sin origen declarado.`
          : `Sin lecturas en las últimas ${metrics.window_hours} h: no hay base para calcular indicadores.`}
      </p>
    )
  }
  const av = metrics.availability
  const lat = metrics.latency
  const ag = metrics.agreement
  const occ = metrics.occupancy
  const al = metrics.alarm
  const fan = metrics.fan
  const dq = metrics.data_quality
  const cf = metrics.comfort
  const en = metrics.energy
  const cfMain = cf ? (cf.controller_ok_pct ?? cf.in_band_pct) : null
  // Disponibilidad (informe, OE2): huecos > 3× periodo nominal; pérdida objetivo < 5 %.
  const avSub = av
    ? [
        `${av.drops} hueco(s) > ${fmtNum(av.gap_threshold_s, ' s', 0)} (${av.gap_factor ?? 3}× periodo ${fmtNum(av.nominal_period_s, ' s', 0)}${av.nominal_source === 'configurado' ? ', configurado' : ', mediana'})`,
        `pérdida de muestras ${fmtNum(av.sample_loss_pct, ' %', 1)} (objetivo < 5 %)`,
        av.lwt_offline_events != null && av.source !== 'huecos' ? `${av.lwt_offline_events} desconexión(es) LWT` : null,
        av.ongoing_gap_s != null ? `sin lecturas hace ${formatDuration(av.ongoing_gap_s)} (caída en curso, fuera del cálculo)` : null,
      ].filter(Boolean).join(' · ')
    : 'sin dato: se necesitan ≥ 2 lecturas por nodo'
  const avTone: Tone = av?.sample_loss_pct == null
    ? 'none'
    : av.ongoing_gap_s != null || av.sample_loss_pct >= 10 ? 'bad' : av.sample_loss_pct >= 5 ? 'warn' : 'ok'

  const items = [
    <Kpi key="av" icon={<Activity size={13} />} label="Disponibilidad del enlace"
      value={fmtNum(av?.uptime_pct, ' %', 1)}
      sub={avSub}
      tone={avTone} />,
    <Kpi key="dq" icon={<ShieldCheck size={13} />} label="Lecturas válidas"
      value={fmtNum(dq?.valid_pct, ' %', 1)}
      sub={dq ? `${dq.valid}/${dq.total} con T, HR, CO₂ y CO en rango · muestreo ${fmtNum(dq.median_interval_s, ' s', 0)}` : 'sin dato'}
      tone={tonePct(dq?.valid_pct, 98, 90)} />,
    <Kpi key="lat" icon={<Timer size={13} />} label="Latencia p95"
      value={lat ? fmtNum(lat.p95_ms, ' ms', 0) : '—'}
      sub={lat ? `p50 ${fmtNum(lat.p50_ms, ' ms', 0)} · ${fmtNum(lat.within_target_pct, ' %', 0)} < ${lat.target_ms / 1000} s · n=${lat.samples}` : 'el nodo aún no reporta latency_ms'}
      tone={lat?.p95_ms == null ? 'none' : lat.p95_ms < lat.target_ms ? 'ok' : 'bad'} />,
    <Kpi key="ag" icon={<GitCompare size={13} />} label="Coincidencia heurística / ML"
      value={ag ? fmtNum(ag.match_pct, ' %', 1) : '—'}
      sub={ag ? `${ag.divergences} divergencia(s) en ${ag.samples} decisiones` : 'ML en sombra sin predicciones en la ventana'}
      tone={tonePct(ag?.match_pct, 90, 75)} />,
    <Kpi key="cf" icon={<Thermometer size={13} />} label="Confort (enfriamiento)"
      value={fmtNum(cfMain, ' %', 1)}
      sub={cf
        ? `T ≤ objetivo configurado + ${cf.band_c} °C · ${fmtNum(cf.in_band_pct, ' %', 0)} en banda ±${cf.band_c} °C · ${fmtNum(cf.over_band_pct, ' %', 0)} sobre la banda · ${fmtNum(cf.cold_pct, ' %', 0)} aula fría (fuera de alcance del ventilador) · n=${cf.samples}`
        : 'sin objetivo configurado para el nodo'}
      tone={tonePct(cfMain, 80, 60)} />,
    <Kpi key="occ" icon={<Users size={13} />} label="Error ocupación CO₂ vs cámara"
      value={occ ? fmtNum(occ.mae_people, ' pers.', 1) : '—'}
      sub={occ ? `MAE · sesgo ${fmtNum(occ.bias_people, '', 1)} · n=${occ.samples}` : 'sin conteo de cámara en la ventana'}
      tone={occ?.mae_people == null ? 'none' : occ.mae_people <= 3 ? 'ok' : occ.mae_people <= 6 ? 'warn' : 'bad'} />,
    <Kpi key="al" icon={<Siren size={13} />} label="Tiempo en alarma CO"
      value={al ? formatDuration(al.time_in_alarm_s) : '—'}
      sub={al ? `${al.events} evento(s) · ${al.local_samples} lectura(s) con override local (ventilador 100 %)` : 'sin dato'}
      tone={al == null ? 'none' : al.events === 0 ? 'ok' : 'bad'} />,
    <Kpi key="fan" icon={<Repeat size={13} />} label="Ciclos del ventilador"
      value={fan ? String(fan.cycles) : '—'}
      sub={fan
        ? `encendido ≥ ${fan.min_on_s} s (regla del firmware): ${fan.min_on_compliance_pct != null ? fmtNum(fan.min_on_compliance_pct, ' %', 0) : (fan.min_on_reason ?? '—')} · PWM medio ${fmtNum(fan.avg_pwm_pct, ' %', 0)} (${fan.pwm_source})`
        : 'sin dato'}
      tone={fan?.min_on_compliance_pct == null ? 'none' : fan.min_on_compliance_pct >= 95 ? 'ok' : 'warn'} />,
    <Kpi key="en" icon={<Gauge size={13} />} label="Potencia media del nodo"
      value={en ? fmtNum(en.avg_power_w, ' W', 2) : '—'}
      sub={en
        ? (en.breakdown
            ? `rama actuador ${fmtNum(en.breakdown.actuator_avg_w, ' W', 2)} (${en.breakdown.actuator_source}) + electrónica ${fmtNum(en.breakdown.logic_avg_w, ' W', 2)} (estimado) · ${fmtNum(en.energy_wh, ' Wh', 1)} en la ventana`
            : `${fmtNum(en.energy_wh, ' Wh', 1)} en la ventana · ${en.source}`)
        : 'sin dato'}
      tone={en?.avg_power_w != null ? 'ok' : 'none'} />,  /* procedencia en el subtítulo; el tono no la penaliza (FE-3-09) */
  ]
  return (
    <div className={`grid gap-3 ${compact ? 'grid-cols-2 md:grid-cols-3 xl:grid-cols-5' : 'grid-cols-2 md:grid-cols-3'}`}>
      {compact ? items.filter((_, i) => [0, 1, 2, 3, 6].includes(i)) : items}
    </div>
  )
}

// ── Heurística (activa) vs ML (sombra) ────────────────────────────────────────

type Controller = 'heuristic' | 'ml' | 'manual' | 'none' | null

function controllerOf(action: Partial<CognitiveAction> | null | undefined): Controller {
  if (!action) return null
  if (action.active_controller) return action.active_controller
  if (action.model && action.model !== 'none') return action.model
  return action.model === 'none' ? 'none' : null
}

export function HeuristicVsMl({ action, metrics, mlLoaded }: {
  action: Partial<CognitiveAction> | null | undefined
  metrics?: NodeMetrics | null
  mlLoaded?: boolean | null
}) {
  const heur = (action?.heuristic_action ?? (action?.model === 'heuristic' ? decisionOf(action) : null)) as DecisionState | null
  const ml = (action?.ml_action ?? null) as DecisionState | null
  const agree = heur != null && ml != null ? heur === ml : null
  const ag = metrics?.agreement
  const ctrl = controllerOf(action)
  const disabled = decisionOf(action) === 'DISABLED'

  // Los rótulos se derivan del controlador real de la lectura, no se asumen.
  const heurBadge = disabled
    ? { text: 'control deshabilitado', cls: 'text-amber-300 bg-amber-500/10 border-amber-500/30' }
    : ctrl === 'heuristic'
      ? { text: 'controla el ventilador', cls: 'text-blue-300 bg-blue-500/10 border-blue-500/30' }
      : ctrl === 'manual'
        ? { text: 'no actúa · modo manual (objetivo fijo)', cls: 'text-slate-300 bg-slate-700/50 border-slate-600' }
        : ctrl === 'ml'
          ? { text: 'no actúa · controla el ML', cls: 'text-slate-300 bg-slate-700/50 border-slate-600' }
          : { text: 'sin controlador en la lectura', cls: 'text-slate-400 bg-slate-800 border-slate-700' }
  const mlActive = ctrl === 'ml' && !disabled
  const mlBadge = mlActive
    ? { text: 'activo: controla el ventilador', cls: 'text-violet-200 bg-violet-500/20 border-violet-500/50' }
    : { text: 'solo compara, no actúa', cls: 'text-violet-300 bg-violet-500/10 border-violet-500/30' }

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div className={`bg-slate-900/50 border rounded-lg p-4 ${ctrl === 'heuristic' && !disabled ? 'border-blue-500/30' : 'border-slate-700 border-dashed'}`}>
          <div className="flex items-center justify-between gap-2 mb-2">
            <p className="flex items-center gap-1.5 text-sm font-semibold text-slate-100"><Sigma size={15} className="text-blue-400" /> Heurística</p>
            <span className={`text-[10px] font-medium border rounded-full px-2 py-0.5 ${heurBadge.cls}`}>{heurBadge.text}</span>
          </div>
          <DecisionBadge state={heur} />
          <p className="text-xs text-slate-400 mt-2 leading-relaxed">{action?.heuristic_reason ?? 'Motivo no reportado por el backend'}</p>
          <p className="text-[11px] text-slate-500 mt-1 tabular-nums">
            Objetivo {fmtNum(action?.heuristic_target ?? action?.target, ' °C', 1)} · PWM {fmtNum(action?.heuristic_fan_pwm ?? action?.fan_pwm, ' %', 0)}
          </p>
        </div>
        <div className={`bg-slate-900/50 border rounded-lg p-4 ${mlActive ? 'border-violet-500/50' : 'border-violet-500/30 border-dashed'}`}>
          <div className="flex items-center justify-between gap-2 mb-2">
            <p className="flex items-center gap-1.5 text-sm font-semibold text-slate-100"><BrainCircuit size={15} className="text-violet-400" /> {mlActive ? 'ML' : 'ML en sombra'}</p>
            <span className={`text-[10px] font-medium border rounded-full px-2 py-0.5 ${mlBadge.cls}`}>{mlBadge.text}</span>
          </div>
          <DecisionBadge state={ml} />
          <p className="text-xs text-slate-400 mt-2 leading-relaxed">
            {action?.ml_reason ?? (mlLoaded === false ? 'Modelo ML no cargado' : 'Sin predicción ML para esta lectura')}
          </p>
          <p className="text-[11px] text-slate-500 mt-1 tabular-nums">
            Objetivo {fmtNum(action?.ml_target, ' °C', 1)} · PWM {fmtNum(action?.ml_fan_pwm, ' %', 0)}
          </p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
        <span className={agree == null ? 'text-slate-500' : agree ? 'text-emerald-300' : 'text-amber-300'}>
          Última lectura: {agree == null ? 'sin comparación' : agree ? 'coinciden' : 'divergen'}
        </span>
        <span className="text-slate-400">
          Coincidencia en la ventana: <strong className="text-slate-200">{ag ? fmtNum(ag.match_pct, ' %', 1) : '—'}</strong>
          {ag && <span className="text-slate-500"> ({ag.samples - ag.divergences}/{ag.samples})</span>}
        </span>
      </div>
      {ag && ag.recent_divergences.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] text-xs">
            <thead>
              <tr className="text-slate-500 uppercase border-b border-slate-700">
                <th className="text-left py-1.5 pr-3">Fecha y hora</th>
                <th className="text-left py-1.5 pr-3">Heurística</th>
                <th className="text-left py-1.5 pr-3">ML (sombra)</th>
                <th className="text-left py-1.5">Motivo ML</th>
              </tr>
            </thead>
            <tbody>
              {[...ag.recent_divergences].reverse().map((d, i) => (
                <tr key={`${d.timestamp}-${i}`} className="border-b border-slate-700/40">
                  <td className="py-1.5 pr-3 text-slate-400">{(() => { const ms = parseUtcMs(d.timestamp); return ms == null ? '—' : new Date(ms).toLocaleString('es') })()}</td>
                  <td className="py-1.5 pr-3"><DecisionBadge state={d.heuristic_action as DecisionState | null} /></td>
                  <td className="py-1.5 pr-3"><DecisionBadge state={d.ml_action as DecisionState | null} /></td>
                  <td className="py-1.5 text-slate-400">{d.ml_reason ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
