// Pure view logic for the PR reviews widget and panel.
//
// Everything here is a function of (server state, now) — no fetching, no React,
// no clock of its own. `now` is always injected so the age badges and the
// "waiting more than a day" rule can be asserted at a fixed instant.
import type { PrReviewsState, PrSummary } from "@chunky/protocol"

/** Past this, a review has been waiting long enough to call out in amber. */
export const WAITING_LONG_MS = 24 * 60 * 60 * 1000

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** Milliseconds since an ISO timestamp, or null when it is missing/unparseable. */
export function elapsedMs(iso: string | null | undefined, now: number): number | null {
  if (!iso) return null
  const at = Date.parse(iso)
  if (Number.isNaN(at)) return null
  // A clock skewed into the future reads as "just now", never negative.
  return Math.max(0, now - at)
}

/**
 * Compact age: "3d", "5h", "12m", "now". One unit only — these sit inside a
 * badge next to the title and must not wrap.
 */
export function formatAge(iso: string | null | undefined, now: number): string {
  const ms = elapsedMs(iso, now)
  if (ms === null) return ""
  if (ms >= DAY) return `${Math.floor(ms / DAY)}d`
  if (ms >= HOUR) return `${Math.floor(ms / HOUR)}h`
  if (ms >= MINUTE) return `${Math.floor(ms / MINUTE)}m`
  return "now"
}

/** How long this PR has been waiting for review. */
export function waitingMs(pr: PrSummary, now: number): number {
  return elapsedMs(pr.createdAt, now) ?? 0
}

/** Waiting more than a day — the amber threshold. */
export function isWaitingLong(pr: PrSummary, now: number): boolean {
  return waitingMs(pr, now) > WAITING_LONG_MS
}

// ---- Sorting --------------------------------------------------------------

/** Oldest waiting first: the queue's whole point is "who has waited longest". */
export function sortReviewQueue(queue: readonly PrSummary[], now: number): PrSummary[] {
  return queue.slice().sort((a, b) => waitingMs(b, now) - waitingMs(a, now))
}

/**
 * My PRs, most-blocked first: anything with unresolved comments outranks
 * anything without, then a failing build, then most recently touched. Ties keep
 * the server's order so the list does not shuffle between polls.
 */
export function sortMine(mine: readonly PrSummary[], now: number): PrSummary[] {
  return mine
    .map((pr, index) => ({ pr, index }))
    .sort((a, b) => {
      if (a.pr.unresolvedThreads !== b.pr.unresolvedThreads) {
        return b.pr.unresolvedThreads - a.pr.unresolvedThreads
      }
      const aFailing = a.pr.ciStatus === "failing" ? 1 : 0
      const bFailing = b.pr.ciStatus === "failing" ? 1 : 0
      if (aFailing !== bFailing) return bFailing - aFailing
      const aAge = elapsedMs(a.pr.updatedAt, now)
      const bAge = elapsedMs(b.pr.updatedAt, now)
      if (aAge !== null && bAge !== null && aAge !== bAge) return aAge - bAge
      return a.index - b.index
    })
    .map((entry) => entry.pr)
}

// ---- Widget summary -------------------------------------------------------

export interface PrWidgetSummary {
  /** My open PRs. */
  open: number
  /** Unresolved review comments across all of them. */
  unresolved: number
  /** How many of mine have a failing build. */
  ciFailing: number
  /** PRs waiting for my review. */
  ready: number
  /** How many of those have been waiting more than a day. */
  waitingLong: number
}

export const EMPTY_SUMMARY: PrWidgetSummary = {
  open: 0,
  unresolved: 0,
  ciFailing: 0,
  ready: 0,
  waitingLong: 0,
}

/** The counts behind the two sidebar rows. */
export function summarize(state: PrReviewsState | null, now: number): PrWidgetSummary {
  if (!state) return EMPTY_SUMMARY
  let unresolved = 0
  let ciFailing = 0
  for (const pr of state.mine) {
    unresolved += pr.unresolvedThreads
    if (pr.ciStatus === "failing") ciFailing += 1
  }
  let waitingLong = 0
  for (const pr of state.reviewQueue) if (isWaitingLong(pr, now)) waitingLong += 1
  return {
    open: state.mine.length,
    unresolved,
    ciFailing,
    ready: state.reviewQueue.length,
    waitingLong,
  }
}

// ---- Card view model ------------------------------------------------------

export type Tone = "ok" | "bad" | "warn" | "info" | "muted"

