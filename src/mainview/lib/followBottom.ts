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
