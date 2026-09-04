// Pure derivations behind the onboarding wizard.
//
// The wizard is fire-first: the server names ONE recommended mode (today
// "fire") plus the providers it needs, and every screen is phrased around it.
// All of that reasoning lives here so it can be unit-tested without React, and
// so the old-server fallback (`recommended: null` → today's generic flow) is a
// single, obvious branch rather than scattered `?.` chains.
import type { ModeAdvisor, ModeInfo, ModeSpec } from "@chunky/protocol"
import { prettyModelName, providerLabel } from "./api"
import type { OnboardingProvider, OnboardingResponse, SuggestedMode } from "./configApi"

/**
 * Onboarding speaks product names, not vendor ids: nobody signing in thinks of
 * it as "Anthropic". Scoped to this flow on purpose — `providerLabel` is the
 * app-wide identity used by Settings, the pickers and the status rule, and
 * renaming it there would contradict every other surface.
 */
const ONBOARDING_PROVIDER_ALIAS: Record<string, string> = {
  anthropic: "Claude",
}

export function onboardingProviderLabel(id: string | null | undefined): string {
  if (!id) return providerLabel(id)
  return ONBOARDING_PROVIDER_ALIAS[id.toLowerCase()] ?? providerLabel(id)
}

/** Null-safe: a missing/older response behaves like "no recommendation". */
type Res = OnboardingResponse | null | undefined

/** True when the server told us which mode to aim for (newer runtimes only). */
export function hasRecommendation(res: Res): boolean {
  return !!res?.recommended
}

/** The provider ids the recommended mode needs, in server order. */
export function recommendedProviders(res: Res): string[] {
  return res?.recommended?.requires ?? []
}

/** Required providers that aren't connected yet. */
export function recommendedMissing(res: Res): string[] {
  return res?.recommended?.missing ?? []
}

/** The recommended mode is applicable right now. */
export function isRecommendedReady(res: Res): boolean {
  return hasRecommendation(res) && recommendedMissing(res).length === 0
}

/** The suggested mode entry for the recommendation (it always comes first, but
 *  match by name so ordering is never load-bearing). */
export function recommendedMode(res: Res): SuggestedMode | null {
  const name = res?.recommended?.name
  if (!name) return null
  return res?.suggestedModes.find((m) => m.name === name) ?? null
}

/** A recommended mode is locked when the server says so OR when the
 *  recommendation still lists missing providers (belt and braces: never apply). */
export function isModeLocked(mode: SuggestedMode | null, res?: Res): boolean {
  if (!mode) return true
  if (mode.locked) return true
  if (res && res.recommended?.name === mode.name) return recommendedMissing(res).length > 0
  return false
}

/** What a locked recommendation is waiting on: the mode's own list wins, the
 *  recommendation's `missing` is the fallback. */
export function lockedOn(mode: SuggestedMode | null, res: Res): string[] {
  const own = mode?.missingProviders ?? []
  return own.length > 0 ? own : recommendedMissing(res)
}

/** Everything the user could pick INSTEAD of the recommendation — unlocked
 *  only, since applying a locked spec is a 409. */
export function otherSuggestions(res: Res): SuggestedMode[] {
  const recName = res?.recommended?.name
  return (res?.suggestedModes ?? []).filter((m) => m.name !== recName && !m.locked)
}

/** Providers split into the recommendation's hero pair and the rest. Hero cards
 *  follow `requires` order; unknown ids are dropped (nothing to sign into). */
export function splitProviders(
  providers: OnboardingProvider[],
  requires: string[],
): { hero: OnboardingProvider[]; rest: OnboardingProvider[] } {
  if (requires.length === 0) return { hero: [], rest: providers }
  const hero: OnboardingProvider[] = []
  for (const id of requires) {
    const found = providers.find((p) => p.id === id)
    if (found) hero.push(found)
  }
  const heroIds = new Set(hero.map((p) => p.id))
  return { hero, rest: providers.filter((p) => !heroIds.has(p.id)) }
}

