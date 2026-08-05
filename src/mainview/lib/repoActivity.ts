// Cross-repository activity shaping for the far-left hover overview.
//
// The overlay answers one question the per-repo sidebar cannot: "what is
// happening everywhere right now, and what just finished while I wasn't
// looking?" All of its input already exists in App (repoSessionCache, fed by
// the cross-repo session stream) — this module only decides grouping, ordering
// and truncation, so the rules can be tested without React or a server.
//
// Two groups per repository:
//
//   In Progress       — busy sessions (root run OR any delegate; isSessionBusy).
//   Recently Settled  — sessions that are NOT busy and are worth a second look:
//                       anything the reader has not seen finish (unread) plus
//                       whatever settled inside the recency window.
//
// "Unread" is the genuinely-just-finished signal. It is set by the completion
// tracker on an OBSERVED running→idle transition, so it distinguishes a session
// that finished while the reader was elsewhere from one that has merely been
// idle for a while — a distinction `lastActivity` alone cannot make.
//
// Pure — run with: bun test src/mainview/lib/repoActivity.test.ts
import type { SessionSummary } from "@chunky/protocol"
import { isSessionBusy } from "./sessionSummaries"

/** How many settled rows one repository contributes before it is truncated. */
export const SETTLED_PER_REPO = 5

/** How recently a non-busy session must have finished to be "recent" on its own
 *  merit. Unread rows ignore this: being unread IS the reason to show them. */
export const RECENT_SETTLED_MS = 3 * 60 * 60_000

/** Just the repository identity the overlay renders — not the whole Repo. */
export interface ActivityRepo {
  id: string
  name: string
}

export interface ActivityRow {
  sessionId: string
  title: string
  lastActivity: number
  /** Root run or a delegate is still working. */
  busy: boolean
  /** Finished while the reader was not looking at it. */
  unread: boolean
}

export interface RepoActivity {
  repoId: string
  repoName: string
  inProgress: ActivityRow[]
  settled: ActivityRow[]
  /** Settled rows withheld by the per-repo cap (0 when nothing is hidden). */
  settledHidden: number
}

export interface ActivityOptions {
  /** Sessions with an observed, unseen completion. */
  unread?: ReadonlySet<string>
  now: number
  settledLimit?: number
  recentMs?: number
}

function toRow(session: SessionSummary, unread: ReadonlySet<string>): ActivityRow {
  return {
    sessionId: session.sessionId,
    title: session.title,
    lastActivity: session.lastActivity,
    busy: isSessionBusy(session),
    unread: unread.has(session.sessionId),
  }
}

/** Newest first. */
function byActivity(a: ActivityRow, b: ActivityRow): number {
  return b.lastActivity - a.lastActivity
}

/**
 * Group every repository's rows into In Progress / Recently Settled.
 *
 * Repositories with nothing in either group are OMITTED entirely: a calm
 * overview should not make the reader scroll past silent repos to find the two
 * that are working. Input order is preserved for the rest, so the overlay reads
 * in the same order as the repo tabs.
 */
export function buildRepoActivity(
  repos: readonly ActivityRepo[],
  rowsByRepo: ReadonlyMap<string, readonly SessionSummary[]>,
  opts: ActivityOptions,
): RepoActivity[] {
  const unread = opts.unread ?? new Set<string>()
  const limit = opts.settledLimit ?? SETTLED_PER_REPO
  const recentMs = opts.recentMs ?? RECENT_SETTLED_MS
  const out: RepoActivity[] = []

  for (const repo of repos) {
    const rows = (rowsByRepo.get(repo.id) ?? []).map((session) => toRow(session, unread))
    const inProgress = rows.filter((row) => row.busy).sort(byActivity)

    // Unread first — "these just finished" is the headline — then the merely
    // recent, newest first. Within each half, newest wins.
    const settledAll = rows
      .filter((row) => !row.busy && (row.unread || opts.now - row.lastActivity <= recentMs))
      .sort((a, b) => (a.unread === b.unread ? byActivity(a, b) : a.unread ? -1 : 1))

    if (inProgress.length === 0 && settledAll.length === 0) continue
    out.push({
      repoId: repo.id,
      repoName: repo.name,
      inProgress,
      settled: settledAll.slice(0, limit),
      settledHidden: Math.max(0, settledAll.length - limit),
    })
  }
  return out
}

/** Headline totals for the edge affordance (a dot/count without opening it). */
export function activityCounts(list: readonly RepoActivity[]): {
  working: number
  unread: number
  repos: number
} {
  let working = 0
  let unread = 0
  for (const repo of list) {
    working += repo.inProgress.length
    unread += repo.settled.filter((row) => row.unread).length
  }
  return { working, unread, repos: list.length }
}

/**
 * Would re-publishing these rows change anything the overlay renders?
 *
 * The session stream pushes a delta every ~250ms, and the publish loop runs for
 * every repository each time. Without this guard the overlay's state would
 * commit on every tick even when nothing moved.
 */
export function sameRepoRows(
  a: ReadonlyMap<string, readonly SessionSummary[]>,
  b: ReadonlyMap<string, readonly SessionSummary[]>,
): boolean {
  if (a.size !== b.size) return false
  for (const [repoId, rows] of a) {
    const other = b.get(repoId)
    if (!other || other.length !== rows.length) return false
    for (let i = 0; i < rows.length; i++) {
      const x = rows[i]!
      const y = other[i]!
      if (
        x.sessionId !== y.sessionId ||
        x.title !== y.title ||
        x.lastActivity !== y.lastActivity ||
        x.running !== y.running ||
        x.busy !== y.busy
      ) {
        return false
      }
    }
  }
  return true
}

/**
 * Fold newly-completed session ids into the unread set.
 *
 * Returns the SAME set when nothing was added, so React can skip the commit.
 * `exclude` is the session on screen: finishing something the reader is
 * watching is not an unread event.
 */
export function addUnreadSessions(
  previous: ReadonlySet<string>,
  done: readonly string[],
  exclude?: string | null,
): Set<string> {
  let changed = false
  const next = new Set(previous)
  for (const id of done) {
    if (id === exclude || next.has(id)) continue
    next.add(id)
    changed = true
  }
  return changed ? next : (previous as Set<string>)
}

/** Drop one session's unread mark (the reader opened it). Identity-stable. */
export function clearUnreadSession(
  previous: ReadonlySet<string>,
  sessionId: string,
): Set<string> {
  if (!previous.has(sessionId)) return previous as Set<string>
  const next = new Set(previous)
  next.delete(sessionId)
  return next
}
