// Wall-clock timing for delegated runs, kept OUT of the reducer so replaying an
// event stream stays pure and deterministic.
//
// Consequence, deliberately: a run that was already finished when we attached
// has no observed start, so its card shows no duration rather than a made-up
// one. Runs we watch start-to-finish report the real elapsed time.
import { useCallback, useEffect, useRef, useState } from "react"
import type { RunRecord } from "./transcript"

export function useRunClock(runs: RunRecord[] | undefined) {
  const timings = useRef(new Map<string, { start: number; end?: number }>())
  const [, tick] = useState(0)

  useEffect(() => {
    if (!runs) return
    const map = timings.current
    let anyRunning = false
    for (const run of runs) {
      const seen = map.get(run.id)
      if (!seen) {
        // Only clock runs we caught starting; replayed history stays untimed.
        if (run.status === "running") map.set(run.id, { start: Date.now() })
      } else if (run.status === "done" && seen.end == null) {
        seen.end = Date.now()
      }
      if (run.status === "running") anyRunning = true
    }
    if (!anyRunning) return
    const id = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(id)
  }, [runs])

  return useCallback((run: RunRecord | undefined): number | undefined => {
    if (!run) return undefined
    const seen = timings.current.get(run.id)
    if (!seen) return undefined
    return (seen.end ?? Date.now()) - seen.start
  }, [])
}
