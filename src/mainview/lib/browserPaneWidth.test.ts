// Browser pane width: what the clamp allows, and what survives a round trip
// through localStorage (including a window that changed size in between).
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  clampPaneWidth,
  defaultPaneWidth,
  maxPaneWidth,
  MIN_PANE_WIDTH,
  persistPaneWidth,
  readPaneWidth,
  readPreferredPaneWidth,
} from "./browserPaneWidth"

const KEY = "chunky.browser.paneWidth"

/** Minimal localStorage stand-in — Bun's test env has no DOM. */
function installStorage(impl?: Partial<Storage>) {
  const store = new Map<string, string>()
  const storage: Storage = {
    get length() {
      return store.size
    },
    clear: () => store.clear(),
    getItem: (key: string) => store.get(key) ?? null,
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    removeItem: (key: string) => void store.delete(key),
    setItem: (key: string, value: string) => void store.set(key, value),
    ...impl,
  }
  ;(globalThis as { localStorage?: Storage }).localStorage = storage
  return storage
}

beforeEach(() => {
  installStorage()
})

afterEach(() => {
  delete (globalThis as { localStorage?: Storage }).localStorage
})

describe("clampPaneWidth", () => {
  test("a too-narrow width is lifted to the minimum", () => {
    expect(clampPaneWidth(120, 1600)).toBe(MIN_PANE_WIDTH)
    expect(clampPaneWidth(0, 1600)).toBe(MIN_PANE_WIDTH)
    expect(clampPaneWidth(-500, 1600)).toBe(MIN_PANE_WIDTH)
  })

  test("a too-wide width is capped at 70% of the window", () => {
    expect(clampPaneWidth(5000, 1600)).toBe(1120)
    expect(maxPaneWidth(1600)).toBe(1120)
  })

  test("the cap follows the window: the same width is legal wide, capped narrow", () => {
    expect(clampPaneWidth(900, 1600)).toBe(900)
    expect(clampPaneWidth(900, 1000)).toBe(700)
  })

  test("the minimum wins in a window too narrow to satisfy both bounds", () => {
    // 70% of 400 is 280, under the 320 floor — the pane stays usable.
    expect(maxPaneWidth(400)).toBe(MIN_PANE_WIDTH)
    expect(clampPaneWidth(360, 400)).toBe(MIN_PANE_WIDTH)
  })

  test("widths land on whole pixels", () => {
    expect(clampPaneWidth(640.4, 1600)).toBe(640)
    expect(clampPaneWidth(640.6, 1600)).toBe(641)
  })

  test("a nonsense width falls back to the (clamped) default", () => {
    expect(clampPaneWidth(Number.NaN, 1600)).toBe(defaultPaneWidth(1600))
  })
})

describe("readPaneWidth", () => {
  test("defaults to 44% of the window when nothing is stored", () => {
    expect(readPaneWidth(1600)).toBe(704)
    expect(defaultPaneWidth(1600)).toBe(704)
  })

  test("a stored width round-trips", () => {
    persistPaneWidth(880)
    expect(readPaneWidth(1600)).toBe(880)
  })

  test("a stored width is re-clamped against the current window", () => {
    persistPaneWidth(1200)
    // Same pane, much smaller window: 70% of 900 is 630.
    expect(readPaneWidth(900)).toBe(630)
  })

  test.each([
    ["corrupt text", "not-a-number"],
    ["empty", ""],
    ["zero", "0"],
    ["negative", "-800"],
  ])("a %s stored value falls back to the default", (_label, stored) => {
    localStorage.setItem(KEY, stored)
    expect(readPaneWidth(1600)).toBe(defaultPaneWidth(1600))
  })

  test("survives storage that throws (private/locked-down contexts)", () => {
    installStorage({
      getItem: () => {
        throw new Error("denied")
      },
      setItem: () => {
        throw new Error("denied")
      },
    })
    expect(() => persistPaneWidth(700)).not.toThrow()
    expect(readPaneWidth(1600)).toBe(defaultPaneWidth(1600))
  })

  test("the preference outlives a small window: clamped for use, intact for later", () => {
    persistPaneWidth(1200)
    // Narrow window: the pane is cut down to fit...
    expect(readPaneWidth(900)).toBe(630)
    // ...but the width the user chose is untouched, so widening restores it.
    expect(readPreferredPaneWidth(900)).toBe(1200)
    expect(readPaneWidth(2000)).toBe(1200)
  })

  test("survives no localStorage at all", () => {
    delete (globalThis as { localStorage?: Storage }).localStorage
    expect(readPaneWidth(1600)).toBe(defaultPaneWidth(1600))
    expect(() => persistPaneWidth(700)).not.toThrow()
  })
})
