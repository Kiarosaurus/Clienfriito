import ControllerPanel from './ControllerPanel'
import { Card } from './ui'
import { FW } from './NodeLive'

// "Configuración" of a room with a node: who drives the actuators (ControllerPanel),
// plus a short, read-only summary of the firmware rules (hardware/firmware/src/sketch.ino, mirrored in FW).

// Firmware maps the MQ-135 ADC (0-4095) linearly to 400-2000 ppm.
const OCCUPIED_PPM = Math.round(400 + FW.occupiedAdc * 1600 / 4095)

const RULES: { when: string; then: string; led: { color: string; name: string } | null }[] = [
  { when: `Hasta ${FW.heatOn} °C`, then: 'Calefactor encendido', led: { color: '#f59e0b', name: 'ámbar' } },
  { when: `${FW.heatOn} a ${FW.coolOn} °C`, then: 'En espera', led: { color: '#22c55e', name: 'verde' } },
  { when: `Desde ${FW.coolOn} °C`, then: `Ventilador al 50 %; al 75 % desde ${FW.fan75At} °C y al 100 % desde ${FW.fan100At} °C o con CO₂ ≥ ${FW.fan100Co2} ppm`, led: { color: '#3b82f6', name: 'azul' } },
  { when: `CO₂ bajo ${OCCUPIED_PPM} ppm`, then: 'Aula vacía: todo apagado', led: null },
  { when: `CO desde ${FW.coAlarm} ppm`, then: 'Alarma: ventilador al 100 %, calefactor apagado y buzzer', led: { color: '#ef4444', name: 'rojo' } },
]

export default function NodeRules({ roomId, sensorId }: { roomId: string; sensorId?: string }) {
  return (
    <>
      <ControllerPanel roomId={roomId} />

      <Card title="Reglas del nodo" aside={<>{sensorId && <span className="font-mono">{sensorId}</span>}<span>Definidas en el firmware · solo lectura</span></>}>
        <div className="divide-y divide-slate-800 text-sm">
          {RULES.map(r => (
            <div key={r.when} className="grid grid-cols-[9rem_1fr_6rem] items-center gap-3 py-2">
              <span className="tabular-nums text-slate-400">{r.when}</span>
              <span className="text-slate-200">{r.then}</span>
              <span className="flex items-center gap-2 text-xs text-slate-300">
                {r.led
                  ? <><span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: r.led.color }} />LED {r.led.name}</>
                  : <span className="text-slate-500">LED apagado</span>}
              </span>
            </div>
          ))}
        </div>
        <p className="mt-2 text-xs text-slate-500">
          Ventilador y calefactor se apagan al volver a {FW.setpoint} °C. Entre un cambio y otro pasan al menos {FW.minOnS} s. La alarma de CO manda sobre todo.
        </p>
      </Card>
    </>
  )
}
