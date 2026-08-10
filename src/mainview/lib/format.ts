import type { SessionSummary } from "@chunky/protocol"

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

/** Compact relative time for a sidebar row: "now", "5m", "3h", "2d", "Jul 8". */
export function relativeTime(ms: number, now = Date.now()): string {
  const d = Math.max(0, now - ms)
  if (d < MIN) return "now"
  if (d < HOUR) return `${Math.floor(d / MIN)}m`
  if (d < DAY) return `${Math.floor(d / HOUR)}h`
  if (d < 7 * DAY) return `${Math.floor(d / DAY)}d`
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" })
}

/** True when a thread has no real title (blank or server default). */
export function isPlaceholderTitle(title: string | undefined): boolean {
  const t = (title ?? "").trim()
  return !t || t.toLowerCase() === "new session"
}

export function threadLabel(title: string | undefined): string {
  if (isPlaceholderTitle(title)) return "Untitled thread"
  return (title ?? "").trim()
}

/** Short workspace label for sidebar (last path segment). */
export function workspaceName(path: string | null | undefined): string {
  if (!path) return "workspace"
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] || path
}

/** Project mark letter from a workspace path. */
export function workspaceMark(path: string | null | undefined): string {
  const name = workspaceName(path)
  return (name[0] ?? "?").toUpperCase()
}

export function sessionPreview(s: SessionSummary): string {
  return isPlaceholderTitle(s.title) ? "Start a conversation…" : s.title
}

/** Compact home-relative display for long absolute paths. */
export function compactPath(abs: string): string {
  // Avoid importing node:os in the browser bundle — string replace is enough.
  const home =
    typeof window !== "undefined"
      ? // best-effort: paths like /Users/name/...
        abs.match(/^(\/Users\/[^/]+)/)?.[1] ??
        abs.match(/^(\/home\/[^/]+)/)?.[1] ??
        ""
      : ""
  if (home && abs.startsWith(home)) return `~${abs.slice(home.length)}`
  return abs
}
