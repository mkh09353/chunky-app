// Wall-clock timing for delegated runs, kept OUT of the reducer so replaying an
// event stream stays pure and deterministic.
//
// Two deliberate consequences:
//
//   · A run that was already finished when we first saw it has no observed
//     start, so its card shows no duration rather than a made-up one.
//   · A run first seen ALREADY RUNNING (attaching to a session whose delegate
//     started while we were elsewhere, or a reconnect) starts its clock at
//     first sight, so its elapsed reads short. The alternative is inventing a
//     start time — the protocol carries none on `thread.spawn` — and a number
//     that is honestly "at least this long" beats a fabricated one.
//
// The timings live in a MODULE-level map rather than a component ref: the strip
// above the composer and the tool pill inside the transcript both clock the same
// runs, and switching sessions (which remounts ChatView) used to throw every
// start time away, so a delegate you left running showed no elapsed when you
// came back. Keyed by session so two sessions' runs can never collide on a run
// id, and bounded so a long renderer lifetime cannot grow it without limit.
import { useCallback, useEffect, useState } from "react"
import type { RunRecord } from "./transcript"

interface Timing {
  start: number
  end?: number
}

/** Ceiling on remembered runs. Settled ones are evicted first (their elapsed is
 *  already frozen on screen and re-derivable as "no duration" at worst). */
export const RUN_TIMINGS_MAX = 400

const timings = new Map<string, Timing>()

function key(sessionId: string | null | undefined, runId: string): string {
  return `${sessionId ?? "-"}\u0000${runId}`
}

/** Evict settled entries oldest-first, then oldest entries outright. Map
 *  iteration is insertion order, so "oldest" needs no extra bookkeeping. */
function prune(): void {
  if (timings.size <= RUN_TIMINGS_MAX) return
  for (const [k, timing] of timings) {
    if (timings.size <= RUN_TIMINGS_MAX) return
    if (timing.end != null) timings.delete(k)
  }
  for (const k of timings.keys()) {
    if (timings.size <= RUN_TIMINGS_MAX) return
    timings.delete(k)
  }
}

/** Fold the current run records into the store. Returns true when at least one
 *  run is still running (the caller uses that to decide whether to tick). */
export function noteRunTimings(
  sessionId: string | null | undefined,
  runs: readonly RunRecord[] | undefined,
  now: number = Date.now(),
): boolean {
  if (!runs) return false
  let anyRunning = false
  for (const run of runs) {
    const k = key(sessionId, run.id)
    const seen = timings.get(k)
    if (!seen) {
      // Only clock runs we caught running; already-settled history stays untimed.
      if (run.status === "running") timings.set(k, { start: now })
    } else if (run.status === "done" && seen.end == null) {
      seen.end = now
    }
    if (run.status === "running") anyRunning = true
  }
  prune()
  return anyRunning
}

/** Elapsed for a run we watched start, or undefined. */
export function runElapsed(
  sessionId: string | null | undefined,
  run: RunRecord | undefined,
  now: number = Date.now(),
): number | undefined {
  if (!run) return undefined
  const seen = timings.get(key(sessionId, run.id))
  if (!seen) return undefined
  return (seen.end ?? now) - seen.start
}

/** Test seam only — the store is process-global by design. */
export function resetRunTimings(): void {
  timings.clear()
}

/** Test seam only. */
export function runTimingsSize(): number {
  return timings.size
}

/**
 * Clock the given runs and hand back an elapsed lookup.
 *
 * Safe to call from more than one component for the same session: the store is
 * shared and every write is idempotent, which is what keeps the ambient strip
 * and the tool pill showing the same number.
 */
export function useRunClock(
  runs: RunRecord[] | undefined,
  sessionId?: string | null,
): (run: RunRecord | undefined) => number | undefined {
  const [, tick] = useState(0)

  useEffect(() => {
    const anyRunning = noteRunTimings(sessionId, runs)
    if (!anyRunning) return
    const id = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(id)
  }, [runs, sessionId])

  return useCallback(
    (run: RunRecord | undefined): number | undefined => runElapsed(sessionId, run),
    [sessionId],
  )
}
