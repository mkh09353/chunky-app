import { describe, expect, test } from "bun:test"
import type { ModeInfo } from "@chunky/protocol"
import { agentLabel, modeSlots, seatNameOf, specWithSlot } from "./modeSlots"

/** A mode as the server actually sends it: extra fields the protocol's ModeSpec
 *  doesn't declare (incognito) ride along and must survive an edit. */
const mode = {
  name: "Fire",
  provider: "anthropic",
  model: "claude-fable",
  effort: "low",
  speed: "fast",
  advisor: { provider: "codex", model: "gpt-5.6-sol" },
  sidekick: { provider: "codex", model: "gpt-5.6-terra", effort: "high" },
  sidekickSeats: { frontend: { provider: "anthropic", model: "claude-opus" } },
  incognito: { allow: ["anthropic"] },
} as unknown as ModeInfo

describe("specWithSlot", () => {
  test("drops the name and keeps undeclared fields (incognito)", () => {
    const next = specWithSlot(mode, "advisor", { provider: "grok", model: "grok-4.5" })
    expect("name" in next).toBe(false)
    expect((next as unknown as Record<string, unknown>).incognito).toEqual({ allow: ["anthropic"] })
    expect(next.advisor).toEqual({ provider: "grok", model: "grok-4.5" })
  })

  test("leaves every untouched slot exactly as it was", () => {
    const next = specWithSlot(mode, "advisor", null)
    expect(next.advisor).toBeNull()
    expect(next.provider).toBe("anthropic")
    expect(next.model).toBe("claude-fable")
    expect(next.speed).toBe("fast")
    expect(next.sidekick).toEqual(mode.sidekick)
    expect(next.sidekickSeats).toEqual(mode.sidekickSeats)
  })

  test("undefined removes the key (back to leave-alone), null writes off/inherit", () => {
    const withReview = specWithSlot(mode, "review", { provider: "codex", model: "gpt-5.6-luna" })
    expect(withReview.review).toEqual({ provider: "codex", model: "gpt-5.6-luna" })
    const inherit = specWithSlot(withReview as ModeInfo, "review", undefined)
    expect("review" in inherit).toBe(false)
    const off = specWithSlot(mode, "review", null)
    expect(off.review).toBeNull()
  })

  test("an absent slot stays absent when a different slot is edited", () => {
    // `review` was never set on this mode.
    const next = specWithSlot(mode, "sidekick", null)
    expect("review" in next).toBe(false)
    expect(next.sidekick).toBeNull()
  })

  test("executor writes the spec root and clears effort when none is chosen", () => {
    const next = specWithSlot(mode, "executor", { provider: "codex", model: "gpt-5.6-sol", effort: "xhigh" })
    expect(next.provider).toBe("codex")
    expect(next.model).toBe("gpt-5.6-sol")
    expect(next.effort).toBe("xhigh")
    expect(next.speed).toBe("fast")
    const noEffort = specWithSlot(mode, "executor", { provider: "codex", model: "gpt-5.6-sol" })
    expect("effort" in noEffort).toBe(false)
  })

  test("executor can't be cleared", () => {
    expect(specWithSlot(mode, "executor", null).model).toBe("claude-fable")
  })

  test("a named seat is replaced without disturbing its siblings", () => {
    const two = { ...mode, sidekickSeats: { ...mode.sidekickSeats, backend: { provider: "grok", model: "grok-4.5" } } } as ModeInfo
    const next = specWithSlot(two, "seat:frontend", { provider: "codex", model: "gpt-5.6-luna", effort: "high" })
    expect(next.sidekickSeats).toEqual({
      frontend: { provider: "codex", model: "gpt-5.6-luna", effort: "high" },
      backend: { provider: "grok", model: "grok-4.5" },
    })
  })

  test("does not mutate the original mode", () => {
    specWithSlot(mode, "seat:frontend", { provider: "grok", model: "grok-4.5" })
    expect(mode.sidekickSeats?.frontend?.provider).toBe("anthropic")
  })
})

describe("modeSlots", () => {
  test("lists the trio then named seats, sorted", () => {
    const many = { ...mode, sidekickSeats: { zebra: { provider: "grok", model: "g" }, alpha: { provider: "grok", model: "g" } } } as ModeInfo
    expect(modeSlots(many).map((s) => s.id)).toEqual([
      "executor",
      "advisor",
      "review",
      "sidekick",
      "seat:alpha",
      "seat:zebra",
    ])
  })

  test("empty labels distinguish absent from explicitly null", () => {
    const bare = { name: "b", provider: "codex", model: "m" } as ModeInfo
    const byId = Object.fromEntries(modeSlots(bare).map((s) => [s.id, s.emptyLabel]))
    expect(byId.review).toBe("inherits the global reviewer")
    expect(byId.sidekick).toBe("not set (seat left alone)")

    const nulled = { name: "n", provider: "codex", model: "m", review: null, sidekick: null, advisor: null } as ModeInfo
    const nulledById = Object.fromEntries(modeSlots(nulled).map((s) => [s.id, s.emptyLabel]))
    expect(nulledById.review).toBe("off")
    expect(nulledById.sidekick).toBe("inherits the executor")
    expect(nulledById.advisor).toBe("off")
  })

  test("the executor slot mirrors the spec root", () => {
    const [executor] = modeSlots(mode)
    expect(executor?.value).toEqual({ provider: "anthropic", model: "claude-fable", effort: "low" })
  })
})

test("seatNameOf", () => {
  expect(seatNameOf("seat:frontend")).toBe("frontend")
  expect(seatNameOf("advisor")).toBeNull()
})

test("agentLabel", () => {
  expect(agentLabel({ provider: "codex", model: "gpt-5.6-sol", effort: "high" })).toBe("GPT 5.6 Sol (high)")
  expect(agentLabel({ provider: "codex", model: "gpt-5.6-sol" })).toBe("GPT 5.6 Sol")
})
