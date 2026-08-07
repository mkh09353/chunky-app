// The Home feed: one flat, cross-repository answer to "what happened while I
// was away, and what needs me?".
//
// Deliberately FLAT and sorted by urgency/recency rather than grouped by
// repository (which is what lib/repoActivity does for the far-left overview).
// Grouping optimises for "how is repo X doing"; this optimises for triage,
// where the repo is an attribute of a row, not a heading you scan past. Each
// row therefore carries its own repo identity so the reader can still tell at a
// glance where it belongs.
//
// Three sections, in the order a reader should spend attention:
//
//   Needs You        — blocked: the agent stopped and cannot continue without
//                      the reader. v1 recognises exactly one such state, a
//                      session goal with status "blocked" (the `goal_blocked`
//                      tool). There is no tool-approval or ask-user concept in
//                      the protocol, so nothing else can honestly go here.
//   Still Running    — busy (root run OR any delegate; isSessionBusy).
//   Recently Settled — idle, and either unread or recent enough to matter.
//
// A session appears in at most ONE section: busy wins over blocked (something
// is working, so it is not waiting on you), and both win over settled.
//
// Pure — no React, no server, no clock of its own. Run with:
//   bun test src/mainview/lib/homeFeed.test.ts
import type { GoalSnapshot, SessionSummary } from "@chunky/protocol"
import { isSessionBusy } from "./sessionSummaries"

/** How many settled rows the feed shows before it truncates. Sized for the
 *  realistic load the feed is designed around (a handful of repos, a few live
 *  threads each) — enough to cover a lunch break, not a scrollable archive. */
export const SETTLED_LIMIT = 10

/** How recently an idle session must have finished to earn a settled row on its
 *  own merit. Unread rows ignore this, exactly as in lib/repoActivity: being
 *  unread IS the reason to show them. A day rather than that module's three
 *  hours, because Home answers "while I was away" (overnight included) whereas
 *  the hover overlay answers "right now". */
export const RECENT_SETTLED_MS = 24 * 60 * 60_000

/** How many idle sessions per repository are worth asking the server about when
 *  hunting for blocked goals. Goals are a per-session GET, so the candidate set
 *  must stay small; anything older than the settled window cannot surface in
 *  the feed anyway. */
export const GOAL_CANDIDATES_PER_REPO = 12

/** Just the repository identity the feed renders — not the whole Repo. */
export interface FeedRepo {
  id: string
  name: string
}

/** What every row carries, whichever section it lands in. */
export interface FeedRow {
  sessionId: string
  repoId: string
  repoName: string
  title: string
  lastActivity: number
  /** Finished while the reader was not looking (renderer-owned unread set). */
  unread: boolean
}

export interface NeedsYouRow extends FeedRow {
  /** Why it stopped, as far as the wire can say. `GoalSnapshot` carries no
   *  blocked reason, so this is the goal's objective — the closest honest
   *  answer available without a protocol change. */
  reason: string
  /** How long it has been waiting, in ms. Derived from `lastActivity`. */
  waitingMs: number
}

export interface RunningRow extends FeedRow {
  /** Time since this client FIRST saw the session busy. Omitted when the
   *  session was already running when we started watching — an unknown elapsed
   *  is shown as nothing, never as a guess. */
  elapsedMs?: number
}

export type SettledRow = FeedRow

export interface HomeFeed {
  needsYou: NeedsYouRow[]
  running: RunningRow[]
  settled: SettledRow[]
  /** Settled rows withheld by the cap (0 when nothing is hidden). */
  settledHidden: number
}

export interface HomeFeedOptions {
  /** Sessions with an observed, unseen completion (App's `unreadDone`). */
  unread?: ReadonlySet<string>
  /** sessionId → goal, for whatever sessions have been fetched. Only
   *  `status === "blocked"` produces a Needs You row; everything else is
   *  ignored, so a partial or failed fetch simply yields a shorter section. */
  goals?: ReadonlyMap<string, GoalSnapshot | null>
  /** sessionId → when this client first saw it busy (see `updateBusySince`). */
  busySince?: ReadonlyMap<string, number>
  now: number
  settledLimit?: number
  recentMs?: number
}

/** Newest activity first — the ordering every list in the app shares. */
function byActivity(a: FeedRow, b: FeedRow): number {
  return b.lastActivity - a.lastActivity
}

function toRow(
  session: SessionSummary,
  repo: FeedRepo,
  unread: ReadonlySet<string>,
): FeedRow {
  return {
    sessionId: session.sessionId,
    repoId: repo.id,
    repoName: repo.name,
    title: session.title,
    lastActivity: session.lastActivity,
    unread: unread.has(session.sessionId),
  }
}

