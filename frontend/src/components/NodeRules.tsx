import ControllerPanel from './ControllerPanel'
import { FW } from './NodeLive'

// "Configuración" of a room with a node: who drives the actuators, with the node's
// firmware rules (hardware/firmware/src/sketch.ino, mirrored in FW) shown in its card.

// Firmware maps the MQ-135 ADC (0-4095) linearly to 400-2000 ppm.
export const OCCUPIED_PPM = Math.round(400 + FW.occupiedAdc * 1600 / 4095)

export default function NodeRules({ roomId }: { roomId: string; sensorId?: string }) {
  return <ControllerPanel roomId={roomId} />
}
