// A shared, coarse wall clock for age-based UI rules.
//
// Anything that classifies by elapsed time (a thread settling into history
// after three quiet days) otherwise only re-evaluates when something unrelated
// happens to re-render — and the sidebar deliberately skips no-op commits, so
// "unrelated" can mean "not for a long while". This gives those rules their own
// heartbeat.
//
// One interval for the whole app, started on the first subscriber and stopped
// with the last. A minute is plenty: the rules it feeds are measured in days.
import { useSyncExternalStore } from "react"

const TICK_MS = 60_000

let now = Date.now()
let timer: ReturnType<typeof setInterval> | null = null
const listeners = new Set<() => void>()

function publish(): void {
  now = Date.now()
  for (const listener of listeners) listener()
}

/** A sleeping machine does not run timers; waking up must not wait a minute. */
function onVisible(): void {
  if (typeof document !== "undefined" && document.visibilityState === "visible") publish()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  if (timer === null) {
    // Catch up immediately: the module value may be minutes stale if every
    // subscriber went away and came back.
    now = Date.now()
    timer = setInterval(publish, TICK_MS)
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisible)
    }
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0 && timer !== null) {
      clearInterval(timer)
      timer = null
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisible)
      }
    }
  }
}

function snapshot(): number {
  return now
}

/** Wall-clock milliseconds, refreshed about once a minute. Stable in between,
 *  so it is safe to use as a memo dependency. */
export function useMinuteClock(): number {
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}
