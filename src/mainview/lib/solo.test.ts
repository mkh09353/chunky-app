// Solo derivation: which scope is running its model alone. Run with:
//   bun test src/mainview/lib/solo.test.ts
import { describe, expect, it } from "bun:test"
import { SOLO_EXPLAINER, isSoloActive, soloAdvisorRuns, soloLines } from "./solo"
import type { ModelSelection } from "./api"

const sel = (over: Partial<ModelSelection> = {}): ModelSelection => ({
  provider: "zen",
  model: "glm-5.2",
  ...over,
})

describe("isSoloActive", () => {
  it("is false in demo/offline, whatever the server last said", () => {
    expect(
      isSoloActive({ live: false, sessionId: "s1", modelSel: sel({ solo: true }), currentSolo: true }),
    ).toBe(false)
  })

  it("reads the global selection when the session has no pin", () => {
    expect(isSoloActive({ live: true, sessionId: "s1", modelSel: sel({ solo: true }) })).toBe(true)
    expect(isSoloActive({ live: true, sessionId: "s1", modelSel: sel({ solo: false }) })).toBe(false)
    expect(isSoloActive({ live: true, sessionId: null, modelSel: sel({ solo: true }) })).toBe(true)
  })

  it("lets a session's PIN decide for that session only", () => {
    const input = {
      live: true,
      modelSel: sel({ solo: false }),
      sessionModelSel: {
        s1: sel({ model: "gpt-5.5", solo: true }),
        s2: sel({ model: "gpt-5.5", solo: false }),
      },
    }
    expect(isSoloActive({ ...input, sessionId: "s1" })).toBe(true)
    expect(isSoloActive({ ...input, sessionId: "s2" })).toBe(false)
    // An unpinned session still follows the global state.
    expect(isSoloActive({ ...input, sessionId: "s3" })).toBe(false)
  })

  it("a pinned session stays out of solo even when the global default is in it", () => {
    expect(
      isSoloActive({
        live: true,
        sessionId: "s1",
        modelSel: sel({ solo: true }),
        sessionModelSel: { s1: sel({ solo: false }) },
      }),
    ).toBe(false)
  })

  it("falls back to /api/modes current.solo only when the selection is silent", () => {
    expect(isSoloActive({ live: true, sessionId: null, modelSel: sel(), currentSolo: true })).toBe(
      true,
    )
    // An explicit `solo: false` on the selection wins over a stale modes read.
    expect(
      isSoloActive({ live: true, sessionId: null, modelSel: sel({ solo: false }), currentSolo: true }),
    ).toBe(false)
    expect(isSoloActive({ live: true, sessionId: null, modelSel: null })).toBe(false)
  })
})

describe("soloAdvisorRuns", () => {
  it("needs both the opt-in and a model", () => {
    expect(soloAdvisorRuns({ enabled: true, model: "gpt-5.5" })).toBe(true)
    expect(soloAdvisorRuns({ enabled: true, model: null })).toBe(false)
    expect(soloAdvisorRuns({ enabled: false, model: "gpt-5.5" })).toBe(false)
    expect(soloAdvisorRuns(null)).toBe(false)
  })
})

describe("soloLines", () => {
  it("always ends by saying no delegates run", () => {
    expect(soloLines("Claude Fable 5", null)).toEqual([
      { name: "executor", model: "Claude Fable 5" },
      { name: "delegates", model: "none — solo" },
    ])
  })

  it("includes the solo advisor when it is opted in", () => {
    expect(soloLines("Claude Fable 5", { enabled: true, model: "gpt-5.5" })).toEqual([
      { name: "executor", model: "Claude Fable 5" },
      { name: "solo advisor", model: "GPT 5.5" },
      { name: "delegates", model: "none — solo" },
    ])
  })

  it("marks a configured but unresolvable solo advisor", () => {
    const lines = soloLines("Claude Fable 5", { enabled: true, model: "gpt-5.5" }, false)
    expect(lines[1]).toEqual({ name: "solo advisor", model: "GPT 5.5 (unavailable)" })
  })

  it("keeps one explainer for every surface", () => {
    expect(SOLO_EXPLAINER).toContain("solo advisor")
  })
})
