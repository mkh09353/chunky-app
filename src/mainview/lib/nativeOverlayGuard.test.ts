// The overlay lock is what tells BrowserPane to step its native webview aside
// while a DOM overlay is up, so its bookkeeping has to survive the awkward
// cases: nested overlays, a cleanup that runs twice, StrictMode's mount →
// cleanup → mount replay, and an "intersect" lock whose element has gone away.
//
// There is no DOM in this runner, so `useOverlayLock`/`OverlayLock` are
// exercised through the acquire/release pair they wrap, replaying React's
// effect ordering by hand, and elements are stubbed to the two members the
// module actually reads (`isConnected`, `getBoundingClientRect`).
// Run with: bun test src/mainview/lib
import { beforeEach, describe, expect, test } from "bun:test"
import {
  __resetOverlayLockForTests,
  acquireOverlayLock,
  isOverlayLocked,
  lockedOverlaysCoverRect,
  overlayLockCount,
  subscribeOverlayLock,
} from "./nativeOverlayGuard"
import type { ViewportRect } from "./browserOverlay"

/** The browser pane: a tall column down the right-hand side. */
const PANE: ViewportRect = { left: 800, top: 52, right: 1200, bottom: 800, width: 400, height: 748 }

function rect(left: number, top: number, width: number, height: number): ViewportRect {
  return { left, top, right: left + width, bottom: top + height, width, height }
}

/** Minimal stand-in for a mounted overlay element. */
function fakeElement(box: ViewportRect, connected = true): Element {
  return {
    isConnected: connected,
    getBoundingClientRect: () => box,
  } as unknown as Element
}

beforeEach(() => {
  __resetOverlayLockForTests()
})

describe("native overlay lock", () => {
  test("counts nested overlays and only unlocks with the last one", () => {
    expect(isOverlayLocked()).toBe(false)

    const dialog = acquireOverlayLock()
    const menuInsideDialog = acquireOverlayLock({ mode: "intersect" })
    expect(overlayLockCount()).toBe(2)
    expect(isOverlayLocked()).toBe(true)

    menuInsideDialog()
    // The dialog is still up: the pane must stay out of the way.
    expect(isOverlayLocked()).toBe(true)

    dialog()
    expect(overlayLockCount()).toBe(0)
    expect(isOverlayLocked()).toBe(false)
  })

  test("release is idempotent and never drops someone else's lock", () => {
    const first = acquireOverlayLock()
    const second = acquireOverlayLock()

    first()
    first()
    first()
    expect(overlayLockCount()).toBe(1)
    expect(isOverlayLocked()).toBe(true)

    second()
    expect(overlayLockCount()).toBe(0)
    // A stray extra release must not corrupt the registry, which would make the
    // next acquire a no-op and leave the pane composited over a dialog.
    second()
    expect(overlayLockCount()).toBe(0)
  })

  test("two locks with identical options stay independent", () => {
    const element = fakeElement(rect(900, 100, 200, 200))
    const first = acquireOverlayLock({ mode: "intersect", element: () => element })
    const second = acquireOverlayLock({ mode: "intersect", element: () => element })

    first()
    expect(overlayLockCount()).toBe(1)
    expect(lockedOverlaysCoverRect(PANE)).toBe(true)

    second()
    expect(lockedOverlaysCoverRect(PANE)).toBe(false)
  })

  test("notifies subscribers on every change, and stops after unsubscribe", () => {
    const seen: boolean[] = []
    const unsubscribe = subscribeOverlayLock((locked) => seen.push(locked))

    const first = acquireOverlayLock()
    const second = acquireOverlayLock()
    // A second overlay changes WHICH rects are covered even though the count was
    // already non-zero, so the watcher has to hear about it.
    expect(seen).toEqual([true, true])

    second()
    expect(seen).toEqual([true, true, true])

    first()
    expect(seen).toEqual([true, true, true, false])

    unsubscribe()
    acquireOverlayLock()
    expect(seen).toEqual([true, true, true, false])
  })

  test("subscribers are notified synchronously, before any poll could run", () => {
    const seen: (boolean | null)[] = [null]
    subscribeOverlayLock((next) => {
      seen[0] = next
    })

    const release = acquireOverlayLock()
    expect(seen[0]).toBe(true)

    release()
    expect(seen[0]).toBe(false)
  })

  test("survives StrictMode's mount → cleanup → mount replay", () => {
    // React 19 in development runs an effect, tears it down, then runs it
    // again. Each acquire is released by its own teardown, so the count must
    // land back on exactly one live lock.
    const firstMount = acquireOverlayLock()
    firstMount()
    const secondMount = acquireOverlayLock()

    expect(overlayLockCount()).toBe(1)
    expect(isOverlayLocked()).toBe(true)

    secondMount()
    expect(overlayLockCount()).toBe(0)
    expect(isOverlayLocked()).toBe(false)
  })
})

