/**
 * Makes this app's product-factory board reachable by agent tooling: asks the
 * Bun process where its local zoo service listens (loopback port + a per-run
 * token) and announces that to the Chunky server, which then exposes the
 * `zoo_*` tools for sessions in this app.
 *
 * Mirrors lib/appBrowser.ts, with one extra rule: THE TOKEN IS A SECRET.
 * It is read, passed to the in-flight POST, and dropped. What survives is a
 * short fingerprint (length + first 8 chars) used only to notice that the token
 * changed — enough to force a re-announce, useless to anyone reading it. The
 * token is never logged, never put in React state, never persisted.
 *
 * As with the browser announcer, the server holds the registration in memory
 * only: every (re)connect must re-announce, so `reset()` on disconnect.
 */
import type { AppZooAnnounce } from "@chunky/protocol"
import { announceAppZoo as postAppZoo } from "./api"
import { getRpc } from "./rpc"

export type AppZooTarget = AppZooAnnounce

export type AppZooAnnouncerDeps = {
  /** null when this is not the desktop app, or the method is not registered. */
  resolveTarget: () => Promise<AppZooTarget | null>
  post: (baseUrl: string, target: AppZooTarget) => Promise<unknown>
}

export type AppZooAnnouncer = {
  /** Announce, unless the same target already reached this server. */
  announce: (baseUrl: string | null | undefined) => Promise<void>
  /** Forget what was announced, so the next connect re-announces. */
  reset: () => void
}

function isTarget(value: unknown): value is AppZooTarget {
  if (!value || typeof value !== "object") return false
  const { ok, port, token } = value as Partial<AppZooTarget> & { ok?: unknown }
  // The RPC answers with the shared zoo envelope; `ok: false` carries an error.
  if (ok === false) return false
  return (
    typeof port === "number" &&
    Number.isInteger(port) &&
    port > 0 &&
    port < 65_536 &&
    typeof token === "string" &&
    token.length > 0
  )
}

/**
 * A non-reversible-enough marker for "same token as last time". Deliberately
 * NOT the token: length plus its first 8 characters cannot be replayed as
 * credentials, but any rotation changes it.
 */
function tokenFingerprint(token: string): string {
  return `${token.length}:${token.slice(0, 8)}`
}

export function createAppZooAnnouncer(deps: AppZooAnnouncerDeps): AppZooAnnouncer {
  let lastKey: string | null = null
  // One chain, so concurrent callers queue instead of racing: the second caller
  // observes the first one's dedupe key and becomes a no-op.
  let chain: Promise<void> = Promise.resolve()

  const run = async (baseUrl: string | null | undefined) => {
    if (!baseUrl) return
    const target = await deps.resolveTarget()
    if (!isTarget(target)) return
    const key = `${baseUrl}|${target.port}|${tokenFingerprint(target.token)}`
    if (key === lastKey) return
    await deps.post(baseUrl, { port: target.port, token: target.token })
    lastKey = key
  }

  return {
    announce: (baseUrl) => {
      chain = chain.then(() => run(baseUrl)).catch((error) => {
        // A board the server cannot be told about is not worth a user-visible
        // failure; the next connect/announce retries. The message comes from
        // the HTTP layer and never contains the token.
        console.warn("[chunky] app zoo announce failed:", error)
      })
      return chain
    },
    reset: () => {
      lastKey = null
    },
  }
}

/**
 * Ask the Bun process where the zoo service listens. null in the browser-only
 * build, and equally null when the method is not registered yet or answers with
 * anything unexpected — a missing capability must stay silent, not error.
 */
export async function fetchAppZooTarget(): Promise<AppZooTarget | null> {
  try {
    const rpc = await getRpc()
    const fn = rpc?.request?.appZooTarget
    if (!fn) return null
    const value = await fn({})
    if (!isTarget(value)) return null
    return { port: value.port, token: value.token }
  } catch {
    return null
  }
}

const shared = createAppZooAnnouncer({
  resolveTarget: fetchAppZooTarget,
  post: (baseUrl, target) => postAppZoo(baseUrl, target),
})

/** Announce the local zoo service to a connected server (no-op without one). */
export const announceAppZooTarget = shared.announce
/** Drop the announce memo when the connection is lost. */
export const resetAppZooAnnounce = shared.reset
