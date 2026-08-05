import { getRpc } from "./rpc"

export interface InspectedServer {
  id: string; workspace: string; version: string; buildId: string; port: number; pid: number; startedAt: number
  current: boolean; reachable: boolean; retiring: boolean; busy: boolean | null
  busySessions: number; attachedSessions: number; totalSessions: number
}
export interface ServerInspection { servers: InspectedServer[]; installed: { version: string; buildId: string } | null }
export const OLD_SERVERS_MESSAGE = "chunkyOldServers"
export async function inspectChunkyServers(): Promise<ServerInspection | null> { const rpc = await getRpc(); return (await rpc?.request?.chunkyInspectServers?.()) as ServerInspection | null }
export async function retireChunkyServer(id: string): Promise<{ ok: boolean; error?: string }> { const rpc = await getRpc(); return (await rpc?.request?.chunkyRetireServer?.({ id })) as { ok: boolean; error?: string } ?? { ok: false, error: "Native RPC unavailable" } }
export async function stopChunkyServer(id: string): Promise<{ ok: boolean; error?: string }> { const rpc = await getRpc(); return (await rpc?.request?.chunkyStopServer?.({ id })) as { ok: boolean; error?: string } ?? { ok: false, error: "Native RPC unavailable" } }
