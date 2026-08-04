// Shelf lifecycle: inbox vs history, independent of the presentation status.
// Run with: bun test src/mainview/lib/sessionShelf.test.ts
import { describe, expect, test } from "bun:test"
import {
  AUTO_SETTLE_AFTER_MS,
  classifyShelf,
  hasActivitySince,
  reconcileShelfPins,
  shelfPinsFromRecord,
  shelfPinsToRecord,
  type Shelf,
  type ShelfInput,
  type ShelfPin,
} from "./sessionShelf"

const NOW = 1_700_000_000_000

/** A neutral, freshly-active thread; each case overrides only what it is about. */
function input(extra: Partial<ShelfInput> = {}): ShelfInput {
  return {
    busy: false,
    unread: false,
    attached: false,
    lastActivity: NOW,
    pin: undefined,
    now: NOW,
    ...extra,
  }
}

const idle = (ms: number) => ({ lastActivity: NOW - ms })

describe("classifyShelf", () => {
  const cases: Array<{ name: string; input: Partial<ShelfInput>; expected: Shelf }> = [
    // --- work in flight ----------------------------------------------------
    { name: "a busy thread is active", input: { busy: true }, expected: "active" },
    {
      name: "busy outranks a settled pin — the pin is ignored, not honoured",
      input: { busy: true, pin: { shelf: "settled", at: NOW } },
      expected: "active",
    },
    {
      name: "busy outranks the age rule, however long the row has been quiet",
      input: { busy: true, ...idle(AUTO_SETTLE_AFTER_MS * 10) },
      expected: "active",
    },

    // --- completion is NOT settlement -------------------------------------
    {
      name: "a fresh unread completion stays in the working list",
      input: { unread: true },
      expected: "active",
    },
    {
      name: "an unread completion stays active even once it is ancient",
      input: { unread: true, ...idle(AUTO_SETTLE_AFTER_MS * 2) },
      expected: "active",
    },

    // --- attached / selected ----------------------------------------------
    {
      name: "an attached thread is active however long it has been quiet",
      input: { attached: true, ...idle(AUTO_SETTLE_AFTER_MS * 2) },
      expected: "active",
    },
    {
      name: "attached does NOT rescue an explicitly settled thread being read",
      input: { attached: true, pin: { shelf: "settled", at: NOW } },
      expected: "settled",
    },
    {
      name: "busy outranks an attached row's settled pin too",
      input: { busy: true, attached: true, pin: { shelf: "settled", at: NOW } },
      expected: "active",
    },

    // --- explicit pins -----------------------------------------------------
    {
      name: "an explicit settle settles a thread that would otherwise be active",
      input: { pin: { shelf: "settled", at: NOW } },
      expected: "settled",
    },
    {
      name: "an explicit settle outranks an unread completion",
      input: { unread: true, pin: { shelf: "settled", at: NOW } },
      expected: "settled",
    },
    {
      name: "an explicit active pin prevents auto-settling",
      input: { pin: { shelf: "active", at: NOW }, ...idle(AUTO_SETTLE_AFTER_MS * 5) },
      expected: "active",
    },

    // --- the age rule, at the boundary ------------------------------------
    {
      name: "one millisecond before the boundary is still active",
      input: idle(AUTO_SETTLE_AFTER_MS - 1),
      expected: "active",
    },
    {
      name: "exactly at the boundary settles",
      input: idle(AUTO_SETTLE_AFTER_MS),
      expected: "settled",
    },
    {
      name: "past the boundary settles",
      input: idle(AUTO_SETTLE_AFTER_MS + 1),
      expected: "settled",
    },
    {
      name: "a thread quiet for two days is not history yet",
      input: idle(2 * 24 * 60 * 60 * 1000),
      expected: "active",
    },
    {
      name: "a clock skewed into the future never settles",
      input: { lastActivity: NOW + 60_000 },
      expected: "active",
    },
  ]

  for (const item of cases) {
    test(item.name, () => {
      expect(classifyShelf(input(item.input))).toBe(item.expected)
    })
  }

  test("the boundary is three days", () => {
    expect(AUTO_SETTLE_AFTER_MS).toBe(3 * 24 * 60 * 60 * 1000)
  })
})

describe("hasActivitySince", () => {
  type ShelfActivityRow = {
    sessionId: string
    lastActivity: number
    busy?: boolean
    running?: boolean
  }
  const pin: ShelfPin = { shelf: "settled", at: NOW }

  const cases: Array<{ name: string; row: Partial<ShelfActivityRow>; expected: boolean }> = [
    { name: "no change is not activity", row: {}, expected: false },
    { name: "older activity is not activity", row: { lastActivity: NOW - 1 }, expected: false },
    { name: "newer activity is activity", row: { lastActivity: NOW + 1 }, expected: true },
    { name: "a running root run is activity", row: { running: true }, expected: true },
    { name: "a busy delegate is activity", row: { busy: true }, expected: true },
    {
      name: "busy counts even when lastActivity has not moved yet",
      row: { busy: true, lastActivity: NOW - 5_000 },
      expected: true,
    },
  ]

  for (const item of cases) {
    test(item.name, () => {
      expect(hasActivitySince(pin, { sessionId: "s1", lastActivity: NOW, ...item.row })).toBe(
        item.expected,
      )
    })
  }
})

