/** "Load earlier messages" rules, as pure functions over numbers so they can be
 *  tested without a DOM (same shape as ~/lib/followBottom).
 *
 *  A session is seeded with only its last few user turns, so the top of the
 *  scrollport is a boundary rather than the start of the conversation. Two
 *  things have to be right there, and neither is obvious:
 *
 *  · WHEN to fetch. Fetching on "the reader is near the top" alone loops: a
 *    short page prepended into a tall viewport leaves the reader still near the
 *    top, which fires again immediately, and again, until the history runs out.
 *    So the trigger is ARMED by scrolling away from the top and spent by
 *    firing — one page per approach, exactly as a person would expect.
 *  · WHERE the viewport ends up. Prepending rows grows the content ABOVE the
 *    reader, so the same scrollTop now shows different text: the page appears
 *    to jump. Restoring the offset from the end of the content instead keeps
 *    the line they were reading under their eyes. */

/** Within this many px of the top counts as "reaching for older history". */
export const NEAR_TOP_PX = 200

export interface OlderTriggerInput {
  /** Current scroll offset of the scrollport. */
  scrollTop: number
  /** The session still has older turns on the server. */
  hasMore: boolean
  /** A page is already in flight. */
  loading: boolean
  /** Has the reader been away from the top since the last fetch? */
  armed: boolean
  threshold?: number
}

/**
 * One scroll sample → whether to fetch a page, and the next armed state.
 *
 * Arming is deliberately one-directional: only scrolling PAST the threshold
 * arms, and only a fetch disarms. That makes the "at most one page per
 * approach" rule hold even when the prepended page is shorter than the
 * viewport, and when the transcript is too short to scroll at all (the reader
 * never gets above the threshold, so the button is the only way to page — which
 * is the correct behaviour, not a bug).
 */
export function olderTrigger(p: OlderTriggerInput): { fetch: boolean; armed: boolean } {
  const threshold = p.threshold ?? NEAR_TOP_PX
  if (p.scrollTop > threshold) return { fetch: false, armed: true }
  if (!p.armed || !p.hasMore || p.loading) return { fetch: false, armed: p.armed }
  return { fetch: true, armed: false }
}

/**
 * Where the scrollport must land after a page is prepended, so the reader's
 * line does not move.
 *
 * Measured from the END of the content (`scrollHeight - scrollTop`), which is
 * invariant under growth ABOVE the viewport — the delta between the two heights
 * is exactly how much was inserted, whether that is one row or fifty, and
 * whether or not the rows have finished laying out at their final heights.
 */
export function anchorScrollTop(p: {
  previousScrollHeight: number
  previousScrollTop: number
  nextScrollHeight: number
}): number {
  const grew = p.nextScrollHeight - p.previousScrollHeight
  if (grew <= 0) return p.previousScrollTop
  return Math.max(0, p.previousScrollTop + grew)
}

/** Is this commit a PREPEND rather than an ordinary append?
 *
 *  Only the front of the list is compared: an appended row leaves the first id
 *  alone, a prepended page replaces it. Told apart because a prepend must not
 *  be mistaken for a new user turn (which re-anchors the viewport to the live
 *  end and would throw the reader out of the history they just asked for). */
export function isPrepend(p: {
  previousFirstId: string | undefined
  previousCount: number
  nextFirstId: string | undefined
  nextCount: number
}): boolean {
  if (p.previousCount === 0 || p.nextCount <= p.previousCount) return false
  return p.previousFirstId !== p.nextFirstId
}
