/**
 * The desktop browser pane as a remotely drivable Chrome DevTools Protocol
 * target (POST ROUTES.appBrowser -> AppBrowserAnnounce).
 *
 * Electrobun — not this app — decides the CDP port. `initializeCEF()` in
 * libNativeWrapper.dylib calls `FindAvailableRemoteDebugPort(9222, 9232)` and
 * passes the result as `CefSettings.remote_debugging_port`, which Chromium binds
 * on loopback only. That port is kept in a private static (`g_remoteDebugPort`)
 * with no FFI accessor and no runtime flag to override it, so the only way to
 * learn it is to probe that range and prove the listener is ours by finding the
 * pane's own page among its targets. Probing without that proof would risk
 * announcing an unrelated Chrome that happens to sit on 9222.
 *
 * When CEF is not bundled (`build.json` -> `availableRenderers` has no "cef")
 * the pane runs on the system WebView, which exposes no CDP listener at all. The
 * announcement still has to carry a valid TCP port (the server rejects 0), so we
 * reserve a free loopback port at runtime and report `debuggable: false` — tools
 * then say "not drivable" instead of hanging on a dead socket.
 */
import type { AppBrowserAnnounce } from "@chunky/protocol"

/** Electrobun's hard-coded remote-debugging search range (see initializeCEF). */
export const CDP_FIRST_PORT = 9222
export const CDP_LAST_PORT = 9232

const PROBE_TIMEOUT_MS = 500

export type AppBrowserTarget = AppBrowserAnnounce

export type AppBrowserDeps = {
  /** `build.json` availableRenderers, injected so this module never has to pull
   *  in the electrobun FFI runtime (which unit tests cannot load). */
  availableRenderers: () => Promise<readonly string[]>
  fetch?: typeof fetch
  freePort?: () => Promise<number>
  probeTimeoutMs?: number
}

/** Reserve-and-release a loopback port. Racy by nature; only ever used for the
 *  non-debuggable announcement, where nothing listens on it anyway. */
async function reserveLoopbackPort(): Promise<number> {
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } })
  const port = listener.port
  listener.stop()
  return port
}

/** Is `targetUrl` (from CDP) the page our pane is showing? Exact match first;
 *  otherwise same origin, which tolerates redirects and in-page navigation. */
export function sameTarget(targetUrl: string, paneUrl: string): boolean {
  if (targetUrl === paneUrl) return true
  try {
    const target = new URL(targetUrl)
    const pane = new URL(paneUrl)
    return target.origin === pane.origin && target.origin !== "null"
  } catch {
    return false
  }
}

/** Accept only an http(s) pane URL, bounded in size. */
export function sanitizePaneUrl(raw: unknown): string | undefined {
  const value = typeof raw === "string" ? raw.trim() : ""
  if (!value || value.includes("\0") || value.length > 4096) return undefined
  try {
    const parsed = new URL(value)
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined
    return parsed.href
  } catch {
    return undefined
  }
}

async function hostsPane(
  port: number,
  paneUrl: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<boolean> {
  try {
    const res = await fetchImpl(`http://127.0.0.1:${port}/json/list`, {
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) return false
    const targets: unknown = await res.json()
    if (!Array.isArray(targets)) return false
    return targets.some((entry) => {
      if (!entry || typeof entry !== "object") return false
      const { url, webSocketDebuggerUrl } = entry as { url?: unknown; webSocketDebuggerUrl?: unknown }
      return (
        typeof url === "string" &&
        typeof webSocketDebuggerUrl === "string" &&
        sameTarget(url, paneUrl)
      )
    })
  } catch {
    return false
  }
}

/** The lowest port in Electrobun's range whose CDP listener owns our pane. */
async function findCdpPort(
  paneUrl: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<number | null> {
  const ports: number[] = []
  for (let port = CDP_FIRST_PORT; port <= CDP_LAST_PORT; port += 1) ports.push(port)
  const hits = await Promise.all(
    ports.map(async (port) => ((await hostsPane(port, paneUrl, fetchImpl, timeoutMs)) ? port : null)),
  )
  return hits.find((port): port is number => port != null) ?? null
}

/**
 * Build the resolver used by the RPC handler.
 *
 * `paneUrl` is the URL the pane currently shows; without it no probe happens at
 * all (there is no way to tell our listener from a stranger's), so a startup
 * announcement is honest-but-undebuggable until the pane actually exists.
 */
export function createAppBrowserResolver(deps: AppBrowserDeps): (paneUrl?: string) => Promise<AppBrowserTarget> {
  const fetchImpl = deps.fetch ?? fetch
  const freePort = deps.freePort ?? reserveLoopbackPort
  const timeoutMs = deps.probeTimeoutMs ?? PROBE_TIMEOUT_MS

  let renderers: Promise<readonly string[]> | null = null
  let reserved: Promise<number> | null = null
  // The native side picks the CDP port once per process, so one successful
  // discovery is final — later announcements must not re-probe.
  let verifiedPort: number | null = null

  return async function resolve(paneUrl?: string): Promise<AppBrowserTarget> {
    renderers ??= deps.availableRenderers().then(
      (list) => (Array.isArray(list) ? list : ["native"]),
      () => ["native"],
    )
    const cef = (await renderers).includes("cef")

    if (cef) {
      const url = sanitizePaneUrl(paneUrl)
      if (verifiedPort == null && url) verifiedPort = await findCdpPort(url, fetchImpl, timeoutMs)
      if (verifiedPort != null) return { cdpPort: verifiedPort, renderer: "cef", debuggable: true }
    }

    reserved ??= freePort()
    return { cdpPort: await reserved, renderer: cef ? "cef" : "native", debuggable: false }
  }
}