/** "Claude", "Claude and Codex", "A, B and C" — onboarding spelling. */
export function providerNames(ids: string[]): string {
  const labels = ids.map((id) => onboardingProviderLabel(id))
  if (labels.length === 0) return ""
  if (labels.length === 1) return labels[0]!
  return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`
}

/** One line for the recommended mode's title, e.g. "Connect Anthropic and Codex". */
export function connectTitle(res: Res): string {
  const requires = recommendedProviders(res)
  return requires.length > 0 ? `Connect ${providerNames(requires)}` : "Connect a provider"
}

/** The progress line under step 1's hero cards. Null on older servers. */
export function fireProgressLine(res: Res): string | null {
  const rec = res?.recommended
  if (!rec) return null
  const missing = recommendedMissing(res)
  if (missing.length === 0) return `🔥 ${rec.name} is ready`
  const requires = recommendedProviders(res)
  if (missing.length === requires.length && requires.length === 2) {
    return `🔥 ${rec.name} unlocks when both are connected`
  }
  return `🔥 ${rec.name} unlocks when you connect ${providerNames(missing)}`
}

/** One row of a mode's pairing, already worded for display. */
export interface SeatSummary {
  /** "Lead", "Sidekick", "Advisor", "Reviewer", or a named seat ("Frontend"). */
  role: string
  /** "Fable 5.1 · high" — model first, effort when the spec pins one. */
  detail: string
  /** "Anthropic" — the provider behind that seat. */
  provider: string
}

/** "GPT-5.6 Luna · high · fast" — model, then whatever the spec actually pins. */
const seatDetail = (model: string, effort?: string, speed?: string): string =>
  [prettyModelName(model), effort, speed].filter(Boolean).join(" · ")

/** Named seats the product has words for; anything else falls back to
 *  title-case so a server-side seat name still reads sanely. */
const SEAT_LABELS: Record<string, string> = {
  frontend: "Frontend",
  backend: "Backend",
  websearch: "Web search",
  research: "Research",
  design: "Design",
}

const titleCase = (name: string): string =>
  name
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((p) => p[0]!.toUpperCase() + p.slice(1))
    .join(" ")

export function seatRoleLabel(name: string): string {
  return SEAT_LABELS[name.toLowerCase().replace(/[-_\s]+/g, "")] ?? titleCase(name)
}

/** `speed` is only carried by ModeAdvisor-shaped seats on newer servers. */
type SeatLike = (ModeAdvisor & { speed?: string }) | null | undefined

const seatRow = (role: string, seat: SeatLike): SeatSummary | null =>
  seat?.model
    ? {
        role,
        detail: seatDetail(seat.model, seat.effort, seat.speed),
        provider: onboardingProviderLabel(seat.provider),
      }
    : null

/**
 * The recommended mode in plain words: who leads, who sidekicks, who advises,
 * and which named seats it pins. Nothing here is hardcoded — every label is
 * derived from the spec the server sent, so a change to fire's models shows up
 * without an App release.
 */
export function fireSummary(spec: ModeSpec | null | undefined): SeatSummary[] {
  if (!spec?.model) return []
  const rows: SeatSummary[] = [
    {
      role: "Lead",
      detail: seatDetail(spec.model, spec.effort, spec.speed),
      provider: onboardingProviderLabel(spec.provider),
    },
  ]
  const sidekick = seatRow("Sidekick", spec.sidekick)
  if (sidekick) rows.push(sidekick)
  const advisor = seatRow("Advisor", spec.advisor)
  if (advisor) rows.push(advisor)
  const review = seatRow("Reviewer", spec.review)
  if (review) rows.push(review)
  for (const [name, seat] of Object.entries(spec.sidekickSeats ?? {})) {
    const row = seatRow(seatRoleLabel(name), seat)
    if (row) rows.push(row)
  }
  return rows
}

// ---- Post-onboarding nudge ------------------------------------------------

/**
 * Whether the quiet "get on fire" strip above the composer should be visible,
 * and for which mode. Pure so the rule — which has five independent ways to be
 * wrong — is testable without mounting the app.
 *
 * It shows ONLY when the recommendation is real, unlocked, seeded as a saved
 * mode (so applying it can't 404), not already in effect, not dismissed, and
 * nothing modal is on screen.
 */
export function fireNudgeMode(input: {
  /** Live server (never in demo/offline). */
  live: boolean
  onboarding: OnboardingResponse | null | undefined
  /** The saved mode currently in effect globally (App's `globalMode`). */
  globalMode: string | null
  /** Saved modes the server knows about. */
  savedModes: Pick<ModeInfo, "name">[]
  /** The onboarding wizard is on screen. */
  wizardOpen: boolean
  /** Mode name the user dismissed the nudge for, if any. */
  dismissed: string | null
}): string | null {
  const { live, onboarding, globalMode, savedModes, wizardOpen, dismissed } = input
  if (!live || wizardOpen) return null
  const name = onboarding?.recommended?.name
  // No recommendation (older server) or still locked → nothing to nudge toward.
  if (!name || recommendedMissing(onboarding).length > 0) return null
  if (dismissed && dismissed.toLowerCase() === name.toLowerCase()) return null
  if (globalMode && globalMode.toLowerCase() === name.toLowerCase()) return null
  if (!savedModes.some((m) => m.name.toLowerCase() === name.toLowerCase())) return null
  return name
}

/** Dismissal is a disposable renderer preference (which suggestion the user
 *  waved away), not onboarding state — the server owns `onboardedAt`. Same
 *  reasoning as browserPaneWidth: local, cosmetic, safe to lose. */
const FIRE_NUDGE_DISMISSED_KEY = "chunky.fireNudge.dismissed"

export function loadFireNudgeDismissed(): string | null {
  try {
    return localStorage.getItem(FIRE_NUDGE_DISMISSED_KEY)
  } catch {
    return null
  }
}

/** Pass null to clear it (re-running onboarding earns a fresh nudge). */
export function saveFireNudgeDismissed(name: string | null): void {
  try {
    if (name) localStorage.setItem(FIRE_NUDGE_DISMISSED_KEY, name)
    else localStorage.removeItem(FIRE_NUDGE_DISMISSED_KEY)
  } catch {
    /* private mode / no storage — the nudge just comes back next launch */
  }
}

/**
 * The nudge's one line, written from the spec rather than a hardcoded roster:
 * "🔥 fire is the way to use Chunky — Fable 5.1 leads, GPT-5.6 Sol and Opus
 * work the seats." Falls back to a seat-free sentence when the mode pins
 * nothing but a lead.
 */
export function fireNudgeCopy(name: string, spec: ModeSpec | null | undefined): string {
  const rows = fireSummary(spec)
  const [lead, ...rest] = rows
  const head = `🔥 ${name} is the way to use Chunky`
  if (!lead) return `${head} — one command puts you on it.`
  const leadName = lead.detail.split(" · ")[0]!
  const seats: string[] = []
  for (const row of rest) {
    const model = row.detail.split(" · ")[0]!
    if (!seats.includes(model)) seats.push(model)
  }
  if (seats.length === 0) return `${head} — ${leadName} leads.`
  const named = seats.slice(0, 2)
  const list = named.length === 1 ? named[0]! : `${named[0]} and ${named[1]}`
  return `${head} — ${leadName} leads, ${list} work the seats.`
}
