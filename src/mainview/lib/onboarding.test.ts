import { expect, test } from "bun:test"
import { prettyModel, prettyModelName, providerLabel } from "./api"
import { normalizeOnboarding, type OnboardingResponse } from "./configApi"
import {
  fireNudgeCopy,
  fireNudgeMode,
  onboardingProviderLabel,
  seatRoleLabel,
  connectTitle,
  fireProgressLine,
  fireSummary,
  hasRecommendation,
  isModeLocked,
  isRecommendedReady,
  lockedOn,
  otherSuggestions,
  providerNames,
  recommendedMissing,
  recommendedMode,
  recommendedProviders,
  splitProviders,
} from "./onboarding"

const FIRE_SPEC = {
  provider: "anthropic",
  model: "claude-fable-5-1[1m]",
  effort: "high",
  sidekick: { provider: "codex", model: "gpt-5.6-sol", effort: "medium" },
  advisor: { provider: "codex", model: "gpt-5.6-sol", effort: "high" },
  sidekickSeats: {
    frontend: { provider: "anthropic", model: "opus[1m]", effort: "medium" },
    websearch: { provider: "codex", model: "gpt-5.6-luna", effort: "high", speed: "fast" },
  },
}

const serverPayload = (missing: string[]) => ({
  onboardedAt: null,
  providers: [
    { id: "anthropic", label: "Anthropic", status: "ready" },
    { id: "codex", label: "Codex", status: "missing" },
    { id: "zen", label: "Zen", status: "missing" },
  ],
  recommended: { name: "fire", requires: ["anthropic", "codex"], missing },
  suggestedModes: [
    {
      name: "fire",
      description: "The full pairing.",
      spec: FIRE_SPEC,
      ...(missing.length > 0 ? { locked: true, missingProviders: missing } : {}),
    },
    { name: "balanced", description: "Everyday.", spec: { provider: "anthropic", model: "claude-sonnet-4-6" } },
  ],
})

// ---- normalizer -----------------------------------------------------------

test("the normalizer carries the recommendation and lock fields", () => {
  const res = normalizeOnboarding(serverPayload(["codex"]))
  expect(res.recommended).toEqual({ name: "fire", requires: ["anthropic", "codex"], missing: ["codex"] })
  expect(res.suggestedModes[0]?.locked).toBe(true)
  expect(res.suggestedModes[0]?.missingProviders).toEqual(["codex"])
  expect(res.suggestedModes[1]?.locked).toBe(false)
  expect(res.suggestedModes[1]?.missingProviders).toBeUndefined()
})

test("an older server (no recommendation, no locks) normalizes to today's shape", () => {
  const res = normalizeOnboarding({
    onboardedAt: null,
    providers: [{ id: "anthropic", status: "ready" }],
    suggestedModes: [{ name: "balanced", spec: { provider: "anthropic", model: "x" } }],
  })
  expect(res.recommended).toBe(null)
  expect(res.suggestedModes[0]).toEqual({
    name: "balanced",
    description: "",
    spec: { provider: "anthropic", model: "x" },
    locked: false,
  })
  expect(hasRecommendation(res)).toBe(false)
})

test("garbage recommendation fields never throw and never invent a mode", () => {
  for (const rec of [null, 42, "fire", {}, { name: "" }, { name: 3 }, []]) {
    const res = normalizeOnboarding({ providers: [], suggestedModes: [], recommended: rec })
    expect(res.recommended).toBe(null)
  }
  const partial = normalizeOnboarding({ recommended: { name: "fire" } })
  expect(partial.recommended).toEqual({ name: "fire", requires: [], missing: [] })
})

// ---- derivations ----------------------------------------------------------

