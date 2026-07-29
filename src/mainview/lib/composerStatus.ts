// Composer status chips — the app's port of the TUI's input bottom rule
// (../chunky/packages/tui/src/App.tsx `bottomStatus`).
//
// Semantics are copied literally from the TUI: the executor model+effort is the
// ACCENT headline, and sidekick/advisor/goal are DIM chips shown ONLY when
// present. Absence means off, so there is never an "off" label. Incognito comes
// first, in the loud (red) accent. Demo/offline yields a single dim `demo` chip
// rather than pretending a server config exists.
//
// This module is pure so the semantics can be reasoned about (and tested)
// without React; ComposerStatus.tsx only paints what it returns.
import type { GoalSnapshot } from "@chunky/protocol"
import { prettyModel } from "./api"
import type { AdvisorStatus, SidekickConfig } from "./configApi"

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
  /** What the chip's compact suffix collapses — revealed on hover. */
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

  // Executor headline: `Claude Fable 5 (low)`.
  const effort = input.executor?.effort
  chips.push({
    key: "executor",
    text: `${label}${effort ? ` (${effort})` : ""}`,
    tone: "accent",
    title: `Executor model${effort ? ` · effort ${effort}` : ""}`,
  })

  // Sidekick — only when the default seat is enabled. An unconfigured seat
  // INHERITS the executor, so show the effective model (what a handoff actually
  // runs on) rather than the word "inherit". Seat suffix: exactly one named
  // seat → ` +name`, more than one → ` +N`.
  const sidekick = input.sidekick
  if (sidekick?.default.enabled) {
    const seatNames = Object.keys(sidekick.seats)
    const seatSuffix =
      seatNames.length === 0
        ? ""
        : seatNames.length === 1
          ? ` +${seatNames[0]}`
          : ` +${seatNames.length}`
    const model = sidekick.default.model ? prettyModel(sidekick.default.model) : label
    // Every seat with the model a handoff actually RUNS on: an unset seat
    // inherits the default seat, which itself inherits the executor. This is
    // what the `+name` / `+N` suffix collapses, so hover can spell it out.
    const details: ChipDetail[] = [
      { name: "default", model },
      ...seatNames.map((name) => {
        const seatModel = sidekick.seats[name]?.model
        return { name, model: seatModel ? prettyModel(seatModel) : model }
      }),
    ]
    chips.push({
      key: "sidekick",
      text: `⚒ sidekick ${model}${seatSuffix}`,
      tone: "dim",
      title:
        seatNames.length > 1 ? `Sidekick seats: ${seatNames.join(", ")}` : "Sidekick worker model",
      details,
    })
  }

  // Advisor — only when enabled AND it has a model; ` ✕` when suppressed.
  const advisor = input.advisor
  if (advisor?.config.enabled && advisor.config.model) {
    chips.push({
      key: "advisor",
      text: `✦ advisor ${prettyModel(advisor.config.model)}${advisor.active ? "" : " ✕"}`,
      tone: "dim",
      title: advisor.active ? "Advisor model" : "Advisor configured but unavailable",
    })
  }

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
