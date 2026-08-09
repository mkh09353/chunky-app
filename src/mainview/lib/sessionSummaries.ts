// Cross-repository session-summary bookkeeping for the sidebar, the repo tabs
// and the completion (unread + horn) rules.
//
// Two servers-side sources describe the same rows, and they are NOT equivalent:
//
//   GET /api/sessions?repo=<id>  (listSessions)  → authoritative. Carries
//     `busy` = root run OR a live delegate thread OR a running detached spawn.
//   GET /api/sessions/stream     (sessionStream) → fast (250ms debounced).
//     Current servers put the same `busy` on these rows; OLDER ones send only
//     `running` (the ROOT run), leaving `busy` undefined.
//
// The completion rules are defined on `busy`, so the stream must never be
// allowed to silently downgrade a row to "idle" just because the root run
// finished while a sidekick keeps working. Hence `mergeSummary`, which keys off
// the PRESENCE of the field rather than the server version: a row that states
// `busy` is taken at its word (no confirming poll), while one that cannot speak
// for it inherits the last authoritative value and is reported as stale so the
// caller can settle it with one targeted poll.
//
// Pure — run with: bun test src/mainview/lib/sessionSummaries.test.ts
import type { SessionDelta, SessionSummary } from "@chunky/protocol"

export type SummaryMap = ReadonlyMap<string, SessionSummary>

/** The busy rule every consumer shares: delegates count, not just the root run. */
export function isSessionBusy(session: SessionSummary | undefined | null): boolean {
  return !!(session?.busy ?? session?.running)
}

/**
 * Fold a streamed row onto what we already knew.
 *
 * `running` is always authoritative (the stream computes it the same way the
 * poll does). `busy` is only derivable when it is true by implication —
 * a running root is busy by definition. Otherwise the previous value stands.
 */
export function mergeSummary(
  previous: SessionSummary | undefined,
  next: SessionSummary,
): SessionSummary {
  if (next.busy !== undefined) return next
  if (next.running) return { ...next, busy: true }
  if (previous?.busy === undefined) return next
  return { ...next, busy: previous.busy }
}

/** True when the merged row is carrying a `busy` we can no longer justify —
 *  the root run stopped, so only a poll can say whether delegates are alive. */
export function needsAuthoritativeBusy(
  previous: SessionSummary | undefined,
  next: SessionSummary,
): boolean {
  return next.busy === undefined && !next.running && previous?.busy === true
}

export interface SummaryUpdate {
  map: Map<string, SessionSummary>
  /** Sessions whose `busy` must be confirmed by a poll before it can settle. */
  stale: string[]
}

/** Replace the whole map from a stream snapshot, preserving known `busy`. */
export function applySessionSnapshot(previous: SummaryMap, rows: SessionSummary[]): SummaryUpdate {
  const map = new Map<string, SessionSummary>()
  const stale: string[] = []
  for (const row of rows) {
    const before = previous.get(row.sessionId)
    if (needsAuthoritativeBusy(before, row)) stale.push(row.sessionId)
    map.set(row.sessionId, mergeSummary(before, row))
  }
  return { map, stale }
}

/** Apply an upsert/remove delta, preserving known `busy` on every upsert. */
export function applySessionDelta(previous: SummaryMap, delta: SessionDelta): SummaryUpdate {
  const map = new Map(previous)
  const stale: string[] = []
  for (const row of delta.upsert ?? []) {
    const before = map.get(row.sessionId)
    if (needsAuthoritativeBusy(before, row)) stale.push(row.sessionId)
    map.set(row.sessionId, mergeSummary(before, row))
  }
  for (const id of delta.remove ?? []) map.delete(id)
  return { map, stale }
}

/** Absorb an authoritative list (a poll result) into the map. */
export function absorbAuthoritative(
  previous: SummaryMap,
  rows: readonly SessionSummary[],
): Map<string, SessionSummary> {
  const map = new Map(previous)
  for (const row of rows) map.set(row.sessionId, row)
  return map
}

/** The map's rows for one workspace, newest activity first (list order). */
export function sessionsInWorkspace(map: SummaryMap, workspace: string | null): SessionSummary[] {
  if (!workspace) return []
  const rows: SessionSummary[] = []
  for (const row of map.values()) if (row.workspace === workspace) rows.push(row)
  return rows.sort((a, b) => b.lastActivity - a.lastActivity)
}