test("recommendedProviders / missing / readiness follow the server", () => {
  const locked = normalizeOnboarding(serverPayload(["codex"]))
  expect(recommendedProviders(locked)).toEqual(["anthropic", "codex"])
  expect(recommendedMissing(locked)).toEqual(["codex"])
  expect(isRecommendedReady(locked)).toBe(false)

  const ready = normalizeOnboarding(serverPayload([]))
  expect(isRecommendedReady(ready)).toBe(true)
  expect(recommendedMissing(ready)).toEqual([])
})

test("null/older responses degrade instead of crashing", () => {
  for (const res of [null, undefined, normalizeOnboarding({})] as (OnboardingResponse | null | undefined)[]) {
    expect(recommendedProviders(res)).toEqual([])
    expect(recommendedMode(res)).toBe(null)
    expect(isRecommendedReady(res)).toBe(false)
    expect(fireProgressLine(res)).toBe(null)
    expect(connectTitle(res)).toBe("Connect a provider")
    expect(otherSuggestions(res)).toEqual([])
  }
})

test("a locked mode is never treated as applicable", () => {
  const locked = normalizeOnboarding(serverPayload(["codex"]))
  const mode = recommendedMode(locked)!
  expect(mode.name).toBe("fire")
  expect(isModeLocked(mode, locked)).toBe(true)
  expect(lockedOn(mode, locked)).toEqual(["codex"])

  // Server forgot `locked` but still reports a missing provider: still locked.
  const sloppy = normalizeOnboarding({
    ...serverPayload(["codex"]),
    suggestedModes: [{ name: "fire", spec: FIRE_SPEC }],
  })
  expect(isModeLocked(recommendedMode(sloppy), sloppy)).toBe(true)

  const ready = normalizeOnboarding(serverPayload([]))
  expect(isModeLocked(recommendedMode(ready), ready)).toBe(false)
  expect(isModeLocked(null)).toBe(true)
})

test("alternatives exclude the recommendation and anything locked", () => {
  const res = normalizeOnboarding(serverPayload(["codex"]))
  expect(otherSuggestions(res).map((m) => m.name)).toEqual(["balanced"])
})

test("hero providers follow requires order; the rest fall through", () => {
  const res = normalizeOnboarding(serverPayload(["codex"]))
  const { hero, rest } = splitProviders(res.providers, ["codex", "anthropic"])
  expect(hero.map((p) => p.id)).toEqual(["codex", "anthropic"])
  expect(rest.map((p) => p.id)).toEqual(["zen"])
  // Unknown required ids are dropped rather than faked.
  expect(splitProviders(res.providers, ["nope"]).hero).toEqual([])
  // No recommendation → every provider is "rest" (today's flat grid).
  expect(splitProviders(res.providers, []).rest.length).toBe(3)
})

test("provider names read as English, in onboarding's product spelling", () => {
  expect(providerNames([])).toBe("")
  expect(providerNames(["codex"])).toBe("Codex")
  expect(providerNames(["anthropic", "codex"])).toBe("Claude and Codex")
  expect(providerNames(["anthropic", "codex", "grok"])).toBe("Claude, Codex and Grok")
  expect(connectTitle(normalizeOnboarding(serverPayload([])))).toBe("Connect Claude and Codex")
})

test("the alias is onboarding-only and never breaks providerLabel", () => {
  expect(onboardingProviderLabel("anthropic")).toBe("Claude")
  expect(onboardingProviderLabel("ANTHROPIC")).toBe("Claude")
  // Everything else keeps its app-wide label, unknown ids included.
  expect(onboardingProviderLabel("codex")).toBe("Codex")
  expect(onboardingProviderLabel("zen")).toBe("Zen")
  expect(onboardingProviderLabel("together")).toBe("Together")
  expect(onboardingProviderLabel(null)).toBe("Provider")
  // The app-wide identity is untouched.
  expect(providerLabel("anthropic")).toBe("Anthropic")
})