describe("reconcileShelfPins", () => {
  test("an empty pin set is left alone", () => {
    expect(reconcileShelfPins(new Map(), [{ sessionId: "s1", lastActivity: NOW }])).toBeNull()
  })

  test("no activity means no commit", () => {
    const pins = new Map<string, ShelfPin>([["s1", { shelf: "settled", at: NOW }]])
    expect(reconcileShelfPins(pins, [{ sessionId: "s1", lastActivity: NOW }])).toBeNull()
  })

  test("real activity retires a settled pin", () => {
    const pins = new Map<string, ShelfPin>([["s1", { shelf: "settled", at: NOW }]])
    const next = reconcileShelfPins(pins, [{ sessionId: "s1", lastActivity: NOW + 1 }])
    expect(next?.has("s1")).toBe(false)
    // The input map is never mutated.
    expect(pins.has("s1")).toBe(true)
  })

  test("real activity retires an active pin too", () => {
    const pins = new Map<string, ShelfPin>([["s1", { shelf: "active", at: NOW }]])
    const next = reconcileShelfPins(pins, [{ sessionId: "s1", lastActivity: NOW, busy: true }])
    expect(next?.has("s1")).toBe(false)
  })

  test("a session missing from this repo's batch keeps its pin", () => {
    // `rows` is one repository's list; another repo's session appears in no
    // batch at all and must not be retired by absence.
    const pins = new Map<string, ShelfPin>([
      ["s1", { shelf: "settled", at: NOW }],
      ["other-repo", { shelf: "settled", at: NOW }],
    ])
    const next = reconcileShelfPins(pins, [{ sessionId: "s1", lastActivity: NOW + 1 }])
    expect(next?.has("s1")).toBe(false)
    expect(next?.get("other-repo")).toEqual({ shelf: "settled", at: NOW })
  })

  test("several pins retire in one pass", () => {
    const pins = new Map<string, ShelfPin>([
      ["s1", { shelf: "settled", at: NOW }],
      ["s2", { shelf: "active", at: NOW }],
      ["s3", { shelf: "settled", at: NOW }],
    ])
    const next = reconcileShelfPins(pins, [
      { sessionId: "s1", lastActivity: NOW + 10 },
      { sessionId: "s2", lastActivity: NOW, running: true },
      { sessionId: "s3", lastActivity: NOW },
    ])
    expect([...(next?.keys() ?? [])]).toEqual(["s3"])
  })

  test("a retired settled pin hands the thread back to the age rule", () => {
    // The end-to-end promise: activity on a settled thread brings it back.
    const pins = new Map<string, ShelfPin>([["s1", { shelf: "settled", at: NOW - 10_000 }]])
    const row = { sessionId: "s1", lastActivity: NOW }
    expect(classifyShelf(input({ pin: pins.get("s1") }))).toBe("settled")
    const next = reconcileShelfPins(pins, [row])
    expect(classifyShelf(input({ pin: next?.get("s1"), lastActivity: row.lastActivity }))).toBe(
      "active",
    )
  })
})

describe("persistence round trip", () => {
  test("pins survive a write/read cycle", () => {
    const pins = new Map<string, ShelfPin>([
      ["s1", { shelf: "settled", at: NOW }],
      ["s2", { shelf: "active", at: 0 }],
    ])
    expect(shelfPinsFromRecord(shelfPinsToRecord(pins))).toEqual(pins)
  })

  test("a hand-edited or malformed record is cleaned rather than trusted", () => {
    const parsed = shelfPinsFromRecord({
      good: { shelf: "settled", at: NOW },
      bogusShelf: { shelf: "archived" as Shelf, at: NOW },
      bogusAt: { shelf: "active", at: Number.NaN },
      negativeAt: { shelf: "active", at: -5 },
      fractionalAt: { shelf: "settled", at: 12.9 },
      "": { shelf: "settled", at: NOW },
      nulled: null as unknown as ShelfPin,
    })
    expect(parsed.get("good")).toEqual({ shelf: "settled", at: NOW })
    expect(parsed.has("bogusShelf")).toBe(false)
    expect(parsed.get("bogusAt")).toEqual({ shelf: "active", at: 0 })
    expect(parsed.get("negativeAt")).toEqual({ shelf: "active", at: 0 })
    expect(parsed.get("fractionalAt")).toEqual({ shelf: "settled", at: 12 })
    expect(parsed.has("")).toBe(false)
    expect(parsed.has("nulled")).toBe(false)
  })

  test("absence reads as no pins", () => {
    expect(shelfPinsFromRecord(undefined).size).toBe(0)
    expect(shelfPinsFromRecord(null).size).toBe(0)
  })
})