/** Explicit repository-less rows from the global session stream. */
export function sessionsWithoutRepository(map: SummaryMap): SessionSummary[] {
  const rows: SessionSummary[] = []
  for (const row of map.values()) if (row.repositoryScope === "none") rows.push(row)
  return rows.sort((a, b) => b.lastActivity - a.lastActivity)
}

/**
 * Membership + field freshness from `next`, `busy` from whichever source knows.
 *
 * `next` decides which sessions exist (the server just said so); a row that
 * cannot speak for `busy` keeps the value the previous list carried.
 */
export function mergeSummaryLists(
  previous: readonly SessionSummary[],
  next: readonly SessionSummary[],
): SessionSummary[] {
  const before = new Map(previous.map((row) => [row.sessionId, row]))
  return next.map((row) => mergeSummary(before.get(row.sessionId), row))
}

/**
 * Membership union, newest activity first.
 *
 * For a source that cannot speak for membership (the session stream is scoped
 * by workspace path and debounced, so a session it does not mention in one
 * batch has NOT necessarily gone away), absence must never remove a row: only
 * an authoritative list may shorten a repo.
 */
export function unionSummaries(
  previous: readonly SessionSummary[],
  next: readonly SessionSummary[],
): SessionSummary[] {
  const seen = new Set(next.map((row) => row.sessionId))
  const out = [...next, ...previous.filter((row) => !seen.has(row.sessionId))]
  return out.sort((a, b) => b.lastActivity - a.lastActivity)
}

/** Same rows, same order? Lets a caller skip a no-op React commit. */
export function sameSummaryList(
  a: readonly SessionSummary[],
  b: readonly SessionSummary[],
): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!
    const y = b[i]!
    if (
      x.sessionId !== y.sessionId ||
      x.title !== y.title ||
      x.lastActivity !== y.lastActivity ||
      x.attached !== y.attached ||
      x.running !== y.running ||
      x.busy !== y.busy ||
      x.incognito !== y.incognito
    ) {
      return false
    }
  }
  return true
}

/** Per-session running history behind the completion rules. */
export interface CompletionTracker {
  was: Map<string, boolean>
  since: Map<string, number>
}

export function createCompletionTracker(): CompletionTracker {
  return { was: new Map(), since: new Map() }
}

export interface CompletionEntry {
  /** Bookkeeping key (the background tracker keys by `${repoId}:${sessionId}`). */
  key: string
  sessionId: string
  running: boolean
}

export interface CompletionResult {
  /** At least one run finished after running long enough to be worth a horn. */
  completed: boolean
  /** Sessions that just finished a qualifying run (callers drop the selected one). */
  done: string[]
}

/**
 * Fold the latest rows into the tracker and report qualifying running→idle
 * transitions.
 *
 * A transition only counts when THIS client observed the running state first
 * (so a replay or a first load can never fire one) and the run lasted at least
 * `minRunMs` (so a blip is not a completion). Rows absent from `entries` keep
 * their bookkeeping untouched — repos are folded in one at a time.
 */
export function trackCompletions(
  tracker: CompletionTracker,
  entries: readonly CompletionEntry[],
  now: number,
  minRunMs: number,
): CompletionResult {
  const done: string[] = []
  let completed = false
  for (const entry of entries) {
    const previous = tracker.was.get(entry.key)
    if (entry.running && !previous) tracker.since.set(entry.key, now)
    if (previous && !entry.running) {
      const since = tracker.since.get(entry.key)
      tracker.since.delete(entry.key)
      if (since != null && now - since >= minRunMs) {
        completed = true
        done.push(entry.sessionId)
      }
    }
    tracker.was.set(entry.key, entry.running)
  }
  return { completed, done }
}

/** Forget one repo's bookkeeping (its tab closed, or it was removed). */
export function forgetRepoTracking(tracker: CompletionTracker, repoId: string): void {
  const prefix = `${repoId}:`
  for (const key of [...tracker.was.keys()]) if (key.startsWith(prefix)) tracker.was.delete(key)
  for (const key of [...tracker.since.keys()]) if (key.startsWith(prefix)) tracker.since.delete(key)
}
