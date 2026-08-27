// Server-reported delegate status, folded into the transcript's own projection.
//
// The SSE transcript is authoritative for what a delegate DID and for whether
// it has settled. Two things it cannot say, which GET /api/sessions/:id/delegates
// can:
//
//   · How long a run has really been going. `thread.spawn` carries no start
//     time, so lib/useRunClock only times runs it watched start — a delegate
//     that was already working when we attached reads short.
//   · That a run we never saw settle is in fact finished (a missed
//     `thread.status`, a detached spawn that ended while we were elsewhere).
//
// The merge is therefore ONE-WAY and additive: a server snapshot may settle a
// run the projection still shows running, and may replace its elapsed number.
// It may never resurrect a run the transcript has already settled, and it never
// touches TranscriptState or a RunRecord — everything here returns new objects
// that live only in the LiveRunsValue ChatView hands to the pills.
import type { DelegateRunStatus, DelegatesResult } from "./api"
import type { LiveRunView, RunAnchor } from "./runs"
import type { RunRecord } from "./transcript"

export type { DelegateRunStatus } from "./api"

/** Everything the projection needs from one poll, keyed by RunRecord.id. */
export interface DelegateMerge {
  /** Server elapsed for a matched run; preferred over the local clock. */
  elapsedMs: Map<string, number>
  /** Runs the server says are finished while the transcript still shows them
   *  running. `failed` folds into `done`: a RunRecord has no failure state, and
   *  the delegate's own transcript already carries whatever went wrong. */
  settled: Map<string, "done" | "cancelled">
}

export const EMPTY_MERGE: DelegateMerge = { elapsedMs: new Map(), settled: new Map() }

export interface DelegateMergeInput {
  /** Runs by RunRecord.id (lib/runs `runsById`). */
  runs: ReadonlyMap<string, RunRecord>
  snapshot: readonly DelegateRunStatus[] | null | undefined
  /** RunRecord.id → the SERVER run id that record is known to own, where the
   *  app knows it (a detached spawn prints its run id in the spawning tool's
   *  output). Optional: absent ids fall back to thread-id matching. */
  serverRunIds?: ReadonlyMap<string, string>
}

/**
 * Match the snapshot against the transcript's runs.
 *
 * Matching is `run_id` first, then `thread_id` against `RunRecord.threadId`.
 * `RunRecord.id` is `${threadId}#${nth}` — an APP id the server has never seen —
 * so it is never used as a lookup key on either side.
 *
 * A thread id shared by two runs the transcript still shows running (a seat
 * re-briefed within one turn) is ambiguous: the snapshot row cannot say which
 * of them it describes, so neither is touched unless a run id names one.
 */
export function mergeDelegateStatus(input: DelegateMergeInput): DelegateMerge {
  const { runs, snapshot, serverRunIds } = input
  if (!snapshot || snapshot.length === 0 || runs.size === 0) return EMPTY_MERGE

  const byRunId = new Map<string, DelegateRunStatus>()
  const byThreadId = new Map<string, DelegateRunStatus>()
  for (const row of snapshot) {
    if (row.runId) byRunId.set(row.runId, row)
    byThreadId.set(row.threadId, row)
  }

  // How many still-running records share a thread id — >1 makes a thread-id
  // match ambiguous.
  const runningPerThread = new Map<string, number>()
  for (const record of runs.values()) {
    if (record.status !== "running") continue
    runningPerThread.set(record.threadId, (runningPerThread.get(record.threadId) ?? 0) + 1)
  }

  const elapsedMs = new Map<string, number>()
  const settled = new Map<string, "done" | "cancelled">()
  for (const record of runs.values()) {
    const serverRunId = serverRunIds?.get(record.id)
    const byId = serverRunId ? byRunId.get(serverRunId) : undefined
    const ambiguous = (runningPerThread.get(record.threadId) ?? 0) > 1
    const row = byId ?? (ambiguous ? undefined : byThreadId.get(record.threadId))
    if (!row) continue
    if (Number.isFinite(row.elapsedMs) && row.elapsedMs >= 0) elapsedMs.set(record.id, row.elapsedMs)
    // One-way: the transcript settling a run is final, and a `running` row can
    // never bring a settled run back.
    if (record.status !== "running" || row.status === "running") continue
    settled.set(record.id, row.status === "cancelled" ? "cancelled" : "done")
  }
  return { elapsedMs, settled }
}

