// Live status for the delegated runs of the ATTACHED session.
//
// Deliberately parsimonious, because this is a poll sitting beside a stream
// that already carries almost everything:
//
//   · zero requests for a session with no live run (the poll only exists to
//     enrich runs that are on screen and moving),
//   · zero requests once a server has answered "no such endpoint", until the
//     base URL changes (a reconnect or an in-place upgrade),
//   · never two requests in flight at once, however slow the server is,
//   · a response for a previous session or base URL commits nothing
//     (generation guard, same rule as useAttachedSession's attachments).
//
// The loop's rules live in lib/delegateStatus (`createDelegatePoll`) so they can
// be tested without a DOM; this hook is the React shell around them.
import { useEffect, useRef, useState } from "react"
import { getSessionDelegates, type DelegateRunStatus, type DelegatesResult } from "~/lib/api"
import { createDelegatePoll } from "~/lib/delegateStatus"

/** Poll cadence while at least one delegate is live. Slow on purpose: the SSE
 *  stream is the real channel, and this only sharpens elapsed and catches a
 *  settle the stream missed. */
export const DELEGATE_POLL_MS = 4_000

/** Injectable timers, so the loop below can be driven without a scheduler (and
 *  without a DOM — this test runner has none). */
export interface IntervalTimers {
  setInterval: (fn: () => void, ms: number) => unknown
  clearInterval: (handle: unknown) => void
}

const REAL_TIMERS: IntervalTimers = {
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
}

export interface DelegatePollingOptions {
  baseUrl: string
  sessionId: string
  intervalMs: number
  fetchDelegates: (baseUrl: string, sessionId: string) => Promise<DelegatesResult>
  onSnapshot: (runs: DelegateRunStatus[]) => void
  onUnsupported?: (baseUrl: string) => void
  timers?: IntervalTimers
}

/**
 * Poll one session until told to stop: an immediate first request (a live run
 * should not wait a whole interval for its real elapsed) and then one per tick,
 * with the loop's own rules — no overlap, unsupported is terminal, an error is
 * skipped — owned by `createDelegatePoll`.
 *
 * Returns the teardown the effect hands back to React: it both stops the
 * interval and disowns any response still in flight.
 */
export function startDelegatePolling(options: DelegatePollingOptions): () => void {
  const { baseUrl, sessionId, intervalMs, timers = REAL_TIMERS } = options
  const poll = createDelegatePoll({
    fetchDelegates: options.fetchDelegates,
    onSnapshot: options.onSnapshot,
    ...(options.onUnsupported ? { onUnsupported: options.onUnsupported } : {}),
  })
  void poll.tick(baseUrl, sessionId)
  const handle = timers.setInterval(() => void poll.tick(baseUrl, sessionId), intervalMs)
  return () => {
    poll.stop()
    timers.clearInterval(handle)
  }
}

/** Is there anything worth polling for? The four ways to answer no are the four
 *  ways this hook stays silent: no server, no session, an endpoint this server
 *  has already refused, and — the common one — no run in flight. */
export function shouldPollDelegates(input: {
  baseUrl?: string | null
  sessionId?: string | null
  available?: boolean
  liveRunCount: number
}): boolean {
  return (
    !!input.baseUrl &&
    !!input.sessionId &&
    input.available !== false &&
    input.liveRunCount > 0
  )
}

export interface DelegateStatusOptions {
  baseUrl?: string | null
  sessionId?: string | null
  /** How many runs the transcript currently shows in flight. 0 = no polling. */
  liveRunCount: number
  /** False once this server has said it has no delegates endpoint. */
  available?: boolean
  onUnsupported?: (baseUrl: string) => void
  /** Test seam. */
  fetchDelegates?: (baseUrl: string, sessionId: string) => Promise<DelegatesResult>
  intervalMs?: number
}

/** The latest snapshot, or null when nothing is being polled. */
export function useDelegateStatus(options: DelegateStatusOptions): DelegateRunStatus[] | null {
  const {
    baseUrl = null,
    sessionId = null,
    liveRunCount,
    available = true,
    onUnsupported,
    fetchDelegates = getSessionDelegates,
    intervalMs = DELEGATE_POLL_MS,
  } = options

  const [snapshot, setSnapshot] = useState<DelegateRunStatus[] | null>(null)
  const generation = useRef(0)

  // Moving to another session or server invalidates every in-flight response
  // AND whatever is on screen: a snapshot is only ever about one session.
  // Declared first so the polling effect below reads the bumped generation.
  useEffect(() => {
    generation.current += 1
    setSnapshot(null)
  }, [baseUrl, sessionId])

  const active = shouldPollDelegates({ baseUrl, sessionId, available, liveRunCount })

  useEffect(() => {
    if (!active || !baseUrl || !sessionId) {
      // Nothing live: drop the snapshot rather than let a stale one describe a
      // seat that gets re-briefed on the same thread id later. (React bails out
      // when it is already null, so this cannot loop.)
      setSnapshot(null)
      return
    }
    const mine = generation.current
    return startDelegatePolling({
      baseUrl,
      sessionId,
      intervalMs,
      fetchDelegates,
      onSnapshot: (runs) => {
        if (generation.current === mine) setSnapshot(runs)
      },
      ...(onUnsupported ? { onUnsupported } : {}),
    })
  }, [active, baseUrl, sessionId, intervalMs, fetchDelegates, onUnsupported])

  return snapshot
}