/**
 * Shape every repository's rows into the three sections.
 *
 * Repository input order breaks ties only; the sections themselves are ordered
 * by time, because a triage list that reshuffles when a repo tab moves would be
 * unreadable. A session id seen twice (two repos pointing at the same
 * workspace) is kept once, under whichever repo claimed it first.
 */
export function buildHomeFeed(
  repos: readonly FeedRepo[],
  rowsByRepo: ReadonlyMap<string, readonly SessionSummary[]>,
  opts: HomeFeedOptions,
): HomeFeed {
  const unread = opts.unread ?? new Set<string>()
  const goals = opts.goals
  const busySince = opts.busySince
  const limit = opts.settledLimit ?? SETTLED_LIMIT
  const recentMs = opts.recentMs ?? RECENT_SETTLED_MS

  const needsYou: NeedsYouRow[] = []
  const running: RunningRow[] = []
  const settledAll: SettledRow[] = []
  const seen = new Set<string>()

  for (const repo of repos) {
    for (const session of rowsByRepo.get(repo.id) ?? []) {
      if (seen.has(session.sessionId)) continue
      seen.add(session.sessionId)
      const row = toRow(session, repo, unread)

      if (isSessionBusy(session)) {
        const since = busySince?.get(session.sessionId)
        running.push(since == null ? row : { ...row, elapsedMs: Math.max(0, opts.now - since) })
        continue
      }

      const goal = goals?.get(session.sessionId)
      if (goal && goal.status === "blocked") {
        needsYou.push({
          ...row,
          reason: goal.objective,
          waitingMs: Math.max(0, opts.now - session.lastActivity),
        })
        continue
      }

      if (row.unread || opts.now - row.lastActivity <= recentMs) settledAll.push(row)
    }
  }

  needsYou.sort(byActivity)
  running.sort(byActivity)
  settledAll.sort(byActivity)

  return {
    needsYou,
    running,
    settled: limit > 0 ? settledAll.slice(0, limit) : settledAll,
    settledHidden: limit > 0 ? Math.max(0, settledAll.length - limit) : 0,
  }
}

/** Headline counts for the greeting line. */
export function homeFeedCounts(feed: HomeFeed): {
  needsYou: number
  running: number
  repos: number
} {
  const repos = new Set<string>()
  for (const row of [...feed.needsYou, ...feed.running, ...feed.settled]) repos.add(row.repoId)
  return { needsYou: feed.needsYou.length, running: feed.running.length, repos: repos.size }
}

export interface BusyEntry {
  sessionId: string
  busy: boolean
}

/**
 * Fold the current busy states into the "first seen busy" map that gives
 * Still Running its elapsed times.
 *
 * The app's `CompletionTracker.since` records the same instant, but only for
 * repositories that are NOT selected (the selected repo's transitions are owned
 * by the attached-session effect), so the feed keeps its own map to cover every
 * repository uniformly.
 *
 * Returns the SAME map when nothing changed, so a caller can skip the commit.
 * A session that stops running forgets its start: the next run is a new run.
 */
export function updateBusySince(
  previous: ReadonlyMap<string, number>,
  entries: readonly BusyEntry[],
  now: number,
): ReadonlyMap<string, number> {
  let next: Map<string, number> | null = null
  const edit = (): Map<string, number> => (next ??= new Map(previous))

  for (const entry of entries) {
    const had = previous.has(entry.sessionId)
    if (entry.busy && !had) edit().set(entry.sessionId, now)
    else if (!entry.busy && had) edit().delete(entry.sessionId)
  }
  return next ?? previous
}

/**
 * Which sessions are worth a goal lookup.
 *
 * Only idle sessions can be blocked-and-waiting, and only rows recent enough to
 * reach the feed are worth the request — so the candidate set is capped both by
 * age and by a per-repository limit. Ordered newest-first within each repo,
 * which is the order `listSessions` already returns.
 */
export function homeGoalCandidates(
  repos: readonly FeedRepo[],
  rowsByRepo: ReadonlyMap<string, readonly SessionSummary[]>,
  opts: { now: number; recentMs?: number; perRepoLimit?: number },
): { repoId: string; sessionId: string }[] {
  const recentMs = opts.recentMs ?? RECENT_SETTLED_MS
  const perRepo = opts.perRepoLimit ?? GOAL_CANDIDATES_PER_REPO
  const out: { repoId: string; sessionId: string }[] = []
  const seen = new Set<string>()

  for (const repo of repos) {
    let taken = 0
    for (const session of rowsByRepo.get(repo.id) ?? []) {
      if (taken >= perRepo) break
      if (seen.has(session.sessionId)) continue
      if (isSessionBusy(session)) continue
      if (opts.now - session.lastActivity > recentMs) continue
      seen.add(session.sessionId)
      out.push({ repoId: repo.id, sessionId: session.sessionId })
      taken++
    }
  }
  return out
}
