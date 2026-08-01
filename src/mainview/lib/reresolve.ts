// When to stop retrying a dead port and go find the server again.
//
// A Chunky server can be REPLACED under a running app: a newer runtime starts
// its own server for the workspace and the old one drains and exits (see the
// server's drain.ts). The SSE reconnect loop on its own would retry the old
// port forever, so it asks this module whether the failure it just saw means
// "the server moved" rather than "the network hiccuped".
//
// Ordinary transient drops against a LIVE server must keep their existing
// behaviour — reconnect to the same base URL with backoff — so re-resolution
// only kicks in on a refused connection, after several consecutive failures, or
// when the server itself announced that it is retiring.

import { reresolveConfig, type AppConfig } from "./api"
import { setBaseUrl } from "./configApi"
import { getRpc, type RpcMessageListener } from "./rpc"

/** Consecutive failures against a reachable-but-unhappy server before we look
 *  for a replacement. */
export const RERESOLVE_AFTER_ATTEMPTS = 3
/** A refused/unreachable connection is far stronger evidence, so it needs
 *  fewer repeats. */
export const RERESOLVE_AFTER_REFUSED_ATTEMPTS = 2

/** Does this error mean "nothing is listening there any more"? WebKit, Chromium
 *  and Node all word it differently, so match on the family of messages rather
 *  than one string. */
export function isConnectionRefused(error: unknown): boolean {
  if (!error) return false
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  return /failed to fetch|load failed|networkerror|connection refused|econnrefused|network request failed|fetch failed/i
    .test(message)
}

export interface ReresolveInput {
  /** How many consecutive failed attachments have happened. */
  attempts: number
  /** The error that ended the last attempt, if it threw. */
  error?: unknown
  /** The server told us it is draining after being superseded. */
  retiring?: boolean
}

/** Whether the reconnect loop should re-resolve the connection instead of
 *  retrying the same base URL. */
export function shouldReresolve({ attempts, error, retiring }: ReresolveInput): boolean {
  if (retiring) return true
  if (isConnectionRefused(error)) return attempts >= RERESOLVE_AFTER_REFUSED_ATTEMPTS
  return attempts >= RERESOLVE_AFTER_ATTEMPTS
}

/**
 * Resolve the server again and repoint every base-URL-derived client at the
 * result in one step: the bearer token (api.ts installs it), configApi's
 * memoized base, and the config the caller re-attaches with. Returns null when
 * nothing usable came back, so the caller keeps its existing backoff.
 */
export async function reresolveConnection(): Promise<AppConfig | null> {
  try {
    const config = await reresolveConfig()
    if (!config.baseUrl) return null
    setBaseUrl(config.baseUrl)
    return config
  } catch {
    return null
  }
}

/** Bun announces this after it replaces the installed runtime and resolves a
 *  server built from it. */
export const SERVER_CHANGED_MESSAGE = "chunkyServerChanged"

export interface ServerChanged {
  baseUrl: string
  version?: string
}

function parseServerChanged(payload: unknown): ServerChanged | null {
  if (!payload || typeof payload !== "object") return null
  const value = payload as { baseUrl?: unknown; version?: unknown }
  if (typeof value.baseUrl !== "string" || !value.baseUrl) return null
  return {
    baseUrl: value.baseUrl,
    version: typeof value.version === "string" ? value.version : undefined,
  }
}

/**
 * Listen for "the server moved" from Bun (runtime upgraded → new server
 * started, old one draining). Returns an unsubscribe function; a no-op without
 * the native bridge.
 */
export function subscribeServerChanged(handler: (change: ServerChanged) => void): () => void {
  let cancelled = false
  let attached: RpcMessageListener | null = null

  void (async () => {
    const rpc = await getRpc()
    if (cancelled || !rpc?.addMessageListener) return
    const listener: RpcMessageListener = (payload) => {
      const change = parseServerChanged(payload)
      if (change) handler(change)
    }
    attached = listener
    rpc.addMessageListener(SERVER_CHANGED_MESSAGE, listener)
  })()

  return () => {
    cancelled = true
    const listener = attached
    if (!listener) return
    attached = null
    void getRpc().then((rpc) => rpc?.removeMessageListener?.(SERVER_CHANGED_MESSAGE, listener))
  }
}