test("the progress line names what's missing and flips when fire is ready", () => {
  expect(fireProgressLine(normalizeOnboarding(serverPayload(["anthropic", "codex"])))).toBe(
    "🔥 fire unlocks when both are connected",
  )
  expect(fireProgressLine(normalizeOnboarding(serverPayload(["anthropic"])))).toBe(
    "🔥 fire unlocks when you connect Claude",
  )
  expect(fireProgressLine(normalizeOnboarding(serverPayload(["codex"])))).toBe(
    "🔥 fire unlocks when you connect Codex",
  )
  expect(fireProgressLine(normalizeOnboarding(serverPayload([])))).toBe("🔥 fire is ready")
})

test("the seat summary is derived from the spec, never hardcoded", () => {
  const rows = fireSummary(FIRE_SPEC)
  expect(rows).toEqual([
    { role: "Lead", detail: "Fable 5.1 · high", provider: "Claude" },
    { role: "Sidekick", detail: "GPT-5.6 Sol · medium", provider: "Codex" },
    { role: "Advisor", detail: "GPT-5.6 Sol · high", provider: "Codex" },
    { role: "Frontend", detail: "Opus · medium", provider: "Claude" },
    { role: "Web search", detail: "GPT-5.6 Luna · high · fast", provider: "Codex" },
  ])
})

test("the seat summary tolerates thin, null-seat and empty specs", () => {
  expect(fireSummary(null)).toEqual([])
  expect(fireSummary({ provider: "zen", model: "" })).toEqual([])
  expect(fireSummary({ provider: "zen", model: "glm-4.6", advisor: null, sidekick: null })).toEqual([
    { role: "Lead", detail: "GLM 4.6", provider: "Zen" },
  ])
  // A lead that pins speed says so too.
  expect(fireSummary({ provider: "zen", model: "glm-4.6", effort: "low", speed: "fast" })[0]).toEqual({
    role: "Lead",
    detail: "GLM 4.6 · low · fast",
    provider: "Zen",
  })
})

test("seat roles use product words, falling back to title case", () => {
  expect(seatRoleLabel("frontend")).toBe("Frontend")
  expect(seatRoleLabel("websearch")).toBe("Web search")
  expect(seatRoleLabel("web-search")).toBe("Web search")
  expect(seatRoleLabel("backend")).toBe("Backend")
  expect(seatRoleLabel("data_pipeline")).toBe("Data Pipeline")
  expect(seatRoleLabel("qa")).toBe("Qa")
})

// ---- model spelling -------------------------------------------------------

test("prettyModelName writes model ids the way people say them", () => {
  expect(prettyModelName("claude-fable-5-1[1m]")).toBe("Fable 5.1")
  expect(prettyModelName("claude-opus-5")).toBe("Opus 5")
  expect(prettyModelName("opus[1m]")).toBe("Opus")
  expect(prettyModelName("gpt-5.6-sol")).toBe("GPT-5.6 Sol")
  expect(prettyModelName("gpt-5-6-sol")).toBe("GPT-5.6 Sol")
  expect(prettyModelName("gpt-5.6-luna")).toBe("GPT-5.6 Luna")
  expect(prettyModelName("claude-sonnet-4-6")).toBe("Sonnet 4.6")
  expect(prettyModelName("grok-4.6")).toBe("Grok 4.6")
  expect(prettyModelName("glm-4.6")).toBe("GLM 4.6")
  // A vendor prefix is only dropped when a family name follows it.
  expect(prettyModelName("claude-3-5-haiku")).toBe("Claude 3.5 Haiku")
  expect(prettyModelName("claude")).toBe("Claude")
  expect(prettyModelName("")).toBe("…")
  expect(prettyModelName(null)).toBe("…")
  expect(prettyModelName("[1m]")).toBe("…")
})

test("prettyModel (the picker's label) is left exactly as it was", () => {
  // Several surfaces and their tests depend on this spelling; the onboarding
  // helper is deliberately a separate function.
  expect(prettyModel("gpt-5.6-sol")).toBe("GPT 5.6 Sol")
  expect(prettyModel("claude-sonnet-4-6")).toBe("Claude Sonnet 4 6")
  expect(prettyModel("claude-fable-5-1[1m]")).toBe("Claude Fable 5 1")
})

