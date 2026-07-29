import { describe, expect, test } from "bun:test"
import { isFullSizeWindow, type WindowMetrics } from "./windowSize"

function metrics(m: Partial<WindowMetrics>): WindowMetrics {
  return {
    innerWidth: 0,
    innerHeight: 0,
    outerWidth: 0,
    outerHeight: 0,
    availWidth: 1710,
    availHeight: 1008,
    fullscreen: false,
    ...m,
  }
}

describe("isFullSizeWindow — Electrobun / WKWebView", () => {
  // These numbers are MEASURED from a native WKWebView harness on a 1710x1107
  // display, not assumed: WebKit reports outer* as 0x0 inside a native window,
  // and a maximized window's content is 32px shorter than availHeight.
  test("maximized native window (outer* is 0x0, height short by the title bar)", () => {
    expect(
      isFullSizeWindow(
        metrics({ innerWidth: 1710, innerHeight: 976, outerWidth: 0, outerHeight: 0 }),
      ),
    ).toBe(true)
  })

  test("a 1100x700 window is not full size", () => {
    expect(
      isFullSizeWindow(
        metrics({ innerWidth: 1100, innerHeight: 700, outerWidth: 0, outerHeight: 0 }),
      ),
    ).toBe(false)
  })

  test("full width but half height is not full size", () => {
    expect(isFullSizeWindow(metrics({ innerWidth: 1710, innerHeight: 560 }))).toBe(false)
  })

  test("full height but a narrow window is not full size", () => {
    expect(isFullSizeWindow(metrics({ innerWidth: 1000, innerHeight: 1008 }))).toBe(false)
  })

  test("native fullscreen covers the menu bar — bigger than avail still counts", () => {
    expect(isFullSizeWindow(metrics({ innerWidth: 1710, innerHeight: 1107 }))).toBe(true)
  })

  test("native fullscreen on a SMALL display counts too (no size floor applied)", () => {
    expect(
      isFullSizeWindow(
        metrics({ innerWidth: 1280, innerHeight: 800, availWidth: 1280, availHeight: 750 }),
      ),
    ).toBe(true)
  })
})

describe("isFullSizeWindow — browser", () => {
  test("maximized Chrome: outer matches avail, inner is short by the chrome", () => {
    expect(
      isFullSizeWindow(
        metrics({ innerWidth: 1710, innerHeight: 880, outerWidth: 1710, outerHeight: 1008 }),
      ),
    ).toBe(true)
  })

  test("a restored browser window is not full size", () => {
    expect(
      isFullSizeWindow(
        metrics({ innerWidth: 1200, innerHeight: 700, outerWidth: 1200, outerHeight: 800 }),
      ),
    ).toBe(false)
  })

  test("the Fullscreen API short-circuits everything", () => {
    expect(
      isFullSizeWindow(
        metrics({ innerWidth: 800, innerHeight: 600, outerWidth: 800, outerHeight: 600, fullscreen: true }),
      ),
    ).toBe(true)
  })

  test("a few pixels of slack still counts as maximized", () => {
    expect(
      isFullSizeWindow(metrics({ innerWidth: 1704, innerHeight: 1002, outerWidth: 1704, outerHeight: 1002 })),
    ).toBe(true)
  })

  test("48px of missing height is the limit; well past it is not full size", () => {
    expect(isFullSizeWindow(metrics({ innerWidth: 1710, innerHeight: 900 }))).toBe(false)
  })
})

describe("isFullSizeWindow — unusable screen metrics", () => {
  test("without screen.avail*, a generously large window is treated as full size", () => {
    expect(
      isFullSizeWindow(
        metrics({ innerWidth: 1600, innerHeight: 900, availWidth: 0, availHeight: 0 }),
      ),
    ).toBe(true)
  })

  test("without screen.avail*, a small window still is not", () => {
    expect(
      isFullSizeWindow(
        metrics({ innerWidth: 1200, innerHeight: 700, availWidth: 0, availHeight: 0 }),
      ),
    ).toBe(false)
  })

  test("a zeroed-out environment (SSR-ish) is not full size", () => {
    expect(
      isFullSizeWindow(metrics({ availWidth: 0, availHeight: 0 })),
    ).toBe(false)
  })
})
