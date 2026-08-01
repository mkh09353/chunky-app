import { describe, expect, test } from "bun:test"
import { digestThread, fuzzyMatch } from "./tools"
import { initialState, reduce } from "../transcript"

describe("voice fuzzy resolution", () => {
  const rows = [{ title: "Fix authentication tests" }, { title: "Build voice controls" }]
  test("matches case-insensitive spoken title fragments", () => {
    expect(fuzzyMatch("AUTH TESTS", rows, (row) => row.title)).toBe(rows[0])
  })
  test("supports subsequence matching", () => {
    expect(fuzzyMatch("voice ctl", rows, (row) => row.title)).toBe(rows[1])
  })
})

describe("voice thread digest", () => {
  test("uses the shared transcript reducer and summarizes tools without output", () => {
    const state = [
      { type: "message.user" as const, text: "Run the tests" },
      { type: "message.start" as const, role: "assistant" as const },
      { type: "message.delta" as const, text: "Tests passed." },
      { type: "tool.start" as const, id: "tool-1", name: "bash", input: { command: "bun test" } },
      { type: "tool.end" as const, id: "tool-1", ok: true, output: "very noisy output" },
      { type: "message.end" as const },
    ].reduce(reduce, initialState)
    expect(digestThread("Tests", "idle", state)).toEqual({
      title: "Tests",
      status: "idle",
      messages: [
        { role: "user", text: "Run the tests" },
        { role: "assistant", text: "Tests passed.\n(assistant ran 1 tool)" },
      ],
    })
  })

  test("bounds long content with a truncation marker", () => {
    const state = reduce(initialState, { type: "message.user", text: "x".repeat(700) })
    expect(digestThread("Long", "idle", state).messages[0]?.text).toEndWith("…truncated")
  })
})
