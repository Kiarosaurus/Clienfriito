import { useEffect, useState } from 'react'
import api from '../api/client'

// Connectivity of the MQTT nodes (RF-10): "online" on connect, and the retained Last Will
// "offline" the broker publishes ~7.5 s after a node stops answering. Polled every 5 s,
// so the dashboard reflects a node drop in well under 10 s.
export interface NodeStatus { room_id: string; online: boolean; since: string | null }

const POLL_MS = 5_000

export function useNodes(): Record<string, NodeStatus> {
  const [nodes, setNodes] = useState<Record<string, NodeStatus>>({})
  useEffect(() => {
    let cancelled = false
    const load = () => api.get<NodeStatus[]>('/sensors/nodes')
      .then(r => { if (!cancelled) setNodes(Object.fromEntries((r.data ?? []).map(n => [n.room_id, n]))) })
      .catch(() => {})
    load()
    const t = setInterval(load, POLL_MS)
    return () => { cancelled = true; clearInterval(t) }
  }, [])
  return nodes
}
