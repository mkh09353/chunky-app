import { describe, expect, test } from "bun:test"
import { followUpFor, followUpNotice } from "./queueActions"

describe("followUpFor", () => {
  test("a promoted entry needs no follow-up", () => {
    expect(followUpFor("promoted")).toBe("none")
  })

  test("an already-running entry must NOT be re-sent (that would duplicate the turn)", () => {
    // The server reports "already-running" only when the drainer claimed the
    // entry, i.e. the prompt is executing. Re-sending would run it twice.
    expect(followUpFor("already-running")).toBe("already-running")
  })

  test("a not-found entry MUST be re-sent or the text is lost", () => {
    expect(followUpFor("not-found")).toBe("resend")
  })

  test("every outcome is handled (no silent default)", () => {
    const outcomes = ["promoted", "already-running", "not-found"] as const
    for (const outcome of outcomes) expect(followUpFor(outcome)).toBeTruthy()
  })
})

describe("followUpNotice", () => {
  test("explains the one outcome the user would otherwise find confusing", () => {
    expect(followUpNotice("already-running")).toContain("already started")
  })

  test("stays quiet when the message went out", () => {
    expect(followUpNotice("none")).toBeNull()
    expect(followUpNotice("resend")).toBeNull()
  })
})
