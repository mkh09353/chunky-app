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

  it("never gives the sidekick a chip of its own — it hangs off the executor", () => {
    const seat = { enabled: true, provider: "zen", model: "glm-5.2" }
    expect(texts({ ...live, sidekick: { default: { enabled: false }, seats: {} } })).toEqual([
      "Claude Fable 5 (low)",
    ])
    expect(
      texts({ ...live, sidekick: { default: { enabled: true }, seats: { backend: seat } } }),
    ).toEqual(["Claude Fable 5 (low)"])
  })

  it("omits details entirely when nothing is configured behind the executor", () => {
    expect(buildComposerStatus(live)[0]!.details).toBeUndefined()
    expect(
      buildComposerStatus({ ...live, sidekick: { default: { enabled: false }, seats: {} } })[0]!
        .details,
    ).toBeUndefined()
  })

  it("carries every seat and its effective model as executor details", () => {
    const chips = buildComposerStatus({
      ...live,
      sidekick: {
        default: { enabled: true },
        seats: { frontend: { enabled: true, model: "grok-4.5" }, websearch: { enabled: true } },
      },
    })
    expect(chips.find((c) => c.key === "sidekick")).toBeUndefined()
    expect(chips.find((c) => c.key === "executor")?.details).toEqual([
      { name: "executor", model: "Claude Fable 5" },
      { name: "sidekick (default)", model: "Claude Fable 5" },
      { name: "sidekick (frontend)", model: "Grok 4.5" },
      // Unset seat inherits the default seat, which inherits the executor.
      { name: "sidekick (websearch)", model: "Claude Fable 5" },
    ])
  })

  it("names the lone default seat plainly when there are no named seats", () => {
    const chips = buildComposerStatus({
      ...live,
      sidekick: { default: { enabled: true, model: "gpt-5.5" }, seats: {} },
    })
    expect(chips.find((c) => c.key === "executor")?.details).toEqual([
      { name: "executor", model: "Claude Fable 5" },
      { name: "sidekick", model: "GPT 5.5" },
    ])
  })

  it("lists the advisor only when enabled with a model, marking suppression", () => {
    const details = (input: Parameters<typeof buildComposerStatus>[0]) =>
      buildComposerStatus(input).find((c) => c.key === "advisor" || c.key === "executor")?.details
    expect(
      details({ ...live, advisor: { config: { enabled: false, model: "gpt-5.5" }, active: true } }),
    ).toBeUndefined()
    expect(
      details({ ...live, advisor: { config: { enabled: true, model: null }, active: true } }),
    ).toBeUndefined()
    expect(
      details({ ...live, advisor: { config: { enabled: true, model: "gpt-5.5" }, active: true } }),
    ).toEqual([
      { name: "executor", model: "Claude Fable 5" },
      { name: "advisor", model: "GPT 5.5" },
    ])
    expect(
      details({ ...live, advisor: { config: { enabled: true, model: "gpt-5.5" }, active: false } }),
    ).toEqual([
      { name: "executor", model: "Claude Fable 5" },
      { name: "advisor", model: "GPT 5.5 (unavailable)" },
    ])
    // The advisor never earns a row of its own in the rule.
    expect(
      texts({ ...live, advisor: { config: { enabled: true, model: "gpt-5.5" }, active: true } }),
    ).toEqual(["Claude Fable 5 (low)"])
  })

  it("carries turns on an active goal and dims a parked one", () => {
    const goal = { objective: "ship it", status: "active" as const, turns: 3, maxTurns: 12 }
    const chips = buildComposerStatus({ ...live, goal })
    expect(chips.at(-1)).toMatchObject({ text: "goal active 3/12", tone: "warning" })
    const paused = buildComposerStatus({ ...live, goal: { ...goal, status: "paused" as const } })
    expect(paused.at(-1)).toMatchObject({ text: "goal paused", tone: "dim" })
  })

  it("keeps the rule to the three chips that must not be missed", () => {
    const chips = buildComposerStatus({
      ...live,
      incognito: true,
      sidekick: { default: { enabled: true }, seats: { backend: { enabled: true } } },
      advisor: { config: { enabled: true, model: "gpt-5.5" }, active: true },
      goal: { objective: "ship it", status: "active", turns: 0, maxTurns: 5 },
    })
    expect(chips.map((c) => c.key)).toEqual(["incognito", "executor", "goal"])
    // Everything dropped from the row is still reachable behind the executor.
    expect(chips[1]!.details?.map((d) => d.name)).toEqual([
      "executor",
      "sidekick (default)",
      "sidekick (backend)",
      "advisor",
    ])
  })

  describe("solo", () => {
    const configured = {
      sidekick: {
        default: { enabled: true, model: "gpt-5.5" },
        seats: { backend: { enabled: true, model: "grok-4.5" } },
      },
      advisor: { config: { enabled: true, model: "gpt-5.5" }, active: true },
    }

    it("drops the sidekick, its seats and the normal advisor — the server suppresses them", () => {
      const chips = buildComposerStatus({ ...live, ...configured, solo: true })
      expect(chips.map((c) => c.key)).toEqual(["executor"])
      expect(chips[0]!.details?.map((d) => d.name)).toEqual(["executor", "delegates"])
      expect(chips[0]!.details?.at(-1)?.model).toBe("none — solo")
    })

    it("keeps the opt-in solo advisor, and only that one", () => {
      const chips = buildComposerStatus({
        ...live,
        ...configured,
        solo: true,
        soloAdvisor: { config: { enabled: true, model: "grok-4.5" }, active: true },
      })
      expect(chips[0]!.details).toEqual([
        { name: "executor", model: "Claude Fable 5" },
        { name: "solo advisor", model: "Grok 4.5" },
        { name: "delegates", model: "none — solo" },
      ])
    })

    it("ignores a solo advisor that is off, and marks one it can't resolve", () => {
      const off = buildComposerStatus({
        ...live,
        solo: true,
        soloAdvisor: { config: { enabled: false, model: "grok-4.5" }, active: false },
      })
      expect(off[0]!.details?.map((d) => d.name)).toEqual(["executor", "delegates"])
      const stale = buildComposerStatus({
        ...live,
        solo: true,
        soloAdvisor: { config: { enabled: true, model: "grok-4.5" }, active: false },
      })
      expect(stale[0]!.details?.[1]).toEqual({
        name: "solo advisor",
        model: "Grok 4.5 (unavailable)",
      })
    })

    it("still spells solo out on hover and leaves the rule itself compact", () => {
      const chips = buildComposerStatus({ ...live, ...configured, solo: true })
      expect(texts({ ...live, ...configured, solo: true })).toEqual(["Claude Fable 5 (low)"])
      expect(chips[0]!.title).toContain("Solo")
      expect(chips[0]!.title).toContain("effort low")
    })

    it("leaves the non-solo rule untouched", () => {
      const chips = buildComposerStatus({ ...live, ...configured, solo: false })
      expect(chips[0]!.details?.map((d) => d.name)).toEqual([
        "executor",
        "sidekick (default)",
        "sidekick (backend)",
        "advisor",
      ])
    })
  })
})
