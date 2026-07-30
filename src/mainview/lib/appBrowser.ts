/**
 * Makes the browser pane remotely drivable: asks the Bun process what the pane
 * is (renderer + loopback CDP port) and announces it to the Chunky server.
 *
 * Rules this encodes:
 *  - Only ever announce to a live server. Outside Electrobun there is no pane
 *    at all (the placeholder), the RPC returns nothing, and nothing is posted.
 *  - The server keeps the endpoint in memory, so it must be re-announced on
 *    every (re)connect — call `reset()` when the connection drops, then
 *    `announce()` again once it is back.
 *  - Announcements are serialized and deduplicated by payload, so React
 *    StrictMode's double mount (or a pane reopening) cannot race two POSTs.
 */
import type { AppBrowserAnnounce } from "@chunky/protocol"
import { announceAppBrowser as postAppBrowser } from "./api"
import { getRpc } from "./rpc"

export type AppBrowserTarget = AppBrowserAnnounce

export type AppBrowserAnnouncerDeps = {
  /** null when this is not the desktop app (no Bun process to ask). */
  resolveTarget: (paneUrl?: string) => Promise<AppBrowserTarget | null>
  post: (baseUrl: string, target: AppBrowserTarget) => Promise<unknown>
}

export type AppBrowserAnnouncer = {
  /** Announce, unless the same payload already reached this server. */
  announce: (baseUrl: string | null | undefined, paneUrl?: string) => Promise<void>
  /** Forget what was announced, so the next connect re-announces. */
  reset: () => void
}

function isTarget(value: unknown): value is AppBrowserTarget {
  if (!value || typeof value !== "object") return false
  const { cdpPort, renderer, debuggable } = value as Partial<AppBrowserTarget>
  return (
    typeof cdpPort === "number" &&
    Number.isInteger(cdpPort) &&
    cdpPort > 0 &&
    (renderer === "cef" || renderer === "native") &&
    typeof debuggable === "boolean"
  )
}

export function createAppBrowserAnnouncer(deps: AppBrowserAnnouncerDeps): AppBrowserAnnouncer {
  let lastKey: string | null = null
  // One chain, so concurrent callers queue instead of racing: the second caller
  // observes the first one's dedupe key and becomes a no-op.
  let chain: Promise<void> = Promise.resolve()

  const run = async (baseUrl: string | null | undefined, paneUrl?: string) => {
    if (!baseUrl) return
    const target = await deps.resolveTarget(paneUrl)
    if (!isTarget(target)) return
    const key = `${baseUrl}|${target.renderer}|${target.debuggable}|${target.cdpPort}`
    if (key === lastKey) return
    await deps.post(baseUrl, target)
    lastKey = key
  }

  return {
    announce: (baseUrl, paneUrl) => {
      chain = chain.then(() => run(baseUrl, paneUrl)).catch((error) => {
        // A pane the server cannot be told about is not worth a user-visible
        // failure; the next connect/announce retries.
        console.warn("[chunky] app browser announce failed:", error)
      })
      return chain
    },
    reset: () => {
      lastKey = null
    },
  }
}

/** Ask the Bun process for the pane's target. null in the browser-only build. */
export async function fetchAppBrowserTarget(paneUrl?: string): Promise<AppBrowserTarget | null> {
  try {
    const rpc = await getRpc()
    const fn = rpc?.request?.appBrowserTarget
    if (!fn) return null
    const value = await fn(paneUrl ? { paneUrl } : {})
    return isTarget(value) ? value : null
  } catch {
    return null
  }
}

let rendererKind: Promise<"cef" | "native"> | null = null

/**
 * Which renderer the pane should ask `<electrobun-webview>` for. CEF is
 * preferred (it is the only CDP-drivable one) but only exists when this build
 * bundled it; everything else gets the system WebView. Cached: the answer is a
 * build property, and remounts must not pay for another round trip.
 */
export function preferredWebviewRenderer(): Promise<"cef" | "native"> {
  rendererKind ??= fetchAppBrowserTarget().then(
    (target) => (target?.renderer === "cef" ? "cef" : "native"),
    () => "native" as const,
  )
  return rendererKind
}

const shared = createAppBrowserAnnouncer({
  resolveTarget: fetchAppBrowserTarget,
  post: (baseUrl, target) => postAppBrowser(baseUrl, target),
})

/** Announce the pane to a connected server (no-op without one). */
export const announceAppBrowserTarget = shared.announce
/** Drop the announce memo when the connection is lost. */
export const resetAppBrowserAnnounce = shared.reset