// ---- the post-onboarding nudge -------------------------------------------

const NUDGE_BASE = {
  live: true,
  onboarding: normalizeOnboarding(serverPayload([])),
  globalMode: "balanced" as string | null,
  savedModes: [{ name: "fire" }, { name: "balanced" }],
  wizardOpen: false,
  dismissed: null as string | null,
}

test("the nudge appears only when fire is unlocked, saved and not in effect", () => {
  expect(fireNudgeMode(NUDGE_BASE)).toBe("fire")
  // Already on fire (case-insensitively) → silent.
  expect(fireNudgeMode({ ...NUDGE_BASE, globalMode: "fire" })).toBe(null)
  expect(fireNudgeMode({ ...NUDGE_BASE, globalMode: "FIRE" })).toBe(null)
  // No mode in effect at all still nudges.
  expect(fireNudgeMode({ ...NUDGE_BASE, globalMode: null })).toBe("fire")
})

test("the nudge stays silent for demo, locked, unsaved, dismissed and old servers", () => {
  expect(fireNudgeMode({ ...NUDGE_BASE, live: false })).toBe(null)
  expect(fireNudgeMode({ ...NUDGE_BASE, wizardOpen: true })).toBe(null)
  expect(fireNudgeMode({ ...NUDGE_BASE, dismissed: "fire" })).toBe(null)
  expect(fireNudgeMode({ ...NUDGE_BASE, dismissed: "Fire" })).toBe(null)
  // Dismissing a different mode doesn't silence fire.
  expect(fireNudgeMode({ ...NUDGE_BASE, dismissed: "deep" })).toBe("fire")
  // Locked: a provider is still missing.
  expect(
    fireNudgeMode({ ...NUDGE_BASE, onboarding: normalizeOnboarding(serverPayload(["codex"])) }),
  ).toBe(null)
  // The server hasn't seeded the saved mode yet → applying it would fail.
  expect(fireNudgeMode({ ...NUDGE_BASE, savedModes: [{ name: "balanced" }] })).toBe(null)
  // Older runtime / unreachable server: no recommendation, no nudge.
  expect(fireNudgeMode({ ...NUDGE_BASE, onboarding: normalizeOnboarding({}) })).toBe(null)
  expect(fireNudgeMode({ ...NUDGE_BASE, onboarding: null })).toBe(null)
})

test("a GLOBAL apply is what silences the nudge", () => {
  // Regression guard for the session-only apply bug: the nudge is derived from
  // `globalMode` (App: activeModeName(modes, ModesResponse.current)). Pinning
  // fire on the attached session alone leaves `current` — and therefore
  // `globalMode` — unchanged, so the strip would never go away.
  const beforeApply = { ...NUDGE_BASE, globalMode: "balanced" }
  expect(fireNudgeMode(beforeApply)).toBe("fire")
  // Session-only apply: the global pairing is untouched → still nudging.
  expect(fireNudgeMode({ ...beforeApply, globalMode: "balanced" })).toBe("fire")
  // Global apply → refreshModes() re-derives globalMode as "fire" → silent.
  expect(fireNudgeMode({ ...beforeApply, globalMode: "fire" })).toBe(null)
})

test("the nudge sentence is written from the spec", () => {
  expect(fireNudgeCopy("fire", FIRE_SPEC)).toBe(
    "🔥 fire is the way to use Chunky — Fable 5.1 leads, GPT-5.6 Sol and Opus work the seats.",
  )
  // Lead-only and empty specs still produce a sentence.
  expect(fireNudgeCopy("fire", { provider: "zen", model: "glm-4.6" })).toBe(
    "🔥 fire is the way to use Chunky — GLM 4.6 leads.",
  )
  expect(fireNudgeCopy("fire", null)).toBe("🔥 fire is the way to use Chunky — one command puts you on it.")
})
