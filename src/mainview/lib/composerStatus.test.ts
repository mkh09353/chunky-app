// Semantics of the composer status rule (TUI parity). Run with:
//   bun test src/mainview/lib/composerStatus.test.ts
import { describe, expect, it } from "bun:test"
import { buildComposerStatus } from "./composerStatus"

const live = { mode: "live" as const, executor: { model: "claude-fable-5[1m]", effort: "low" } }
const texts = (input: Parameters<typeof buildComposerStatus>[0]) =>
  buildComposerStatus(input).map((c) => c.text)

describe("buildComposerStatus", () => {
  it("shows a lone dim chip in demo mode", () => {
    expect(buildComposerStatus({ mode: "demo" })).toEqual([
      { key: "demo", text: "demo", tone: "dim" },
    ])
  })

  it("renders nothing while a live session is still connecting", () => {
    expect(buildComposerStatus({ mode: "live", executor: null })).toEqual([])
    expect(buildComposerStatus({ mode: "live", executor: { model: null } })).toEqual([])
  })

  it("prettifies the executor id and appends the effort", () => {
    expect(texts(live)).toEqual(["Claude Fable 5 (low)"])
    expect(texts({ mode: "live", executor: { model: "gpt-5.5" } })).toEqual(["GPT 5.5"])
  })

  it("puts INCOGNITO first, in the loud accent", () => {
    const chips = buildComposerStatus({ ...live, incognito: true })
    expect(chips[0]).toMatchObject({ key: "incognito", text: "INCOGNITO", tone: "danger" })
    expect(chips[1]).toMatchObject({ key: "executor", tone: "accent" })
  })

  it("omits the sidekick chip unless the default seat is enabled", () => {
    expect(texts({ ...live, sidekick: { default: { enabled: false }, seats: {} } })).toEqual([
      "Claude Fable 5 (low)",
    ])
  })

  it("shows the effective (inherited) sidekick model and the seat suffix", () => {
    const seat = { enabled: true, provider: "zen", model: "glm-5.2" }
    expect(texts({ ...live, sidekick: { default: { enabled: true }, seats: {} } })).toContain(
      "⚒ sidekick Claude Fable 5",
    )
    expect(
      texts({ ...live, sidekick: { default: { enabled: true }, seats: { backend: seat } } }),
    ).toContain("⚒ sidekick Claude Fable 5 +backend")
    expect(
      texts({
        ...live,
        sidekick: { default: { enabled: true, model: "gpt-5.5" }, seats: { backend: seat, ui: seat } },
      }),
    ).toContain("⚒ sidekick GPT 5.5 +2")
  })

  it("shows the advisor only when enabled with a model, marking suppression", () => {
    expect(texts({ ...live, advisor: { config: { enabled: false, model: "gpt-5.5" }, active: true } })).toEqual([
      "Claude Fable 5 (low)",
    ])
    expect(texts({ ...live, advisor: { config: { enabled: true, model: null }, active: true } })).toEqual([
      "Claude Fable 5 (low)",
    ])
    expect(texts({ ...live, advisor: { config: { enabled: true, model: "gpt-5.5" }, active: true } })).toContain(
      "✦ advisor GPT 5.5",
    )
    expect(texts({ ...live, advisor: { config: { enabled: true, model: "gpt-5.5" }, active: false } })).toContain(
      "✦ advisor GPT 5.5 ✕",
    )
  })

  it("carries turns on an active goal and dims a parked one", () => {
    const goal = { objective: "ship it", status: "active" as const, turns: 3, maxTurns: 12 }
    const chips = buildComposerStatus({ ...live, goal })
    expect(chips.at(-1)).toMatchObject({ text: "goal active 3/12", tone: "warning" })
    const paused = buildComposerStatus({ ...live, goal: { ...goal, status: "paused" as const } })
    expect(paused.at(-1)).toMatchObject({ text: "goal paused", tone: "dim" })
  })

  it("orders every chip like the TUI's bottom rule", () => {
    const chips = buildComposerStatus({
      ...live,
      incognito: true,
      sidekick: { default: { enabled: true }, seats: {} },
      advisor: { config: { enabled: true, model: "gpt-5.5" }, active: true },
      goal: { objective: "ship it", status: "active", turns: 0, maxTurns: 5 },
    })
    expect(chips.map((c) => c.key)).toEqual([
      "incognito",
      "executor",
      "sidekick",
      "advisor",
      "goal",
    ])
  })
})