describe("lockedOverlaysCoverRect", () => {
  test("nothing held covers nothing", () => {
    expect(lockedOverlaysCoverRect(PANE)).toBe(false)
  })

  test('"always" covers the pane with no overlap and without measuring', () => {
    let measured = false
    acquireOverlayLock({
      mode: "always",
      element: () => {
        measured = true
        return fakeElement(rect(0, 0, 10, 10))
      },
    })

    expect(lockedOverlaysCoverRect(PANE)).toBe(true)
    // The short-circuit is the point: a modal answer must not depend on layout.
    expect(measured).toBe(false)
  })

  test('"intersect" only covers while the popup actually overlaps', () => {
    // A sidebar dropdown on the far left: the pane must keep painting.
    const sidebarMenu = rect(16, 120, 220, 300)
    const release = acquireOverlayLock({
      mode: "intersect",
      element: () => fakeElement(sidebarMenu),
    })
    expect(lockedOverlaysCoverRect(PANE)).toBe(false)
    release()

    // The Add repository popover dragged over the pane.
    acquireOverlayLock({ mode: "intersect", element: () => fakeElement(rect(700, 60, 352, 400)) })
    expect(lockedOverlaysCoverRect(PANE)).toBe(true)
  })

  test('"intersect" follows an element that moves between evaluations', () => {
    // The popover is draggable, so the same lock answers differently over time;
    // the resolver is called per evaluation rather than captured once.
    let box = rect(16, 120, 220, 300)
    acquireOverlayLock({ mode: "intersect", element: () => fakeElement(box) })

    expect(lockedOverlaysCoverRect(PANE)).toBe(false)
    box = rect(760, 120, 220, 300)
    expect(lockedOverlaysCoverRect(PANE)).toBe(true)
  })

  test("a missing, detached, zero-size, or throwing element covers nothing", () => {
    const cases: (() => Element | null | undefined)[] = [
      () => null,
      () => undefined,
      () => fakeElement(rect(900, 100, 200, 200), false), // detached
      () => fakeElement(rect(900, 100, 0, 0)), // mid-animation / collapsed
      () => {
        throw new Error("ref read during teardown")
      },
      () => ({}) as unknown as Element, // no getBoundingClientRect
    ]

    for (const element of cases) {
      __resetOverlayLockForTests()
      acquireOverlayLock({ mode: "intersect", element })
      expect(isOverlayLocked()).toBe(true)
      expect(lockedOverlaysCoverRect(PANE)).toBe(false)
    }
  })

  test('an "intersect" lock with no element resolver covers nothing', () => {
    acquireOverlayLock({ mode: "intersect" })
    expect(lockedOverlaysCoverRect(PANE)).toBe(false)
  })

  test("one covering lock is enough, whatever the others say", () => {
    acquireOverlayLock({ mode: "intersect", element: () => fakeElement(rect(0, 0, 100, 100)) })
    acquireOverlayLock({ mode: "intersect", element: () => null })
    acquireOverlayLock({ mode: "intersect", element: () => fakeElement(rect(900, 300, 120, 120)) })

    expect(lockedOverlaysCoverRect(PANE)).toBe(true)
  })

  test("a collapsed pane is never considered covered", () => {
    acquireOverlayLock({ mode: "intersect", element: () => fakeElement(rect(0, 0, 2000, 2000)) })
    expect(lockedOverlaysCoverRect(rect(800, 52, 0, 0))).toBe(false)
  })
})
