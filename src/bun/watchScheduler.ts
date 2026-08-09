// The daily competitor-watch check.
//
// Two ways a check starts and exactly one of them may win:
//   - CATCH-UP on launch, when the last successful check is older than the
//     staleness window (the machine was asleep, the app was closed);
//   - the daily SLOT, armed for the configured local hour.
//
// A single in-flight guard covers both, so a launch catch-up landing on the slot
// boundary cannot double-fire. Every timestamp the decision rests on is
// persisted by the store, so relaunching mid-day does not re-run the check.
//
// Clock and timers are injected; the whole policy is unit-tested with fake ones
// (watchScheduler.test.ts) and never sleeps in tests.

export const DEFAULT_WATCH_HOUR = 8
export const STALE_AFTER_MS = 20 * 60 * 60_000

export type SchedulerState = { hour: number; lastCheckAt: number | null }

export type SchedulerDeps<T = unknown> = {
  /** Reads the persisted hour + last successful check. */
  state: () => Promise<SchedulerState> | SchedulerState
  /** Runs one check of every watch. Must resolve even when the check fails. */
  run: () => Promise<T>
  now?: () => number
  setTimer?: (ms: number, fn: () => void) => unknown
  clearTimer?: (handle: unknown) => void
  /** Non-fatal problems (a rejected run) surface here instead of throwing. */
  onError?: (error: unknown) => void
}

/** The next local `hour:00` strictly after `from`. */
export function nextSlot(hour: number, from: number): number {
  const safe = Number.isFinite(hour) ? Math.min(23, Math.max(0, Math.floor(hour))) : DEFAULT_WATCH_HOUR
  const at = new Date(from)
  at.setHours(safe, 0, 0, 0)
  let target = at.getTime()
  // setHours on a DST boundary can land before `from`; step days until it is
  // genuinely in the future rather than arming a zero/negative delay.
  while (target <= from) {
    at.setDate(at.getDate() + 1)
    at.setHours(safe, 0, 0, 0)
    target = at.getTime()
  }
  return target
}

/** Did we miss a day? A watch never checked before always needs one. */
export function needsCatchUp(
  lastCheckAt: number | null,
  now: number,
  staleAfterMs: number = STALE_AFTER_MS,
): boolean {
  if (lastCheckAt === null) return true
  // A clock that jumped backwards must not make a fresh check look ancient.
  if (lastCheckAt > now) return false
  return now - lastCheckAt >= staleAfterMs
}

export type WatchScheduler<T = unknown> = {
  /** Catch up if we are stale, then arm the next slot. Safe to call twice. */
  start: () => Promise<void>
  /**
   * Force a check now. The manual "Check now" goes through HERE so it shares
   * the in-flight guard with the daily slot — neither can start while the other
   * is running, in either order.
   */
  checkNow: () => Promise<{ ran: true; result: T } | { ran: false }>
  /** Re-read the persisted hour and re-arm — used when the user changes it. */
  reschedule: () => Promise<void>
  stop: () => void
  /** When the next slot will fire, or null while disarmed. */
  nextRunAt: () => number | null
  running: () => boolean
}

export function createWatchScheduler<T = unknown>(deps: SchedulerDeps<T>): WatchScheduler<T> {
  const now = deps.now ?? (() => Date.now())
  const setTimer = deps.setTimer ?? ((ms, fn) => setTimeout(fn, ms))
  const clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>))

  let handle: unknown = null
  let armedFor: number | null = null
  let inFlight = false
  let started = false
  let stopped = false

  const disarm = () => {
    if (handle !== null) clearTimer(handle)
    handle = null
    armedFor = null
  }

  /** The one place a check runs. `ran: false` means one was already in flight. */
  const runOnce = async (): Promise<{ ran: true; result: T } | { ran: false }> => {
    if (inFlight || stopped) return { ran: false }
    inFlight = true
    try {
      return { ran: true, result: await deps.run() }
    } catch (error) {
      // A failed check must never take the scheduler down with it.
      deps.onError?.(error)
      return { ran: true, result: undefined as T }
    } finally {
      inFlight = false
    }
  }

  const arm = async () => {
    if (stopped) return
    const state = await deps.state()
    disarm()
    const at = nextSlot(state.hour, now())
    armedFor = at
    handle = setTimer(Math.max(0, at - now()), () => {
      handle = null
      armedFor = null
      void (async () => {
        await runOnce()
        await arm()
      })()
    })
  }

  return {
    async start() {
      // Idempotent: a second start must not stack timers or re-run catch-up.
      if (started || stopped) return
      started = true
      const state = await deps.state()
      if (needsCatchUp(state.lastCheckAt, now())) await runOnce()
      await arm()
    },
    async checkNow() {
      const outcome = await runOnce()
      if (outcome.ran) await arm()
      return outcome
    },
    async reschedule() {
      if (!started || stopped) return
      await arm()
    },
    stop() {
      stopped = true
      disarm()
    },
    nextRunAt: () => armedFor,
    running: () => inFlight,
  }
}
