// Who the sidebar row says you are, in precedence order:
//
//   1. the display name configured in Settings → General, persisted by Bun in
//      ~/.chunky/state/desktop.json (see ../../bun/desktopState.ts, reached
//      through ./desktopState). Blank means "no override", never a blank name.
//   2. `git config user.name`, read by the Bun bridge in ../../bun/git.ts and
//      fetched through ./git.
//   3. the neutral fallback below.
//
// Both sources are owned and fetched by App, which holds the live values and
// hands the resolved name down to a presentational Sidebar. Everything in THIS
// module is pure — picking between the two, normalising the winner and deriving
// the avatar's letter — so there is no identity store here to compete with
// desktop.json.
//
// The fallback is deliberately neutral and non-personal. A machine-specific
// value (the OS account, the hostname) would be both wrong for a coworker and
// a small privacy leak in every screenshot, so an unreadable identity reads as
// the product's own name instead.
import { graphemes } from "./quickKeys"

/** Shown when neither source yields a name. Never a person, never this machine. */
export const FALLBACK_DISPLAY_NAME = "Chunky"
/** The avatar letter when even the first character can't be derived. */
export const FALLBACK_INITIAL = "C"

/**
 * A raw `user.name` (or anything at all) as the name to render: inner runs of
 * whitespace collapse to single spaces, the ends are trimmed, and anything
 * empty becomes the neutral fallback.
 */
export function resolveDisplayName(raw?: string | null): string {
  if (typeof raw !== "string") return FALLBACK_DISPLAY_NAME
  const collapsed = raw.replace(/\s+/g, " ").trim()
  return collapsed || FALLBACK_DISPLAY_NAME
}

/**
 * The name to show, in precedence order: an explicitly configured override
 * (Settings → General), then git's `user.name`, then nothing — which the two
 * functions above turn into the neutral fallback.
 *
 * A blank override is not an override: clearing the field in Settings restores
 * the git name rather than pinning an empty string.
 */
export function pickDisplayName(override?: string | null, gitName?: string | null): string {
  const configured = typeof override === "string" ? override.trim() : ""
  if (configured) return configured
  return typeof gitName === "string" ? gitName.trim() : ""
}

/**
 * The avatar's single character: the first VISIBLE grapheme of the resolved
 * name, uppercased. Grapheme-safe on purpose — slicing "🧑‍💻" or a combining
 * sequence by UTF-16 unit would paint a replacement glyph in the circle.
 */
export function avatarInitial(raw?: string | null): string {
  const first = graphemes(resolveDisplayName(raw))[0] ?? ""
  return first ? first.toLocaleUpperCase() : FALLBACK_INITIAL
}
