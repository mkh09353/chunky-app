// Inspect and stop discovery-managed Chunky servers listed under
// ~/.chunky/state/servers. Unregistered source/test processes (temp DB,
// CHUNKY_URL, random ports) are not enumerated.
import { join } from "node:path"
import { readFileSync } from "node:fs"
import { installedRuntimeIdentity, probe, recordEntries, supersedeRecord, stateDir, type Identity, type RecordFile } from "./connectionManager"
import { readDesktopState } from "./desktopState"

export interface InspectedServer {
  id: string; workspace: string; version: string; buildId: string; port: number; pid: number; startedAt: number
  current: boolean; reachable: boolean; retiring: boolean; busy: boolean | null
  busySessions: number; attachedSessions: number; totalSessions: number
}
export interface ServerInspection { servers: InspectedServer[]; installed: { version: string; buildId: string } | null }
export type ServerInspectionDependencies = { env?: NodeJS.ProcessEnv; fetch: typeof fetch; now(): number; pidAlive(pid: number): boolean; kill(pid: number, signal?: NodeJS.Signals): void }
const defaults: ServerInspectionDependencies = {
  fetch, now: () => Date.now(),
  pidAlive: (pid) => { try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM" } },
  kill: (pid, signal = "SIGTERM") => process.kill(pid, signal),
}
function tokenFor(env: NodeJS.ProcessEnv): string | undefined {
  const path = env.CHUNKY_SETTINGS || join(stateDir(env), "settings.json")
  try { const value = JSON.parse(readFileSync(path, "utf8")) as { serverToken?: unknown }; return typeof value.serverToken === "string" ? value.serverToken : undefined } catch { return undefined }
}
async function shellStats(record: RecordFile, token: string | undefined, deps: ServerInspectionDependencies) {
  try {
    const response = await deps.fetch(`http://127.0.0.1:${record.port}/api/sessions/shell`, { headers: token ? { Authorization: `Bearer ${token}` } : undefined })
    if (!response.ok) return { busy: null as boolean | null, busySessions: 0, attachedSessions: 0, totalSessions: 0 }
    const body = await response.json() as { sessions?: Array<{ busy?: unknown; running?: unknown; attached?: unknown }> }
    if (!Array.isArray(body.sessions)) return { busy: null as boolean | null, busySessions: 0, attachedSessions: 0, totalSessions: 0 }
    const busySessions = body.sessions.filter((s) => (s.busy ?? s.running) === true).length
    return { busy: busySessions > 0, busySessions, attachedSessions: body.sessions.filter((s) => s.attached === true).length, totalSessions: body.sessions.length }
  } catch { return { busy: null as boolean | null, busySessions: 0, attachedSessions: 0, totalSessions: 0 } }
}
export async function inspectServers(input: Partial<ServerInspectionDependencies> = {}): Promise<ServerInspection> {
  const deps = { ...defaults, ...input } as ServerInspectionDependencies
  const env = deps.env || process.env, installed = installedRuntimeIdentity(env) || null, token = tokenFor(env)
  const entries = recordEntries(join(stateDir(env), "servers"))
  const servers = await Promise.all(entries.map(async ({ record }) => {
    const identity = await probe(record, token, deps), reachable = !!identity
    const stats = reachable ? await shellStats(record, token, deps) : { busy: null as boolean | null, busySessions: 0, attachedSessions: 0, totalSessions: 0 }
    return { id: record.id, workspace: record.workspace, version: record.version, buildId: record.buildId, port: record.port, pid: record.pid, startedAt: record.startedAt,
      current: !!installed && record.version === installed.version && record.buildId === installed.buildId, reachable, retiring: identity?.retiring === true, ...stats }
  }))
  return { servers, installed }
}
async function verifiedEntry(id: string, deps: ServerInspectionDependencies): Promise<{ entry: { path: string; record: RecordFile }; identity: Identity } | { error: string }> {
  const env = deps.env || process.env, token = tokenFor(env)
  const entry = recordEntries(join(stateDir(env), "servers")).find((candidate) => candidate.record.id === id)
  if (!entry) return { error: "This server is already scheduled to stop — it will exit once its in-flight work finishes." }
  const identity = await probe(entry.record, token, deps)
  return identity ? { entry, identity } : { error: "Server identity could not be verified" }
}
export async function retireServer(input: Partial<ServerInspectionDependencies>, id: string): Promise<{ ok: boolean; error?: string }> {
  const found = await verifiedEntry(id, { ...defaults, ...input } as ServerInspectionDependencies)
  if ("error" in found) return { ok: false, error: found.error }
  return supersedeRecord(found.entry) ? { ok: true } : { ok: false, error: "Server record changed before it could be retired" }
}
export async function stopServer(input: Partial<ServerInspectionDependencies>, id: string): Promise<{ ok: boolean; error?: string }> {
  const deps = { ...defaults, ...input } as ServerInspectionDependencies, found = await verifiedEntry(id, deps)
  if ("error" in found) return { ok: false, error: found.error }
  if (!supersedeRecord(found.entry)) return { ok: false, error: "Server record changed before it could be stopped" }
  if (!deps.pidAlive(found.entry.record.pid)) return { ok: true }
  try { deps.kill(found.entry.record.pid, "SIGTERM"); return { ok: true } } catch (error) { return { ok: false, error: error instanceof Error ? error.message : "Could not stop server" } }
}
