/** Auto-follow decisions for the chat transcript, as pure functions over
 *  numbers so they can be tested without a DOM.
 *
 *  The hard part of "keep the live end in view" is not the scrolling, it is
 *  deciding WHO moved the viewport. Content growing under a stationary reader
 *  changes scrollHeight but never scrollTop, and scroll events are dispatched a
 *  frame late — so an event we queued before a chunk landed arrives after it,
 *  and a naive "am I at the bottom?" measured in that handler reports a reader
 *  who never touched the wheel as having scrolled away. ChatView owns the DOM;
 *  these functions own the rules. */

/** Within this many px of the end still counts as "reading the bottom". */
export const BOTTOM_SLACK = 48

/** Breathing room above the answer when we park its first line at the top. */
export const ANSWER_TOP_GAP = 12

/** Two scroll positions within a pixel of each other are the same position:
 *  scrollTop is fractional and device-snapped, so exact equality is not safe. */
export function samePosition(a: number, b: number) {
  return Math.abs(a - b) <= 1
}

export function isAtBottom(view: {
  scrollHeight: number
  scrollTop: number
  clientHeight: number
}) {
  return view.scrollHeight - view.scrollTop - view.clientHeight <= BOTTOM_SLACK
}

/** Who moved the viewport, for one scroll event.
 *
 *  · `park-moving` / `park-settled`: the turn-end park's animation, which owns
 *    the viewport until it lands.
 *  · `ours`: our own bottom-follow reported back. Stickiness must NOT be
 *    re-measured here — the content may have grown since we asked.
 *  · `reader`: a position nobody asked us for (wheel, trackpad, keys, thumb
 *    drag, momentum). The only thing allowed to change stickiness. */
export function classifyScroll(p: {
  scrollTop: number
  /** Where our last programmatic follow landed, or null if we own nothing. */
  commandedTop: number | null
  /** Target of a park animation in flight, or null. */
  parkTarget: number | null
}): "park-moving" | "park-settled" | "ours" | "reader" {
  if (p.parkTarget != null) {
    return samePosition(p.scrollTop, p.parkTarget) ? "park-settled" : "park-moving"
  }
  if (p.commandedTop != null && samePosition(p.scrollTop, p.commandedTop)) return "ours"
  return "reader"
}

/** Should the follow be re-armed without a user message?
 *
 *  Two cases the user-message re-anchor cannot see, both of which used to leave
 *  a goal-mode / auto-continued turn streaming below the fold forever:
 *
 *  · a new turn starts while the reader is still exactly where the previous
 *    turn's park put them. That position was ours, not theirs.
 *  · a row appends while the reader is VISUALLY at the end. Sitting at the end
 *    is reading the end, whatever the flag says — which also heals any stale
 *    "off" the flag ever picks up.
 *
 *  A reader who scrolled away themselves is never in either case, so this can
 *  not yank them back. */
export function reAnchor(p: {
  stuck: boolean
  /** The last position was chosen by the turn-end park, not by the reader. */
  parkedByUs: boolean
  /** A park animation is still running; it owns the viewport. */
  parkInFlight: boolean
  /** The session went idle → running this commit. */
  justStarted: boolean
  /** A message row was added this commit. */
  appended: boolean
  /** The viewport is visually at/near the end right now. */
  atBottom: boolean
}): { stuck: boolean; parkedByUs: boolean } {
  const unchanged = { stuck: p.stuck, parkedByUs: p.parkedByUs }
  if (p.parkInFlight) return unchanged
  if (p.justStarted && p.parkedByUs) return { stuck: true, parkedByUs: false }
  if (p.appended && !p.stuck && !p.parkedByUs && p.atBottom) return { stuck: true, parkedByUs: false }
  return unchanged
}

/** Does the turn-end park apply? It re-frames an answer the reader was watching
 *  arrive (or one we ourselves parked them in). A reader who had deliberately
 *  scrolled into history keeps the viewport they chose. */
export function shouldPark(p: { wasFollowing: boolean; parkedByUs: boolean }) {
  return p.wasFollowing || p.parkedByUs
}

/** Why a start-of-answer park was requested. `open` is the one-shot framing when
 *  a settled session finishes loading; `complete` is a live running→idle edge. */
export type ParkReason = "open" | "complete"

/** What ChatView should do to the viewport after reducing stickiness for one
 *  commit. Pure so open/replay/live-complete races can be unit-tested. */
export type ScrollAction =
  /** Jump to the tail when stickiness says we still own the bottom. */
  | { type: "follow-if-stuck" }
  /** Leave the viewport alone (reader intent, or a park animation owns it). */
  | { type: "hold" }
  /** Schedule (or re-schedule) a start-of-answer park. */
  | { type: "schedule-park"; reason: ParkReason }

