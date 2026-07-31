import { describe, expect, test } from "bun:test"
import { fuzzyMatch } from "./tools"

describe("voice fuzzy resolution", () => {
  const rows = [{ title: "Fix authentication tests" }, { title: "Build voice controls" }]
  test("matches case-insensitive spoken title fragments", () => {
    expect(fuzzyMatch("AUTH TESTS", rows, (row) => row.title)).toBe(rows[0])
  })
  test("supports subsequence matching", () => {
    expect(fuzzyMatch("voice ctl", rows, (row) => row.title)).toBe(rows[1])
  })
})
