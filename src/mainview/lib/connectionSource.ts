// How this renderer resolved the Chunky server, and the short label that
// must make Vite/browser-dev unmistakable versus the installed native app.
//
// Safe to render: host:port only. Never a token, settings path, DB path, or
// URL userinfo. The Vite proxy still talks to whatever CHUNKY_URL named;
// this module only decides what the chrome is allowed to show.

export type ConnectionSource = "vite-proxy" | "native" | "static"

export const VITE_DEV_ORIGINS = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
] as const

export function isViteDevOrigin(origin: string | undefined | null): boolean {
  return origin === "http://localhost:5173" || origin === "http://127.0.0.1:5173"
}

/** True when this renderer is the Vite HMR / `dev:web` page. */
export function rendererIsBrowserDev(origin?: string | null): boolean {
  const resolved =
    origin ?? (typeof window !== "undefined" ? window.location.origin : undefined)
  return isViteDevOrigin(resolved)
}

declare const __CHUNKY_PROXY_TARGET__: string | undefined

/**
 * Host:port of an http(s) server URL, with credentials/path/query stripped.
 * Empty string when the input is missing or not a usable http(s) URL.
 */
export function formatSafeServerTarget(raw: string | undefined | null): string {
  if (typeof raw !== "string") return ""
  const trimmed = raw.trim()
  if (!trimmed) return ""
  try {
    const url = new URL(trimmed)
    if (url.protocol !== "http:" && url.protocol !== "https:") return ""
    url.username = ""
    url.password = ""
    const host = url.hostname.includes(":") ? `[${url.hostname}]` : url.hostname
    if (!host) return ""
    const port = url.port || (url.protocol === "https:" ? "443" : "80")
    return `${host}:${port}`
  } catch {
    return ""
  }
}

/** CHUNKY_URL as injected by Vite. Origin only; undefined if missing/unsafe. */
export function configuredProxyTarget(): string | undefined {
  const raw =
    typeof __CHUNKY_PROXY_TARGET__ !== "undefined" && __CHUNKY_PROXY_TARGET__
      ? __CHUNKY_PROXY_TARGET__
      : undefined
  if (!raw || !formatSafeServerTarget(raw)) return undefined
  try {
    return new URL(raw).origin
  } catch {
    return undefined
  }
}

/** Persistent chrome label for Vite/browser-dev. Always names the proxy target. */
export function browserDevLabel(target: string | undefined | null): string {
  const safe = formatSafeServerTarget(target)
  return `Dev web · ${safe || "localhost:4620"}`
}

export interface ConnectionStatusInput {
  appMode: "live" | "demo"
  connectionState: string
  connectionSource?: ConnectionSource
  proxyTarget?: string
  /** Renderer origin. Used to identify Vite/browser-dev before AppConfig loads. */
  origin?: string | null
}

/**
 * Footer/status label. Browser-dev stays identified for the whole session,
 * including connecting/offline and the first paint before AppConfig resolves,
 * so it cannot read as the installed Live app.
 */
export function connectionStatusLabel(input: ConnectionStatusInput): string {
  if (input.appMode !== "live") return "Demo"
  const origin =
    input.origin ?? (typeof window !== "undefined" ? window.location.origin : undefined)
  const source =
    input.connectionSource ?? (isViteDevOrigin(origin) ? "vite-proxy" : undefined)
  const target = input.proxyTarget ?? (source === "vite-proxy" ? configuredProxyTarget() : undefined)
  if (source === "vite-proxy") return browserDevLabel(target)
  if (input.connectionState === "connected") return "Live"
  if (input.connectionState === "reconnecting") return "Reconnecting"
  if (input.connectionState === "connecting" || input.connectionState === "booting") return "Connecting"
  return "Offline"
}

export function isBrowserDevLabel(label: string): boolean {
  return label.startsWith("Dev web")
}