export type ScrollDecision = {
  action: ScrollAction
  next: {
    wasRunning: boolean
    openPending: boolean
    pendingParkReason: ParkReason | null
    /** Bump the turn-end collapse signal — live completion only. */
    markTurnEnd: boolean
  }
}

/** Decide follow / open-framing / live-completion for one ChatView commit.
 *
 *  Session-scoped flags the caller owns:
 *  · `openPending` — set true on thread id change; cleared after the first
 *    settled frame (or when the opened session is already running).
 *  · `pendingParkReason` — set when a park is requested; stays set until the
 *    DOM park lands OR the reader cancels it. A cancelled animation frame must
 *    NOT clear this — the next commit re-schedules, so churn cannot leave the
 *    viewport unfollowed above the answer.
 *
 *  Historical replay is gated by `loading` / `catchingUp`: status edges during
 *  catch-up are absorbed into `wasRunning` and never treated as live completion. */
export function decideScroll(p: {
  loading: boolean
  catchingUp: boolean
  running: boolean
  wasRunning: boolean
  openPending: boolean
  stuck: boolean
  parkedByUs: boolean
  parkInFlight: boolean
  pendingParkReason: ParkReason | null
}): ScrollDecision {
  const base = {
    wasRunning: p.running,
    openPending: p.openPending,
    pendingParkReason: p.pendingParkReason,
    markTurnEnd: false,
  }

  // A park animation already owns the viewport — don't fight it. Pending stays
  // set only until apply clears it; once glide starts, pending is null.
  if (p.parkInFlight && p.pendingParkReason == null) {
    return { action: { type: "hold" }, next: base }
  }

  // Reschedule a park that was requested but not yet applied. Message/render
  // churn cancels the prior rAF; keeping the reason is what makes park resilient.
  if (p.pendingParkReason != null) {
    return {
      action: { type: "schedule-park", reason: p.pendingParkReason },
      next: {
        wasRunning: p.running,
        openPending: false,
        pendingParkReason: p.pendingParkReason,
        markTurnEnd: false,
      },
    }
  }

  // Replay / initial load: follow the growing tail, absorb running edges so a
  // historical running→idle inside the replay cannot look like live completion.
  if (p.loading || p.catchingUp) {
    return {
      action: { type: "follow-if-stuck" },
      next: {
        wasRunning: p.running,
        openPending: p.openPending,
        pendingParkReason: null,
        markTurnEnd: false,
      },
    }
  }

  // First settled frame for this thread: frame the latest answer (or the tail
  // when the session is mid-run / the reader already walked away).
  if (p.openPending) {
    if (p.running) {
      return {
        action: { type: "follow-if-stuck" },
        next: {
          wasRunning: true,
          openPending: false,
          pendingParkReason: null,
          markTurnEnd: false,
        },
      }
    }
    if (shouldPark({ wasFollowing: p.stuck, parkedByUs: p.parkedByUs })) {
      return {
        action: { type: "schedule-park", reason: "open" },
        next: {
          wasRunning: false,
          openPending: false,
          pendingParkReason: "open",
          markTurnEnd: false,
        },
      }
    }
    return {
      action: { type: "hold" },
      next: {
        wasRunning: false,
        openPending: false,
        pendingParkReason: null,
        markTurnEnd: false,
      },
    }
  }

  // Genuine live completion: running → idle outside catch-up / open.
  const justEnded = p.wasRunning && !p.running
  if (justEnded) {
    if (shouldPark({ wasFollowing: p.stuck, parkedByUs: p.parkedByUs })) {
      return {
        action: { type: "schedule-park", reason: "complete" },
        next: {
          wasRunning: false,
          openPending: false,
          pendingParkReason: "complete",
          markTurnEnd: true,
        },
      }
    }
    return {
      action: { type: "hold" },
      next: {
        wasRunning: false,
        openPending: false,
        pendingParkReason: null,
        markTurnEnd: true,
      },
    }
  }

  return {
    action: { type: "follow-if-stuck" },
    next: {
      wasRunning: p.running,
      openPending: false,
      pendingParkReason: null,
      markTurnEnd: false,
    },
  }
}

/** Map an answer's content offset to a concrete park target.
 *
 *  · missing answer → follow the bottom (nothing to frame; keep stickiness safe)
 *  · short answer whose start is already within slack of the tail → follow
 *  · otherwise → park `gap` px above the answer's first line */
export function resolveParkPosition(p: {
  /** Answer top within the scroll content, or null when no row is mounted. */
  answerOffsetTop: number | null
  scrollHeight: number
  clientHeight: number
  gap?: number
}): { kind: "follow" } | { kind: "park"; top: number } {
  if (p.answerOffsetTop == null) return { kind: "follow" }
  const gap = p.gap ?? ANSWER_TOP_GAP
  const target = Math.max(0, p.answerOffsetTop - gap)
  if (target >= p.scrollHeight - p.clientHeight - BOTTOM_SLACK) return { kind: "follow" }
  return { kind: "park", top: target }
}
