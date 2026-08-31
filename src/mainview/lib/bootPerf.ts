// Temporary startup diagnostics. This module deliberately owns no React state:
// the first renderer attachment records into this singleton and prints once.
type Timing = { start: number; duration?: number }

const rendererStart = safeNow()
const timings = new Map<string, Timing>()
let firstAttachClaimed = false
let printed = false
let replayedEvents = 0

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
      }
    })
    console.table(rows)
  } catch {}
}

export const bootPerf = {
  mark,
  measure,
  beginFirstAttach,
  noteStreamOpen,
  noteReplayEvent,
  settleFirstAttach,
}
