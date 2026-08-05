import { describe, expect, test } from "bun:test"
import {
  BOTTOM_SLACK,
  classifyScroll,
  isAtBottom,
  reAnchor,
  samePosition,
  shouldPark,
} from "./followBottom"

const view = (scrollHeight: number, scrollTop: number, clientHeight = 500) => ({
  scrollHeight,
  scrollTop,
  clientHeight,
})

describe("isAtBottom", () => {
  test("the exact end counts", () => {
    expect(isAtBottom(view(1500, 1000))).toBe(true)
  })

  test("inside the slack band counts", () => {
    expect(isAtBottom(view(1500, 1000 - BOTTOM_SLACK))).toBe(true)
  })

  test("past the band does not", () => {
    expect(isAtBottom(view(1500, 1000 - BOTTOM_SLACK - 1))).toBe(false)
  })

  test("a shrinking viewport pushes the reader out of the band", () => {
    // Composer/todos/queue growing by 100px keeps scrollTop but not the view.
    expect(isAtBottom(view(1500, 1000, 500))).toBe(true)
    expect(isAtBottom(view(1500, 1000, 400))).toBe(false)
  })
})

describe("classifyScroll", () => {
  test("our own follow, reported back a frame later", () => {
    expect(classifyScroll({ scrollTop: 1000, commandedTop: 1000, parkTarget: null })).toBe("ours")
  })

  test("content that grew after we asked is still OUR scroll, not the reader's", () => {
    // The regression this whole module exists for: scrollHeight jumped from
    // 1500 to 1900 between our scrollTo and this event. scrollTop is untouched,
    // so the event is ours and stickiness must survive it.
    const verdict = classifyScroll({ scrollTop: 1000, commandedTop: 1000, parkTarget: null })
    expect(verdict).toBe("ours")
    expect(isAtBottom(view(1900, 1000))).toBe(false) // what a naive check would have seen
  })

  test("device-snapped fractions still count as our position", () => {
    expect(classifyScroll({ scrollTop: 999.5, commandedTop: 1000, parkTarget: null })).toBe("ours")
  })

  test("a position we never asked for is the reader", () => {
    expect(classifyScroll({ scrollTop: 400, commandedTop: 1000, parkTarget: null })).toBe("reader")
  })

  test("with nothing commanded, every scroll is the reader's", () => {
    expect(classifyScroll({ scrollTop: 1000, commandedTop: null, parkTarget: null })).toBe("reader")
  })

  test("a park animation owns the viewport until it lands", () => {
    expect(classifyScroll({ scrollTop: 800, commandedTop: 1000, parkTarget: 600 })).toBe(
      "park-moving",
    )
    expect(classifyScroll({ scrollTop: 600, commandedTop: 1000, parkTarget: 600 })).toBe(
      "park-settled",
    )
  })
})

describe("reAnchor", () => {
  const base = {
    stuck: false,
    parkedByUs: false,
    parkInFlight: false,
    justStarted: false,
    appended: false,
    atBottom: false,
  }

  test("an auto-continued turn re-follows from a position WE parked", () => {
    expect(reAnchor({ ...base, parkedByUs: true, justStarted: true })).toEqual({
      stuck: true,
      parkedByUs: false,
    })
  })

  test("a new turn does not yank a reader who scrolled into history", () => {
    expect(reAnchor({ ...base, justStarted: true })).toEqual({ stuck: false, parkedByUs: false })
  })

  test("an append while visually at the end heals a stale off-flag", () => {
    expect(reAnchor({ ...base, appended: true, atBottom: true })).toEqual({
      stuck: true,
      parkedByUs: false,
    })
  })

  test("an append while scrolled up changes nothing", () => {
    expect(reAnchor({ ...base, appended: true, atBottom: false })).toEqual({
      stuck: false,
      parkedByUs: false,
    })
  })

  test("an append does not cancel a park the reader is still reading", () => {
    expect(reAnchor({ ...base, parkedByUs: true, appended: true, atBottom: true })).toEqual({
      stuck: false,
      parkedByUs: true,
    })
  })

  test("a park in flight is never overridden", () => {
    expect(
      reAnchor({ ...base, parkInFlight: true, parkedByUs: true, justStarted: true }),
    ).toEqual({ stuck: false, parkedByUs: true })
  })

  test("already following stays following", () => {
    expect(reAnchor({ ...base, stuck: true, appended: true, atBottom: true })).toEqual({
      stuck: true,
      parkedByUs: false,
    })
  })
})

describe("shouldPark", () => {
  test("parks the answer for a reader who was watching it arrive", () => {
    expect(shouldPark({ wasFollowing: true, parkedByUs: false })).toBe(true)
  })

  test("parks again for a reader we had already parked", () => {
    expect(shouldPark({ wasFollowing: false, parkedByUs: true })).toBe(true)
  })

  test("leaves a deliberately scrolled-up reader alone", () => {
    expect(shouldPark({ wasFollowing: false, parkedByUs: false })).toBe(false)
  })
})

test("samePosition tolerates a pixel, not more", () => {
  expect(samePosition(100, 101)).toBe(true)
  expect(samePosition(100, 102)).toBe(false)
})
