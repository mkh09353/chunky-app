// Active-mode derivation: a mode's identity is its effective configuration.
//   bun test src/mainview/lib/modes.test.ts
import { describe, expect, it } from "bun:test"
import type { ModeInfo, ModeSpec } from "@chunky/protocol"
import { activeModeName, DEFAULT_MODE_EMOJI, modeEmoji, sessionModeName } from "./modes"

const fire: ModeInfo = {
  name: "fire",
  provider: "zen",
  model: "claude-fable-5",
  effort: "low",
  advisor: { provider: "codex", model: "gpt-5.6" },
}
const ice: ModeInfo = { name: "ice", provider: "grok", model: "grok-4.5" }

const current: ModeSpec = {
  provider: "zen",
  model: "claude-fable-5",
  effort: "low",
  advisor: { provider: "codex", model: "gpt-5.6" },
  sidekick: null,
  review: null,
}

describe("activeModeName", () => {
  it("names the saved mode whose spec is the live pairing", () => {
    expect(activeModeName([ice, fire], current)).toBe("fire")
  })

  it("is null when nothing matches, or there is nothing to match against", () => {
    expect(activeModeName([ice], current)).toBeNull()
    expect(activeModeName([fire], { ...current, effort: "high" })).toBeNull()
    expect(activeModeName([fire], { ...current, model: "gpt-5.6" })).toBeNull()
    expect(activeModeName([], current)).toBeNull()
    expect(activeModeName([fire], null)).toBeNull()
    expect(activeModeName([fire], { provider: "zen", model: "" })).toBeNull()
  })

  it("ignores fields a mode leaves undeclared, and matches case-insensitively", () => {
    const loose: ModeInfo = { name: "loose", provider: "ZEN", model: "Claude-Fable-5" }
    expect(activeModeName([loose], current)).toBe("loose")
    // …but a declared advisor that disagrees still disqualifies it.
    expect(
      activeModeName([{ ...loose, advisor: null }], current),
    ).toBeNull()
  })

  it("prefers the most specific match when a laxer mode also fits", () => {
    const loose: ModeInfo = { name: "loose", provider: "zen", model: "claude-fable-5" }
    expect(activeModeName([loose, fire], current)).toBe("fire")
    expect(activeModeName([fire, loose], current)).toBe("fire")
  })

  it("treats an explicitly-off slot as off, not as unconstrained", () => {
    const noAdvisor: ModeInfo = { ...fire, name: "solo", advisor: null }
    expect(activeModeName([noAdvisor], current)).toBeNull()
    expect(activeModeName([noAdvisor], { ...current, advisor: null })).toBe("solo")
  })

  it("does not call a mode active when a declared agent effort or seat differs", () => {
    expect(
      activeModeName([{ ...fire, advisor: { ...fire.advisor!, effort: "high" } }], current),
    ).toBeNull()
    expect(
      activeModeName(
        [{ ...fire, sidekickSeats: { frontend: { provider: "zen", model: "opus", effort: "high" } } }],
        { ...current, sidekickSeats: { frontend: { provider: "zen", model: "opus", effort: "low" } } },
      ),
    ).toBeNull()
  })
})

describe("sessionModeName", () => {
  it("uses the derived global mode for an inheriting new session", () => {
    expect(sessionModeName("global", null, "fire")).toBe("fire")
  })

  it("keeps session-pinned identity authoritative", () => {
    expect(sessionModeName("session-mode", "ice", "fire")).toBe("ice")
    expect(sessionModeName("session-selection", null, "fire")).toBeNull()
  })
})

describe("modeEmoji", () => {
  it("gives the obvious names their emoji", () => {
    expect(modeEmoji("fire")).toBe("🔥")
    expect(modeEmoji("ice")).toBe("❄️")
    expect(modeEmoji("frost")).toBe("❄️")
    expect(modeEmoji("rocket")).toBe("🚀")
    expect(modeEmoji("turbo")).toBe("⚡")
    expect(modeEmoji("zen")).toBe("🧘")
    expect(modeEmoji("beast")).toBe("🦾")
    expect(modeEmoji("cheap")).toBe("💸")
    expect(modeEmoji("deep")).toBe("🧠")
    expect(modeEmoji("night")).toBe("🌙")
    expect(modeEmoji("ghost")).toBe("👻")
    expect(modeEmoji("magic")).toBe("🪄")
    expect(modeEmoji("star")).toBe("⭐")
    expect(modeEmoji("bolt")).toBe("⚡")
    expect(modeEmoji("ocean")).toBe("🌊")
    expect(modeEmoji("sun")).toBe("☀️")
  })

  it("matches case-insensitively, inside longer names", () => {
    expect(modeEmoji("FIRE")).toBe("🔥")
    expect(modeEmoji("Fire-Drill")).toBe("🔥")
    expect(modeEmoji("  night-owl  ")).toBe("🌙")
    expect(modeEmoji("incognito-zen")).toBe("👻")
  })

  it("prefers the longest matching keyword", () => {
    // "star" and "ship" both hit; the longer keyword decides… and here they
    // tie at 4, so table order (rocket before star) breaks it.
    expect(modeEmoji("starship")).toBe("🚀")
    // "rocket" (6) beats "star" (4).
    expect(modeEmoji("star-rocket")).toBe("🚀")
  })

  it("falls back to a neutral glyph so every mode has one", () => {
    expect(modeEmoji("quarterly-review")).toBe(DEFAULT_MODE_EMOJI)
    expect(modeEmoji("")).toBe(DEFAULT_MODE_EMOJI)
    expect(DEFAULT_MODE_EMOJI).toBe("✨")
  })
})
