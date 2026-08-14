// Which saved mode is in effect right now — and how the composer's selector
// labels itself.
//
// The server does keep an `activeMode` name (settings.json), but it never
// leaves the process: neither @chunky/protocol nor any REST payload carries it.
// What the contract DOES expose is `ModesResponse.current` — the server's own
// snapshot of the effective executor+advisor+sidekick pairing. So the active
// mode is derived the only honest way available: a mode's observable identity
// is its effective configuration, so a saved spec that matches `current` IS the
// mode in effect. It also decays correctly — picking a model by hand changes
// `current` (the server clears its own activeMode at that same moment), the
// match dissolves, and the selector falls back to the model name.
import type { ModeAdvisor, ModeInfo, ModeSpec } from "@chunky/protocol"

const norm = (value: string | null | undefined): string =>
  value == null ? "" : value.trim().toLowerCase()

/** Two paired-model slots (advisor / sidekick / reviewer). Absent === off. */
function samePairing(a: ModeAdvisor | null, b: ModeAdvisor | null | undefined): boolean {
  if (!a || !b) return !a && !b
  return (
    norm(a.provider) === norm(b.provider) &&
    norm(a.model) === norm(b.model) &&
    (!a.effort || norm(a.effort) === norm(b.effort))
  )
}

/**
 * How well a saved mode matches the current pairing: the number of fields it
 * pins, or null when it contradicts one. Fields the mode leaves UNDECLARED
 * don't constrain it (per ModeSpec: absent = "leave this alone"), so they
 * neither match nor disqualify.
 *
 * Named seats follow the same partial-mode rule: when a mode declares them,
 * each declared seat must match; undeclared seats don't constrain the match.
 */
function matchScore(mode: ModeSpec, current: ModeSpec): number | null {
  if (norm(mode.provider) !== norm(current.provider)) return null
  if (norm(mode.model) !== norm(current.model)) return null
  let score = 2

  for (const key of ["effort", "speed"] as const) {
    const want = mode[key]
    if (!want) continue
    if (norm(want) !== norm(current[key])) return null
    score++
  }

  for (const key of ["advisor", "sidekick", "review"] as const) {
    const want = mode[key]
    if (want === undefined) continue
    if (!samePairing(want, current[key])) return null
    score++
  }

  if (mode.sidekickSeats !== undefined) {
    if (mode.sidekickSeats === null) {
      if (current.sidekickSeats && Object.keys(current.sidekickSeats).length > 0) return null
    } else {
      const currentSeats = current.sidekickSeats ?? {}
      for (const [name, seat] of Object.entries(mode.sidekickSeats)) {
        if (!samePairing(seat, currentSeats[name])) return null
        score++
      }
    }
  }

  return score
}

/**
 * The saved mode whose spec IS the current pairing, or null when the live
 * configuration doesn't correspond to any saved mode. When several modes match
 * (one being a laxer version of another), the most specific one wins; ties go
 * to the server's list order.
 */
export function activeModeName(
  modes: ModeInfo[],
  current: ModeSpec | null | undefined,
): string | null {
  if (!current || !norm(current.model)) return null
  let best: { name: string; score: number } | null = null
  for (const mode of modes) {
    const score = matchScore(mode, current)
    if (score == null) continue
    if (!best || score > best.score) best = { name: mode.name, score }
  }
  return best?.name ?? null
}

/**
 * The label for one session's effective mode. Session-pinned mode identity is
 * authoritative. An unpinned session inherits the global pairing, whose name
 * has to be derived from `ModesResponse.current` because the session snapshot
 * deliberately reports `activeMode: null` for `source: "global"`.
 */
export function sessionModeName(
  source: "session-mode" | "session-selection" | "global" | undefined,
  activeMode: string | null | undefined,
  globalMode: string | null,
): string | null {
  if (source === "global") return globalMode
  return activeMode ?? null
}

/**
 * What the composer's selector says: the mode's own name while a mode is in
 * effect, or null so the caller falls back to the executor's model name.
 *
 * The distinction that matters is WHOSE mode it is. A session-pinned mode
 * (`source: "session-mode"`, i.e. the server kept an `activeMode` for THIS
 * chat) is identity: it holds until the session is repinned, so nothing about
 * the effective executor — solo included — may demote the chip to a model
 * name. Solo can be true here for reasons that have nothing to do with this
 * chat: the pin map may not be hydrated yet, or the GLOBAL default may be solo
 * while this session runs a mode.
 *
 * An INHERITED session (`source: "global"`) has no identity of its own; it is
 * only wearing the default pairing's name. Solo on that scope means no mode is
 * in effect, so the label falls back — the pre-existing behaviour for a raw
 * model pick, which is what solo describes.
 */
export function modeChipLabel(
  activeMode: string | null,
  { pinned, solo }: { pinned: boolean; solo: boolean },
): string | null {
  if (!activeMode) return null
  return pinned || !solo ? activeMode : null
}

/** Keyword → emoji. A mode name is free text the user picked, so match on
 *  substrings rather than demanding a whole word; the LONGEST matching keyword
 *  wins (so "starship" reads as a ship, not a star), ties by table order. */
const MODE_EMOJI: [keywords: string[], emoji: string][] = [
  [["fire", "flame", "burn"], "🔥"],
  [["ice", "frost", "cold", "chill"], "❄️"],
  [["rocket", "launch", "ship"], "🚀"],
  [["turbo", "speed", "fast", "bolt", "quick"], "⚡"],
  [["zen", "calm"], "🧘"],
  [["beast", "muscle", "brute"], "🦾"],
  [["cheap", "budget", "frugal", "thrift"], "💸"],
  [["deep", "think", "brain", "smart"], "🧠"],
  [["night", "dark", "moon"], "🌙"],
  [["ghost", "incognito", "stealth", "private"], "👻"],
  [["magic", "wizard", "wand"], "🪄"],
  [["star"], "⭐"],
  [["ocean", "wave", "sea"], "🌊"],
  [["sun", "day", "light"], "☀️"],
]

/** What an unrecognised mode wears — neutral, and still an emoji, so the
 *  selector's glyph slot never changes shape from one mode to the next. */
export const DEFAULT_MODE_EMOJI = "✨"

/**
 * A fitting emoji for a saved mode's name: `fire` → 🔥, `night-owl` → 🌙.
 * Case-insensitive, matched on keyword substrings, falling back to ✨ so every
 * mode has a glyph (and the button's icon slot never collapses).
 */
export function modeEmoji(name: string): string {
  const lower = norm(name)
  if (!lower) return DEFAULT_MODE_EMOJI
  let best: { emoji: string; length: number } | null = null
  for (const [keywords, emoji] of MODE_EMOJI) {
    for (const keyword of keywords) {
      if (!lower.includes(keyword)) continue
      if (!best || keyword.length > best.length) best = { emoji, length: keyword.length }
    }
  }
  return best?.emoji ?? DEFAULT_MODE_EMOJI
}
