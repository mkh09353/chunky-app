// The "load earlier messages" rules: one page per approach to the top, and a
// viewport that does not move when a page lands above the reader.
import { describe, expect, test } from "bun:test"
import { anchorScrollTop, isPrepend, NEAR_TOP_PX, olderTrigger } from "./olderHistory"

describe("olderTrigger", () => {
  test("scrolling past the threshold arms; reaching the top then fetches once", () => {
    let armed = false
    // Opening at the top does NOT fetch: the reader has not reached for it.
    let step = olderTrigger({ scrollTop: 0, hasMore: true, loading: false, armed })
    expect(step).toEqual({ fetch: false, armed: false })

    step = olderTrigger({ scrollTop: 900, hasMore: true, loading: false, armed })
    expect(step.armed).toBe(true)
    armed = step.armed

    step = olderTrigger({ scrollTop: 120, hasMore: true, loading: false, armed })
    expect(step.fetch).toBe(true)
    armed = step.armed
    expect(armed).toBe(false)
  })

  test("a short prepended page at the top cannot loop", () => {
    // Every sample after the fetch is still near the top; none of them re-fire.
    let armed = false
    armed = olderTrigger({ scrollTop: 800, hasMore: true, loading: false, armed }).armed
    expect(olderTrigger({ scrollTop: 10, hasMore: true, loading: false, armed }).fetch).toBe(true)
    armed = false
    for (const scrollTop of [0, 40, 150, NEAR_TOP_PX]) {
      const step = olderTrigger({ scrollTop, hasMore: true, loading: false, armed })
      expect(step.fetch).toBe(false)
      armed = step.armed
    }
    // Only scrolling away and back gives the next page.
    armed = olderTrigger({ scrollTop: NEAR_TOP_PX + 1, hasMore: true, loading: false, armed }).armed
    expect(olderTrigger({ scrollTop: 0, hasMore: true, loading: false, armed }).fetch).toBe(true)
  })

  test("never fetches while a page is in flight or when there is nothing older", () => {
    expect(olderTrigger({ scrollTop: 0, hasMore: true, loading: true, armed: true })).toEqual({
      fetch: false,
      armed: true,
    })
    expect(olderTrigger({ scrollTop: 0, hasMore: false, loading: false, armed: true })).toEqual({
      fetch: false,
      armed: true,
    })
    // The arming survives both, so the page still arrives once it can.
    expect(olderTrigger({ scrollTop: 0, hasMore: true, loading: false, armed: true }).fetch).toBe(true)
  })

  test("the threshold is inclusive and overridable", () => {
    expect(olderTrigger({ scrollTop: NEAR_TOP_PX, hasMore: true, loading: false, armed: true }).fetch).toBe(true)
    expect(olderTrigger({ scrollTop: NEAR_TOP_PX + 1, hasMore: true, loading: false, armed: true }).fetch).toBe(false)
    expect(olderTrigger({ scrollTop: 60, hasMore: true, loading: false, armed: true, threshold: 50 }).fetch).toBe(false)
  })
})

describe("anchorScrollTop", () => {
  test("keeps the reader's line by absorbing the inserted height", () => {
    // 400px of history prepended: the same content must stay under the eye.
    expect(
      anchorScrollTop({ previousScrollHeight: 1000, previousScrollTop: 120, nextScrollHeight: 1400 }),
    ).toBe(520)
    // Distance from the END of the content is unchanged — that is the invariant.
    expect(1400 - 520).toBe(1000 - 120)
  })

  test("a prepend at the very top pushes the viewport down by the full page", () => {
    expect(
      anchorScrollTop({ previousScrollHeight: 800, previousScrollTop: 0, nextScrollHeight: 2000 }),
    ).toBe(1200)
  })

  test("no growth (or a shrink) leaves the viewport exactly where it was", () => {
    expect(
      anchorScrollTop({ previousScrollHeight: 1000, previousScrollTop: 300, nextScrollHeight: 1000 }),
    ).toBe(300)
    expect(
      anchorScrollTop({ previousScrollHeight: 1000, previousScrollTop: 300, nextScrollHeight: 900 }),
    ).toBe(300)
  })
})

describe("isPrepend", () => {
  test("a new first row with a bigger list is a prepend", () => {
    expect(isPrepend({ previousFirstId: "m5", previousCount: 3, nextFirstId: "m1", nextCount: 8 })).toBe(true)
  })

  test("appends, streaming growth and the first paint are not prepends", () => {
    expect(isPrepend({ previousFirstId: "m1", previousCount: 3, nextFirstId: "m1", nextCount: 4 })).toBe(false)
    expect(isPrepend({ previousFirstId: "m1", previousCount: 3, nextFirstId: "m1", nextCount: 3 })).toBe(false)
    expect(isPrepend({ previousFirstId: undefined, previousCount: 0, nextFirstId: "m1", nextCount: 10 })).toBe(false)
    // A session switch that SHRINKS the list is not a prepend either.
    expect(isPrepend({ previousFirstId: "m1", previousCount: 9, nextFirstId: "z1", nextCount: 4 })).toBe(false)
  })
})
