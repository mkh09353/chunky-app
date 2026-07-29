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
  return norm(a.provider) === norm(b.provider) && norm(a.model) === norm(b.model)
}

/**
 * How well a saved mode matches the current pairing: the number of fields it
 * pins, or null when it contradicts one. Fields the mode leaves UNDECLARED
 * don't constrain it (per ModeSpec: absent = "leave this alone"), so they
 * neither match nor disqualify.
 *
 * `sidekickSeats` is deliberately not compared: named seats can be overridden
 * per session, so folding them in would produce false negatives.
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
