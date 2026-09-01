// Which discovery-managed superseded Chunky servers are still running, and
// what the user may do about each one.
//
// After a runtime upgrade the new server takes over while the old one keeps
// serving whatever was mid-flight. Most of the time it drains and exits on its
// own; when it does not, this is the data behind the notice that offers to
// retire or stop it.
//
// Enumeration is only ~/.chunky/state/servers records (plus identity probe).
// Unregistered source/test servers — temp DB/settings, random ports, CHUNKY_URL
// targets — are intentionally not listed.
//
// Everything above `subscribeOldServers` is pure: the classification, the
// labels and the payload guard are all functions of an inspection, so the
// rules can be asserted without a native bridge.
import {
  OLD_SERVERS_MESSAGE,
  type InspectedServer,
  type ServerInspection,
} from "./serverLifecycle"
import { workspaceName } from "./format"
import { getRpc, type RpcMessageListener } from "./rpc"

export type OldServerStatus = "idle" | "working" | "unknown"

/** User-facing copy: this notice is discovery-managed servers only. */
export const OLD_SERVERS_NOTICE_TITLE = "Older managed Chunky servers are still running"
export const OLD_SERVERS_NOTICE_BODY =
  "Discovery-registered servers from a previous runtime. Raw or test servers are not listed. These can be shut down when their work is done."

export interface OldServerRow {
  id: string
  /** Rendered in mono next to the workspace. */
  version: string
  /** Last path segment of the workspace, not the whole path. */
  workspace: string
  status: OldServerStatus
  /** "idle", "working — 2 active sessions", "state unknown". */
  statusLabel: string
  /** Working servers are the ones worth an amber note; the rest stay muted. */
  tone: "muted" | "warn"
  /** Sessions that would be interrupted by an immediate stop. */
  activeSessions: number
  /** Idle only: stopping is safe enough for a light inline confirm. */
  canStop: boolean
  /** Drain in-flight work, then exit. Offered whenever work may be running. */
  canRetire: boolean
  /** Working only: the de-emphasized escape hatch, behind a stronger confirm. */
  canForceStop: boolean
}

/** "1 active session" / "2 active sessions" — never "1 sessions". */
export function sessionCountLabel(n: number): string {
  return `${n} active session${n === 1 ? "" : "s"}`
}

/**
 * A discovery-managed superseded server the user might still care about:
 * reachable (so an action can reach it), not already retiring (it is leaving
 * anyway), and not the installed runtime this app would start today.
 * Raw/test listeners without a discovery record never appear here.
 */
export function isOldServer(server: InspectedServer): boolean {
  return server.reachable && !server.retiring && !server.current
}

/** One row's presentation. `busy === null` means the server could not be asked. */
export function formatServerRow(server: InspectedServer): OldServerRow {
  const active = Math.max(0, server.busySessions ?? 0)
  const base = {
    id: server.id,
    version: server.version,
    workspace: workspaceName(server.workspace),
    activeSessions: active,
  }
  if (server.busy === true) {
    return {
      ...base,
      status: "working",
      statusLabel: `working — ${sessionCountLabel(active)}`,
      tone: "warn",
      canStop: false,
      canRetire: true,
      canForceStop: true,
    }
  }
  if (server.busy === false) {
    return {
      ...base,
      status: "idle",
      statusLabel: "idle",
      tone: "muted",
      canStop: true,
      canRetire: false,
      canForceStop: false,
    }
  }
  // Unknown: never offer an immediate stop, because there is no way to say
  // what it would interrupt. Draining is always safe.
  return {
    ...base,
    status: "unknown",
    statusLabel: "state unknown",
    tone: "muted",
    canStop: false,
    canRetire: true,
    canForceStop: false,
  }
}

/** The rows the notice should show, or [] when there is nothing to say. */
export function classifyServers(inspection: ServerInspection | null | undefined): OldServerRow[] {
  const servers = inspection?.servers
  if (!Array.isArray(servers)) return []
  return servers.filter(isOldServer).map(formatServerRow)
}

/** The body of the stronger confirm before interrupting live work. */
export function forceStopWarning(row: OldServerRow): string {
  return `Interrupts ${sessionCountLabel(row.activeSessions)}.`
}

// ---- Bun payload ----------------------------------------------------------

function toInspectedServer(raw: unknown): InspectedServer | null {
  if (!raw || typeof raw !== "object") return null
  const rec = raw as Partial<InspectedServer>
  if (typeof rec.id !== "string" || !rec.id) return null
  return {
    id: rec.id,
    workspace: typeof rec.workspace === "string" ? rec.workspace : "",
    version: typeof rec.version === "string" ? rec.version : "unknown",
    buildId: typeof rec.buildId === "string" ? rec.buildId : "",
    port: typeof rec.port === "number" ? rec.port : 0,
    pid: typeof rec.pid === "number" ? rec.pid : 0,
    startedAt: typeof rec.startedAt === "number" ? rec.startedAt : 0,
    current: rec.current === true,
    reachable: rec.reachable === true,
    retiring: rec.retiring === true,
    // Anything that is not an explicit boolean is "could not tell".
    busy: rec.busy === true ? true : rec.busy === false ? false : null,
    busySessions: typeof rec.busySessions === "number" ? rec.busySessions : 0,
    attachedSessions: typeof rec.attachedSessions === "number" ? rec.attachedSessions : 0,
    totalSessions: typeof rec.totalSessions === "number" ? rec.totalSessions : 0,
  }
}

/** Validate a ServerInspection off the RPC channel; null when unusable. */
export function parseInspection(payload: unknown): ServerInspection | null {
  if (!payload || typeof payload !== "object") return null
  const rec = payload as { servers?: unknown; installed?: unknown }
  if (!Array.isArray(rec.servers)) return null
  const installed =
    rec.installed && typeof rec.installed === "object"
      ? (rec.installed as { version?: unknown; buildId?: unknown })
      : null
  return {
    servers: rec.servers
      .map(toInspectedServer)
      .filter((s): s is InspectedServer => s !== null),
    installed:
      installed && typeof installed.version === "string"
        ? {
            version: installed.version,
            buildId: typeof installed.buildId === "string" ? installed.buildId : "",
          }
        : null,
  }
}

/**
 * Listen for "discovery-managed old servers are still running" from Bun,
 * announced after a runtime upgrade. Returns an unsubscribe function; a no-op
 * without the native bridge. Mirrors subscribeServerChanged in reresolve.ts.
 */
export function subscribeOldServers(handler: (inspection: ServerInspection) => void): () => void {
  let cancelled = false
  let attached: RpcMessageListener | null = null

  void (async () => {
    const rpc = await getRpc()
    if (cancelled || !rpc?.addMessageListener) return
    const listener: RpcMessageListener = (payload) => {
      const inspection = parseInspection(payload)
      if (inspection) handler(inspection)
    }
    attached = listener
    rpc.addMessageListener(OLD_SERVERS_MESSAGE, listener)
  })()

  return () => {
    cancelled = true
    const listener = attached
    if (!listener) return
    attached = null
    void getRpc().then((rpc) => rpc?.removeMessageListener?.(OLD_SERVERS_MESSAGE, listener))
  }
}
