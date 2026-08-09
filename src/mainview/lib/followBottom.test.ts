import { describe, expect, test } from "bun:test"
import {
  ANSWER_TOP_GAP,
  BOTTOM_SLACK,
  classifyScroll,
  decideScroll,
  isAtBottom,
  reAnchor,
  resolveParkPosition,
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

describe("decideScroll", () => {
  const settled = {
    loading: false,
    catchingUp: false,
    running: false,
    wasRunning: false,
    openPending: false,
    stuck: true,
    parkedByUs: false,
    parkInFlight: false,
    pendingParkReason: null as null,
  }

  test("cold replay absorbs historical running→idle and keeps openPending", () => {
    // Replay streams a past turn's running edge…
    const mid = decideScroll({
      ...settled,
      catchingUp: true,
      running: true,
      wasRunning: false,
      openPending: true,
    })
    expect(mid.action).toEqual({ type: "follow-if-stuck" })
    expect(mid.next).toEqual({
      wasRunning: true,
      openPending: true,
      pendingParkReason: null,
      markTurnEnd: false,
    })

    // …then its idle edge. Still catch-up: must NOT look like live completion.
    const end = decideScroll({
      ...settled,
      catchingUp: true,
      running: false,
      wasRunning: true,
      openPending: true,
    })
    expect(end.action).toEqual({ type: "follow-if-stuck" })
    expect(end.next).toEqual({
      wasRunning: false,
      openPending: true,
      pendingParkReason: null,
      markTurnEnd: false,
    })
  })

  test("first settled completed open schedules an open park", () => {
    const d = decideScroll({
      ...settled,
      openPending: true,
      stuck: true,
    })
    expect(d.action).toEqual({ type: "schedule-park", reason: "open" })
    expect(d.next).toEqual({
      wasRunning: false,
      openPending: false,
      pendingParkReason: "open",
      markTurnEnd: false,
    })
  })

  test("running prior session cannot cause completion after session reset", () => {
    // Session A is mid-run…
    const onA = decideScroll({
      ...settled,
      running: true,
      wasRunning: true,
      openPending: false,
      stuck: true,
    })
    expect(onA.action).toEqual({ type: "follow-if-stuck" })
    expect(onA.next.wasRunning).toBe(true)

    // …reader switches to idle session B. ChatView's thread.id effect resets
    // wasRunning/openPending before the scroll effect runs.
    const onB = decideScroll({
      ...settled,
      running: false,
      wasRunning: false, // reset
      openPending: true, // reset
      stuck: true,
    })
    expect(onB.action).toEqual({ type: "schedule-park", reason: "open" })
    expect(onB.next.pendingParkReason).toBe("open")
    expect(onB.next.markTurnEnd).toBe(false)

    // Without the reset, the same idle B snapshot with A's wasRunning=true
    // would look like live completion — openPending also short-circuits that.
    const stale = decideScroll({
      ...settled,
      running: false,
      wasRunning: true,
      openPending: true,
      stuck: true,
    })
    expect(stale.action).toEqual({ type: "schedule-park", reason: "open" })
    expect(stale.next.markTurnEnd).toBe(false)
  })

  test("warm idle open after catch-up settles schedules the latest-answer park", () => {
    // Cache hit: catchingUp with last-seen idle projection, then settle.
    const during = decideScroll({
      ...settled,
      catchingUp: true,
      running: false,
      wasRunning: false,
      openPending: true,
      stuck: true,
    })
    expect(during.action).toEqual({ type: "follow-if-stuck" })
    expect(during.next.openPending).toBe(true)

    const settledOpen = decideScroll({
      ...settled,
      catchingUp: false,
      running: false,
      wasRunning: during.next.wasRunning,
      openPending: during.next.openPending,
      stuck: true,
    })
    expect(settledOpen.action).toEqual({ type: "schedule-park", reason: "open" })
    expect(settledOpen.next.pendingParkReason).toBe("open")
    expect(settledOpen.next.markTurnEnd).toBe(false)
  })

  test("pending park re-schedules after render churn", () => {
    const d = decideScroll({
      ...settled,
      running: false,
      wasRunning: false,
      openPending: false,
      stuck: false,
      pendingParkReason: "open",
    })
    expect(d.action).toEqual({ type: "schedule-park", reason: "open" })
    expect(d.next.pendingParkReason).toBe("open")
    expect(d.next.openPending).toBe(false)
    expect(d.next.markTurnEnd).toBe(false)

    const complete = decideScroll({
      ...settled,
      pendingParkReason: "complete",
      stuck: false,
    })
    expect(complete.action).toEqual({ type: "schedule-park", reason: "complete" })
    expect(complete.next.pendingParkReason).toBe("complete")
  })

  test("genuine live completion schedules complete park and marks turn end", () => {
    const d = decideScroll({
      ...settled,
      running: false,
      wasRunning: true,
      openPending: false,
      stuck: true,
    })
    expect(d.action).toEqual({ type: "schedule-park", reason: "complete" })
    expect(d.next).toEqual({
      wasRunning: false,
      openPending: false,
      pendingParkReason: "complete",
      markTurnEnd: true,
    })
  })

  test("deliberately scrolled-away reader is held on open and on completion", () => {
    const open = decideScroll({
      ...settled,
      openPending: true,
      stuck: false,
      parkedByUs: false,
    })
    expect(open.action).toEqual({ type: "hold" })
    expect(open.next.openPending).toBe(false)
    expect(open.next.pendingParkReason).toBeNull()

    const complete = decideScroll({
      ...settled,
      running: false,
      wasRunning: true,
      openPending: false,
      stuck: false,
      parkedByUs: false,
    })
    expect(complete.action).toEqual({ type: "hold" })
    expect(complete.next.markTurnEnd).toBe(true)
    expect(complete.next.pendingParkReason).toBeNull()
  })

  test("running open follows and clears openPending", () => {
    const d = decideScroll({
      ...settled,
      running: true,
      openPending: true,
      stuck: true,
    })
    expect(d.action).toEqual({ type: "follow-if-stuck" })
    expect(d.next).toEqual({
      wasRunning: true,
      openPending: false,
      pendingParkReason: null,
      markTurnEnd: false,
    })
  })

  test("loading follows like catch-up and preserves openPending", () => {
    const d = decideScroll({
      ...settled,
      loading: true,
      running: true,
      wasRunning: false,
      openPending: true,
    })
    expect(d.action).toEqual({ type: "follow-if-stuck" })
    expect(d.next.openPending).toBe(true)
    expect(d.next.wasRunning).toBe(true)
    expect(d.next.markTurnEnd).toBe(false)
  })

  test("a park animation in flight holds without clearing pending state", () => {
    const d = decideScroll({
      ...settled,
      parkInFlight: true,
      pendingParkReason: null,
      stuck: false,
      parkedByUs: true,
    })
    expect(d.action).toEqual({ type: "hold" })
  })

  test("live streaming while stuck follows without parking", () => {
    const d = decideScroll({
      ...settled,
      running: true,
      wasRunning: true,
      stuck: true,
    })
    expect(d.action).toEqual({ type: "follow-if-stuck" })
    expect(d.next.wasRunning).toBe(true)
    expect(d.next.pendingParkReason).toBeNull()
  })
})

describe("resolveParkPosition", () => {
  test("missing answer resolves to follow", () => {
    expect(
      resolveParkPosition({ answerOffsetTop: null, scrollHeight: 4000, clientHeight: 500 }),
    ).toEqual({ kind: "follow" })
  })

  test("short answer near the tail resolves to follow", () => {
    // Viewport shows [3500, 4000); answer starts at 3600 → target 3588, within
    // slack of the max scrollTop (3500).
    const maxTop = 4000 - 500
    const answerOffsetTop = maxTop + 100
    expect(
      resolveParkPosition({
        answerOffsetTop,
        scrollHeight: 4000,
        clientHeight: 500,
        gap: ANSWER_TOP_GAP,
      }),
    ).toEqual({ kind: "follow" })
  })

  test("long answer resolves to start park with gap", () => {
    expect(
      resolveParkPosition({
        answerOffsetTop: 1200,
        scrollHeight: 4000,
        clientHeight: 500,
        gap: ANSWER_TOP_GAP,
      }),
    ).toEqual({ kind: "park", top: 1200 - ANSWER_TOP_GAP })
  })

  test("answer at content start clamps top to zero", () => {
    expect(
      resolveParkPosition({
        answerOffsetTop: 0,
        scrollHeight: 4000,
        clientHeight: 500,
        gap: ANSWER_TOP_GAP,
      }),
    ).toEqual({ kind: "park", top: 0 })
  })

  test("answer exactly on the slack boundary follows", () => {
    const scrollHeight = 2000
    const clientHeight = 500
    const maxTop = scrollHeight - clientHeight
    // target == maxTop - BOTTOM_SLACK → still "within slack of end" → follow
    const target = maxTop - BOTTOM_SLACK
    const answerOffsetTop = target + ANSWER_TOP_GAP
    expect(
      resolveParkPosition({ answerOffsetTop, scrollHeight, clientHeight }),
    ).toEqual({ kind: "follow" })
  })
})