/** Is there anything to apply? Lets the caller keep the untouched maps (and
 *  their identities) when the endpoint is unsupported or says nothing new. */
export function mergeIsEmpty(merge: DelegateMerge): boolean {
  return merge.elapsedMs.size === 0 && merge.settled.size === 0
}

/** Run records with server-settled statuses applied. New records, always: the
 *  reduced transcript is never mutated. */
export function mergedRunRecords(
  runs: ReadonlyMap<string, RunRecord>,
  merge: DelegateMerge,
): Map<string, RunRecord> {
  const next = new Map(runs)
  for (const [id, status] of merge.settled) {
    const record = next.get(id)
    if (!record || record.status !== "running") continue
    next.set(id, { ...record, status })
  }
  return next
}

/** Live views minus the runs the server says are finished: their pills stop
 *  streaming a tail and go back to their settled selves. */
export function mergedViews(
  views: ReadonlyMap<string, LiveRunView>,
  merge: DelegateMerge,
): Map<string, LiveRunView> {
  const next = new Map(views)
  for (const id of merge.settled.keys()) next.delete(id)
  return next
}

/**
 * Anchors with server-settled runs moved from a pill's live list to its parked
 * list, so the pill keeps its delegate identity (title, expandable transcript)
 * instead of falling back to a plain tool card.
 *
 * The accent is deliberately left alone: a run's hue must not change under the
 * reader just because its status arrived by poll rather than by stream.
 */
export function mergedAnchors(
  anchors: ReadonlyMap<number, RunAnchor>,
  merge: DelegateMerge,
): Map<number, RunAnchor> {
  const next = new Map(anchors)
  if (merge.settled.size === 0) return next
  for (const [at, anchor] of anchors) {
    if (!anchor.liveRunIds.some((id) => merge.settled.has(id))) continue
    const liveRunIds = anchor.liveRunIds.filter((id) => !merge.settled.has(id))
    const parkedRunIds = [
      ...anchor.parkedRunIds,
      ...anchor.liveRunIds.filter((id) => merge.settled.has(id)),
    ]
    const liveRunId = liveRunIds[0]
    next.set(at, {
      accent: anchor.accent,
      liveRunIds,
      parkedRunIds,
      ...(liveRunId ? { liveRunId } : {}),
    })
  }
  return next
}

/* ------------------------------------------------------------------ polling */

export interface DelegatePollDeps {
  fetchDelegates: (baseUrl: string, sessionId: string) => Promise<DelegatesResult>
  /** Commit a fresh snapshot. The caller's generation guard lives here. */
  onSnapshot: (runs: DelegateRunStatus[]) => void
  /** This server has no such endpoint: the caller stops asking it, for good. */
  onUnsupported?: (baseUrl: string) => void
}

export interface DelegatePoll {
  /** One poll. A no-op while a request is in flight or once stopped, so a slow
   *  server can never stack requests behind the interval. */
  tick: (baseUrl: string, sessionId: string) => Promise<void>
  stop: () => void
  readonly stopped: boolean
  readonly inFlight: boolean
}

/**
 * The polling loop's rules, kept out of React so they can be tested without a
 * DOM (this runner has none) and so the hook stays a thin wrapper:
 *
 *   · never two requests at once (in-flight guard),
 *   · `unsupported` stops the poll permanently and tells the caller once,
 *   · an error keeps the last snapshot and simply waits for the next tick,
 *   · a response that lands after `stop()` commits nothing.
 */
export function createDelegatePoll(deps: DelegatePollDeps): DelegatePoll {
  let inFlight = false
  let stopped = false
  return {
    get stopped() {
      return stopped
    },
    get inFlight() {
      return inFlight
    },
    stop() {
      stopped = true
    },
    async tick(baseUrl: string, sessionId: string): Promise<void> {
      if (stopped || inFlight || !baseUrl || !sessionId) return
      inFlight = true
      try {
        const result = await deps.fetchDelegates(baseUrl, sessionId)
        if (stopped) return
        if (result.status === "unsupported") {
          stopped = true
          deps.onUnsupported?.(baseUrl)
          return
        }
        if (result.status === "ok") deps.onSnapshot(result.runs)
        // "error": transient (a dropped connection, a 500). Keep whatever the
        // last good poll said and try again on the next tick.
      } finally {
        inFlight = false
      }
    },
  }
}
