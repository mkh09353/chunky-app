// Temporary startup diagnostics. This module deliberately owns no React state:
// the first renderer attachment records into this singleton and prints once.
type Timing = { start: number; duration?: number }

const rendererStart = safeNow()
const timings = new Map<string, Timing>()
let firstAttachClaimed = false
let printed = false
let replayedEvents = 0
let tailEvents = 0

function safeNow(): number {
  try {
    return typeof performance !== "undefined" ? performance.now() : Date.now()
  } catch {
    return 0
  }
}

function relativeNow(): number {
  try {
    return Math.max(0, safeNow() - rendererStart)
  } catch {
    return 0
  }
}

function mark(name: string): void {
  try {
    if (!timings.has(name)) timings.set(name, { start: relativeNow() })
  } catch {}
}

async function measure<T>(name: string, run: () => Promise<T>): Promise<T> {
  const start = relativeNow()
  try {
    return await run()
  } finally {
    try {
      timings.set(name, { start, duration: Math.max(0, relativeNow() - start) })
    } catch {}
  }
}

function beginFirstAttach(boot: boolean): boolean {
  try {
    if (!boot || firstAttachClaimed) return false
    firstAttachClaimed = true
    mark("attachSession start")
    return true
  } catch {
    return false
  }
}

function noteStreamOpen(firstBootAttach: boolean): void {
  try {
    if (firstBootAttach) mark("SSE stream open")
  } catch {}
}

function noteReplayEvent(firstBootAttach: boolean): void {
  try {
    if (!firstBootAttach || printed) return
    replayedEvents += 1
    mark("first replayed event")
  } catch {}
}

function noteTailEvents(firstBootAttach: boolean, count: number): void {
  try {
    if (!firstBootAttach || printed) return
    tailEvents = count
  } catch {}
}

function settleFirstAttach(firstBootAttach: boolean): void {
  try {
    if (!firstBootAttach || printed) return
    mark("replay-end / catch-up settled")
    printed = true
    const names = [
      "config / connection resolved",
      "fetch server info",
      "list repositories",
      "fetch selected model",
      "fetch model catalog",
      "loadDesktopUiState",
      "boot listSessions",
      "attachSession start",
      "snapshot load",
      "history tail fetch",
      "SSE stream open",
      "first replayed event",
      "replay-end / catch-up settled",
    ]
    const rows = names.map((name) => {
      const timing = timings.get(name)
      return {
        metric: name,
        "start (ms)": timing ? Number(timing.start.toFixed(1)) : "not observed",
        "duration (ms)": timing?.duration == null
          ? "—"
          : Number(timing.duration.toFixed(1)),
        "replayed events": name === "replay-end / catch-up settled" ? replayedEvents : "—",
        "tail events": name === "replay-end / catch-up settled" ? tailEvents : "—",
      }
    })
    console.table(rows)
    postDevReport(rows)
  } catch {}
}

declare const __CHUNKY_BASE_URL__: string | undefined

/** Dev only: the Vite proxy target may be scripts/dev-request-log.ts, which
 *  records this table next to the request timeline. Packaged builds never
 *  reach here (no Vite proxy base URL), and a plain server 404 is ignored. */
function postDevReport(rows: Array<Record<string, unknown>>): void {
  try {
    if (!import.meta.env?.DEV) return
    if (typeof __CHUNKY_BASE_URL__ === "undefined" || __CHUNKY_BASE_URL__ !== "/chunky-api") return
    const text = rows.map((row) => Object.values(row).map(String).join("\t")).join("\n")
    void fetch(`${__CHUNKY_BASE_URL__}/__reqlog/bootperf`, { method: "POST", body: text, keepalive: true }).catch(() => {})
  } catch {}
}

export const bootPerf = {
  mark,
  measure,
  beginFirstAttach,
  noteStreamOpen,
  noteReplayEvent,
  noteTailEvents,
  settleFirstAttach,
}
