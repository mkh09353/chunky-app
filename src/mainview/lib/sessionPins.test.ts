import { describe, expect, test } from "bun:test"
import {
  isPinned,
  partitionPinned,
  pinsFromRecord,
  pinsToRecord,
  prunePins,
  setPin,
  togglePin,
} from "./sessionPins"

const rows = (...ids: string[]) => ids.map((id) => ({ id }))

describe("pinsFromRecord", () => {
  test("reads a well-formed record", () => {
    const pins = pinsFromRecord({ a: 10, b: 20 })
    expect([...pins]).toEqual([
      ["a", 10],
      ["b", 20],
    ])
  })

  test("absence is an empty map", () => {
    expect(pinsFromRecord(undefined).size).toBe(0)
    expect(pinsFromRecord(null).size).toBe(0)
  })

  test("drops non-numeric entries and empty ids, keeps the rest", () => {
    const pins = pinsFromRecord({
      good: 5,
      bad: "nope" as unknown as number,
      "": 7,
    })
    expect([...pins]).toEqual([["good", 5]])
  })

  test("a rubbish timestamp reads as 0 rather than losing the pin", () => {
    const pins = pinsFromRecord({ a: Number.NaN, b: -12, c: 3.7 })
    expect(pins.get("a")).toBe(0)
    expect(pins.get("b")).toBe(0)
    expect(pins.get("c")).toBe(3)
  })

  test("round-trips through a record", () => {
    const pins = pinsFromRecord({ a: 1, b: 2 })
    expect(pinsFromRecord(pinsToRecord(pins))).toEqual(pins)
  })
})

describe("setPin / togglePin", () => {
  test("pinning records the timestamp without mutating the input", () => {
    const before = new Map([["a", 1]])
    const after = setPin(before, "b", true, 99)
    expect(after.get("b")).toBe(99)
    expect(before.has("b")).toBe(false)
  })

  test("re-pinning keeps the original pinnedAt", () => {
    const pins = setPin(new Map([["a", 1]]), "a", true, 500)
    expect(pins.get("a")).toBe(1)
  })

  test("unpinning removes the entry", () => {
    const pins = setPin(new Map([["a", 1]]), "a", false, 500)
    expect(pins.has("a")).toBe(false)
  })

  test("an empty id is ignored", () => {
    expect(setPin(new Map(), "", true, 1).size).toBe(0)
  })

  test("toggle flips both ways", () => {
    const on = togglePin(new Map(), "a", 7)
    expect(isPinned(on, "a")).toBe(true)
    expect(isPinned(togglePin(on, "a", 8), "a")).toBe(false)
  })

  test("a rubbish clock stores 0, never NaN", () => {
    expect(setPin(new Map(), "a", true, Number.NaN).get("a")).toBe(0)
  })
})

describe("prunePins", () => {
  test("null when nothing to do", () => {
    expect(prunePins(new Map(), new Set(["a"]))).toBeNull()
    expect(prunePins(new Map([["a", 1]]), new Set(["a"]))).toBeNull()
  })

  test("drops only pins whose session is gone", () => {
    const next = prunePins(
      new Map([
        ["a", 1],
        ["gone", 2],
        ["b", 3],
      ]),
      new Set(["a", "b"]),
    )
    expect(next && [...next.keys()]).toEqual(["a", "b"])
  })
})

describe("partitionPinned", () => {
  test("no pins leaves the list alone", () => {
    const list = rows("a", "b")
    const { pinned, rest } = partitionPinned(list, new Map())
    expect(pinned).toEqual([])
    expect(rest.map((r) => r.id)).toEqual(["a", "b"])
  })

  test("pinned rows come out oldest-pin-first, rest keeps server order", () => {
    const { pinned, rest } = partitionPinned(
      rows("a", "b", "c", "d"),
      new Map([
        ["c", 10],
        ["a", 50],
      ]),
    )
    expect(pinned.map((r) => r.id)).toEqual(["c", "a"])
    expect(rest.map((r) => r.id)).toEqual(["b", "d"])
  })

  test("ties keep incoming order", () => {
    const { pinned } = partitionPinned(
      rows("a", "b", "c"),
      new Map([
        ["c", 5],
        ["a", 5],
        ["b", 5],
      ]),
    )
    expect(pinned.map((r) => r.id)).toEqual(["a", "b", "c"])
  })

  test("a pin for a row that is not in the list contributes nothing", () => {
    const { pinned, rest } = partitionPinned(rows("a"), new Map([["ghost", 1]]))
    expect(pinned).toEqual([])
    expect(rest.map((r) => r.id)).toEqual(["a"])
  })
})