export interface PrCard {
  pr: PrSummary
  /** "org/api-gateway" and "#1482", rendered in mono. */
  repo: string
  number: string
  ciLabel: string
  ciTone: Tone
  reviewLabel: string
  reviewTone: Tone
  /** "" when the PR carries no unresolved comments. */
  unresolvedLabel: string
  ageLabel: string
  ageTone: Tone
  /** Resolve Comments is offered only when there is something to resolve. */
  showResolve: boolean
  /** A linked session that is still working. */
  sessionRunning: boolean
  linkedSessionId: string | null
}

const CI: Record<PrSummary["ciStatus"], { label: string; tone: Tone }> = {
  passing: { label: "CI passing", tone: "ok" },
  failing: { label: "CI failing", tone: "bad" },
  pending: { label: "CI pending", tone: "warn" },
  none: { label: "no CI", tone: "muted" },
}

const REVIEW: Record<PrSummary["reviewDecision"], { label: string; tone: Tone }> = {
  approved: { label: "approved", tone: "ok" },
  changes_requested: { label: "changes requested", tone: "bad" },
  review_required: { label: "awaiting review", tone: "muted" },
  none: { label: "awaiting review", tone: "muted" },
}

/**
 * One card's presentation. `isSessionBusy` is injected rather than read from a
 * session list so the caller can apply the attached-session rule (the live
 * transcript wins over a polled summary) without this module knowing about it.
 */
export function toPrCard(
  pr: PrSummary,
  opts: { now: number; isSessionBusy?: (sessionId: string) => boolean; queue?: boolean },
): PrCard {
  const ci = CI[pr.ciStatus]
  const review = REVIEW[pr.reviewDecision]
  const linkedSessionId = pr.linkedSessionId ?? null
  const waitingLong = opts.queue === true && isWaitingLong(pr, opts.now)
  return {
    pr,
    repo: pr.repo,
    number: `#${pr.number}`,
    ciLabel: ci.label,
    ciTone: ci.tone,
    reviewLabel: pr.isDraft ? "draft" : review.label,
    reviewTone: pr.isDraft ? "muted" : review.tone,
    unresolvedLabel: pr.unresolvedThreads > 0 ? `${pr.unresolvedThreads} unresolved` : "",
    ageLabel: formatAge(opts.queue === true ? pr.createdAt : pr.updatedAt, opts.now),
    ageTone: waitingLong ? "warn" : "muted",
    showResolve: pr.unresolvedThreads > 0,
    sessionRunning: linkedSessionId ? (opts.isSessionBusy?.(linkedSessionId) ?? false) : false,
    linkedSessionId,
  }
}

/** "updated 2m ago" for the panel header. */
export function formatFetchedAt(fetchedAt: number | null, now: number): string {
  if (fetchedAt === null) return "not fetched yet"
  const ms = Math.max(0, now - fetchedAt)
  if (ms < MINUTE) return "updated just now"
  if (ms < HOUR) return `updated ${Math.floor(ms / MINUTE)}m ago`
  if (ms < DAY) return `updated ${Math.floor(ms / HOUR)}h ago`
  return `updated ${Math.floor(ms / DAY)}d ago`
}

// ---- Unread activity ------------------------------------------------------

/** New server data has landed since the reader last opened the panel. */
export function hasNewActivity(fetchedAt: number | null, lastSeen: number | null): boolean {
  if (fetchedAt === null) return false
  if (lastSeen === null) return false
  return fetchedAt > lastSeen
}

const LAST_SEEN_KEY = "chunky.prReviews.lastSeen"

/** Minimal storage surface, injected so the accessors are testable. */
export interface LastSeenStore {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

function browserStore(): LastSeenStore | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage
  } catch {
    return null
  }
}

/**
 * When the reader last looked at the panel. Disposable renderer preference —
 * losing it only costs one spurious dot, so localStorage is the right home.
 */
export function loadPrLastSeen(store: LastSeenStore | null = browserStore()): number | null {
  if (!store) return null
  try {
    const raw = store.getItem(LAST_SEEN_KEY)
    if (!raw) return null
    const value = Number.parseInt(raw, 10)
    return Number.isFinite(value) ? value : null
  } catch {
    return null
  }
}

export function savePrLastSeen(value: number, store: LastSeenStore | null = browserStore()): void {
  if (!store) return
  try {
    store.setItem(LAST_SEEN_KEY, String(value))
  } catch {
    /* private mode / quota — the dot is not worth an exception */
  }
}
