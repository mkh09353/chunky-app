// Slash commands for the composer, mirroring the TUI's registry semantics
// (../chunky/packages/tui/src/components/SlashMenu.tsx).
//
// Only commands the app has a REAL equivalent for live here — TUI-only actions
// (/quit, /login, /workers, /scoreboard, /cacheguard, /onboard) are omitted
// rather than faked. Saved modes double as slash commands (`/fire` applies the
// "fire" mode) and may never shadow a built-in, matched case-insensitively.
import type { ModeInfo } from "@chunky/protocol"

export interface SlashCommand {
  name: string
  description: string
}

/** Built-in commands, each wired to an action the app already has. */
export const COMMANDS: SlashCommand[] = [
  { name: "/clear", description: "Start a new session" },
  { name: "/resume", description: "Resume a previous thread in this repo" },
  { name: "/rewind", description: "Restore files and conversation to an earlier turn" },
  { name: "/fork", description: "Branch this session, optionally in a Git worktree" },
  { name: "/rename", description: "Rename this session" },
  { name: "/model", description: "Pick the executor model" },
  { name: "/mode", description: "Named model+sidekick+advisor trios (/mode <name>, /mode save <name>)" },
  { name: "/advisor", description: "Set the advisor model (a stronger model, on tap)" },
  { name: "/sidekick", description: "Configure sidekick seats (default + named, e.g. frontend/backend)" },
  { name: "/skills", description: "Browse skills; add/remove/update skill repos" },
  { name: "/provider", description: "Configure available models for a provider" },
  { name: "/usage", description: "This session's tokens and cost, grouped by role" },
  { name: "/scoreboard", description: "Model leaderboard by rating (`/scoreboard session` scopes it)" },
  { name: "/workers", description: "Inspect or tune automatic workflow model routing" },
  { name: "/cacheguard", description: "Confirm before re-sending a big cold cache (/cacheguard 100k|off)" },
  { name: "/reviewer", description: "Set the asynchronous reviewer model" },
  { name: "/incognito", description: "Go off the record: apply an incognito mode (/incognito [name])" },
  { name: "/goal", description: "Work autonomously toward a goal (/goal <objective>)" },
  { name: "/shipit", description: "Hand this plan off to a fresh goal-orchestrator session (/shipit [notes])" },
  { name: "/settings", description: "Open the Settings Center" },
  { name: "/help", description: "Show the available commands" },
]

export const builtinCommandNames = new Set(COMMANDS.map((c) => c.name.toLowerCase()))

/** A bare `/command` with no arguments — the only shape that can be a mode. */
export const BARE_COMMAND_RE = /^\/[^/\s]+$/

/**
 * Saved modes double as slash commands: picking `/fire` applies the "fire"
 * mode. Given a bare `/command` and the current saved-mode commands, return the
 * mode name for the `/mode <name>` apply flow (leading slash stripped), or null
 * when it's a built-in or unknown. Case-insensitive; never shadows a built-in.
 */
export function savedModeForCommand(command: string, slashModes: SlashCommand[]): string | null {
  const lower = command.toLowerCase()
  if (builtinCommandNames.has(lower)) return null
  const match = slashModes.find((m) => m.name.toLowerCase() === lower)
  return match ? match.name.replace(/^\//, "") : null
}

/** Saved modes → slash entries, dropping any that would shadow a built-in. */
export function modeCommands(modes: ModeInfo[], describe: (mode: ModeInfo) => string): SlashCommand[] {
  return modes
    .filter((m) => !builtinCommandNames.has(`/${m.name.toLowerCase()}`))
    .map((m) => ({ name: `/${m.name}`, description: describe(m) }))
}

/** Menu filter: prefix match on the typed token, case-insensitive (TUI parity). */
export function filterCommands(commands: SlashCommand[], value: string): SlashCommand[] {
  const q = value.toLowerCase()
  return commands.filter((c) => c.name.toLowerCase().startsWith(q))
}
