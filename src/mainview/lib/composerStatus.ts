// Composer status chips — the app's port of the TUI's input bottom rule
// (../chunky/packages/tui/src/App.tsx `bottomStatus`).
//
// The rule is deliberately SHORT: only state you must not miss rides in it —
// incognito (loud), the executor model+effort (accent headline), and a goal
// (it silently spends turns). The sidekick seats and the advisor are supporting
// cast: they are carried as the executor chip's `details` and revealed on
// hover, not spelled out inline. Absence still means off, so there is never an
// "off" label. Demo/offline yields a single dim `demo` chip rather than
// pretending a server config exists.
//
// SOLO (lib/solo) is the one state that CHANGES what the details mean: the
// server is suppressing every delegate, so the chip carries a solo breakdown
// (executor + the opt-in solo advisor + "no delegates") instead of seats that
// would be a lie on screen.
//
// This module is pure so the semantics can be reasoned about (and tested)
// without React; ComposerStatus.tsx only paints what it returns.
import type { GoalSnapshot } from "@chunky/protocol"
import { prettyModel } from "./api"
import type { AdvisorStatus, SidekickConfig } from "./configApi"
import { SOLO_EXPLAINER, soloLines } from "./solo"

/** Visual weight, mapped to Tailwind classes by the component. */
export type ChipTone = "danger" | "accent" | "dim" | "warning"

/** One line of a chip's hover breakdown (a sidekick seat and its model). */
export interface ChipDetail {
  name: string
  model: string
}

export interface StatusChip {
  key: string
  text: string
  tone: ChipTone
  /** Longer hover text; the chip itself stays compact. */
  title?: string
  /** The seats and roles this chip stands in for — revealed on hover. */
  details?: ChipDetail[]
}

export interface ComposerStatusInput {
  /** "demo" = no live server; only the lone `demo` chip is rendered. */
  mode: "live" | "demo"
  incognito?: boolean
  /** Configured executor selection (provider-side ids, not display names). */
  executor?: { model?: string | null; effort?: string | null } | null
  sidekick?: SidekickConfig | null
  advisor?: AdvisorStatus | null
  /** SOLO (see lib/solo): the model runs alone. The sidekick, its seats and the
   *  normal advisor are suppressed server-side, so the rule must not carry
   *  them — only the opt-in solo advisor. */
  solo?: boolean
  soloAdvisor?: AdvisorStatus | null
  goal?: GoalSnapshot | null
}

/**
 * Build the ordered chip list. Returns an empty list while a live session is
 * still connecting (no executor model yet) — the caller renders nothing.
 */
export function buildComposerStatus(input: ComposerStatusInput): StatusChip[] {
  if (input.mode !== "live") return [{ key: "demo", text: "demo", tone: "dim" }]

  // The headline is built from the model ID (TUI parity): a catalog display
  // name is often just "Fable", while `claude-fable-5` → "Claude Fable 5" says
  // which model is actually live.
  const executorModel = input.executor?.model ?? null
  const label = executorModel ? prettyModel(executorModel) : null
  if (!label) return [] // connecting — plain composer, no chips

  const chips: StatusChip[] = []

  // INCOGNITO first: the loudest thing on the rule.
  if (input.incognito) {
    chips.push({
      key: "incognito",
      text: "INCOGNITO",
      tone: "danger",
      title: "This session is off the record — nothing is written to disk.",
    })
  }

  // Sidekick — only when the default seat is enabled. An unconfigured seat
  // INHERITS the executor, so record the effective model (what a handoff
  // actually runs on) rather than the word "inherit".
  const details: ChipDetail[] = []
  const sidekick = input.solo ? null : input.sidekick
  if (sidekick?.default.enabled) {
    const seatNames = Object.keys(sidekick.seats)
    const model = sidekick.default.model ? prettyModel(sidekick.default.model) : label
    details.push({ name: seatNames.length ? "sidekick (default)" : "sidekick", model })
    for (const name of seatNames) {
      const seatModel = sidekick.seats[name]?.model
      details.push({
        name: `sidekick (${name})`,
        model: seatModel ? prettyModel(seatModel) : model,
      })
    }
  }

  // Advisor — only when enabled AND it has a model; marked when suppressed.
  const advisor = input.solo ? null : input.advisor
  if (advisor?.config.enabled && advisor.config.model) {
    const model = prettyModel(advisor.config.model)
    details.push({ name: "advisor", model: advisor.active ? model : `${model} (unavailable)` })
  }

  // Executor headline: `Claude Fable 5 (low)`, standing in for every seat it
  // feeds. The seats hang off it rather than crowding the rule.
  const effort = input.executor?.effort
  // In solo the breakdown says what solo IS (executor, the opt-in solo advisor,
  // and "no delegates") instead of a seat list the server is suppressing.
  const soloDetails = input.solo
    ? soloLines(label, input.soloAdvisor?.config, input.soloAdvisor?.active !== false)
    : null
  chips.push({
    key: "executor",
    text: `${label}${effort ? ` (${effort})` : ""}`,
    tone: "accent",
    title: input.solo
      ? `${SOLO_EXPLAINER}${effort ? ` · effort ${effort}` : ""}`
      : `Executor model${effort ? ` · effort ${effort}` : ""}`,
    ...(soloDetails
      ? { details: soloDetails }
      : details.length
        ? { details: [{ name: "executor", model: label }, ...details] }
        : {}),
  })

  // Goal — only when one exists; WARNING while active (it carries turns).
  const goal = input.goal
  if (goal) {
    const active = goal.status === "active"
    chips.push({
      key: "goal",
      text: `goal ${goal.status}${active ? ` ${goal.turns}/${goal.maxTurns}` : ""}`,
      tone: active ? "warning" : "dim",
      title: goal.objective,
    })
  }

  return chips
}
