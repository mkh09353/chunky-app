// Quick keys: user-defined prompt chips shown above the composer.
//
// A quick key is pure user config — an icon, a label, the prompt it sends and
// an optional single-letter hotkey (Cmd/Ctrl+Shift+<letter>). Everything here
// is pure: shape guards, bounds, validation and list edits. Persistence lives
// in ./desktopState (Bun-managed desktop.json), rendering in
// ../components/QuickKeys.tsx.

export interface QuickKey {
  id: string
  /** Short icon text — usually one emoji. May be empty. */
  emoji: string
  label: string
  prompt: string
  /** Lowercase single letter, or "" for no hotkey. */
  hotkey: string
}

/** Bounds, mirrored by the Bun writer so a bad payload can't grow the file.
 *
 *  Counted in GRAPHEMES, not UTF-16 units: an emoji like 🧑‍💻 is five units and
 *  👩‍👩‍👧‍👦 is eleven, so a unit-based cap would both reject ordinary emoji and
 *  slice a ZWJ sequence into garbage halfway through. */
export const MAX_QUICK_KEYS = 24
export const MAX_EMOJI_GRAPHEMES = 2
export const MAX_LABEL_LENGTH = 40
export const MAX_PROMPT_LENGTH = 4000
/** Absurdity guard behind the grapheme caps (one grapheme is bounded too). */
export const MAX_EMOJI_UNITS = 64

const segmenter =
  typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : null

/** User-perceived characters. Falls back to code points where Intl.Segmenter
 *  is missing — still never splitting a surrogate pair. */
export function graphemes(value: string): string[] {
  if (!segmenter) return Array.from(value)
  return Array.from(segmenter.segment(value), (part) => part.segment)
}

export function graphemeLength(value: string): number {
  return graphemes(value).length
}

/** Truncate without ever cutting inside an emoji sequence. */
export function truncateGraphemes(value: string, max: number): string {
  const parts = graphemes(value)
  return parts.length <= max ? value : parts.slice(0, max).join("")
}

/** Truncate by code point, so a long prompt can't end in a lone surrogate. */
export function truncateCodePoints(value: string, max: number): string {
  const points = Array.from(value)
  return points.length <= max ? value : points.slice(0, max).join("")
}

/**
 * Letters App.tsx's own Cmd/Ctrl shortcuts already answer to. The existing
 * handlers match on the letter alone and ignore Shift, so Cmd+Shift+K would
 * still open the palette — these are refused at the editor instead of quietly
 * doing two things at once.
 */
export const RESERVED_HOTKEYS: Record<string, string> = {
  k: "⌘K opens the command palette",
  l: "⌘⇧L toggles the theme",
  n: "⌘N starts a new session",
  t: "⌘T folds threads",
}

/**
 * The editor's emoji palette: a small curated set, not a dataset. The macOS
 * system palette is unreliable inside WKWebView, so the dialog offers these
 * inline; the text field still accepts anything typed or pasted.
 *
 * Every entry must be one grapheme, so picking one can never author a draft
 * that validateQuickKey would then reject (see the test that asserts it).
 */
export const EMOJI_CHOICES: readonly string[] = [
  // Ship / build
  "🚀",
  "🛠️",
  "🔧",
  "🔨",
  "⚙️",
  "📦",
  "🏗️",
  "🧱",
  // Verdicts
  "✅",
  "☑️",
  "✔️",
  "❌",
  "⚠️",
  "⛔",
  "❓",
  "❗",
  // Work
  "🐛",
  "🧪",
  "🧹",
  "♻️",
  "🔍",
  "🧭",
  "🩺",
  "🚦",
  // Docs & data
  "📝",
  "📄",
  "📋",
  "📊",
  "📈",
  "🗂️",
  "🔗",
  "📌",
  // Energy
  "🔥",
  "✨",
  "⚡",
  "💡",
  "💥",
  "🎯",
  "🎨",
  "🧩",
  // People & tone
  "🤖",
  "🧠",
  "👀",
  "👍",
  "🙏",
  "🥳",
  "💬",
  "☕",
  // Odds and ends
  "🔒",
  "🔑",
  "⏱️",
  "📅",
  "🌱",
  "🧊",
  "🖥️",
  "🪄",
]

/** A quick key as the editor holds it before validation. */
export interface QuickKeyDraft {
  emoji: string
  label: string
  prompt: string
  hotkey: string
}

export type QuickKeyErrors = Partial<Record<keyof QuickKeyDraft, string>>

export function emptyQuickKeyDraft(): QuickKeyDraft {
  return { emoji: "", label: "", prompt: "", hotkey: "" }
}

export function draftFromQuickKey(key: QuickKey): QuickKeyDraft {
  return { emoji: key.emoji, label: key.label, prompt: key.prompt, hotkey: key.hotkey }
}

/** First letter, lowercased. Anything else (digits, punctuation) → "". */
export function normalizeHotkey(value: string): string {
  const first = value.trim().slice(0, 1).toLowerCase()
  return /^[a-z]$/.test(first) ? first : ""
}

/** How a hotkey reads in a chip badge: "d" → "⌘⇧D". */
export function hotkeyLabel(hotkey: string): string {
  const letter = normalizeHotkey(hotkey)
  return letter ? `⌘⇧${letter.toUpperCase()}` : ""
}

/**
 * Field errors for a draft, keyed by field so the dialog can show them inline.
 * `editingId` exempts the key being edited from the duplicate-hotkey check.
 */
export function validateQuickKey(
  draft: QuickKeyDraft,
  existing: QuickKey[] = [],
  editingId: string | null = null,
): QuickKeyErrors {
  const errors: QuickKeyErrors = {}

  const emoji = draft.emoji.trim()
  if (emoji.length > MAX_EMOJI_UNITS || graphemeLength(emoji) > MAX_EMOJI_GRAPHEMES) {
    errors.emoji = `Use one emoji, or up to ${MAX_EMOJI_GRAPHEMES} characters.`
  }

  const label = draft.label.trim()
  if (!label) errors.label = "A label is required."
  else if (graphemeLength(label) > MAX_LABEL_LENGTH) {
    errors.label = `Keep the label to ${MAX_LABEL_LENGTH} characters or fewer.`
  }

  const prompt = draft.prompt.trim()
  if (!prompt) errors.prompt = "A prompt is required."
  else if (Array.from(prompt).length > MAX_PROMPT_LENGTH) {
    errors.prompt = `Keep the prompt to ${MAX_PROMPT_LENGTH} characters or fewer.`
  }

  const rawHotkey = draft.hotkey.trim()
  if (rawHotkey) {
    const letter = normalizeHotkey(rawHotkey)
    if (!letter || rawHotkey.length > 1) {
      errors.hotkey = "Use a single letter A–Z."
    } else if (RESERVED_HOTKEYS[letter]) {
      errors.hotkey = `⌘⇧${letter.toUpperCase()} is taken — ${RESERVED_HOTKEYS[letter]}.`
    } else {
      const clash = existing.find((key) => key.id !== editingId && key.hotkey === letter)
      if (clash) errors.hotkey = `⌘⇧${letter.toUpperCase()} is already used by “${clash.label}”.`
    }
  }

  return errors
}

export function hasQuickKeyErrors(errors: QuickKeyErrors): boolean {
  return Object.keys(errors).length > 0
}

/** A validated draft, trimmed and bounded, ready to persist. */
export function quickKeyFromDraft(draft: QuickKeyDraft, id: string): QuickKey {
  return {
    id,
    emoji: truncateGraphemes(draft.emoji.trim(), MAX_EMOJI_GRAPHEMES),
    label: truncateGraphemes(draft.label.trim(), MAX_LABEL_LENGTH),
    prompt: truncateCodePoints(draft.prompt.trim(), MAX_PROMPT_LENGTH),
    hotkey: normalizeHotkey(draft.hotkey),
  }
}

/** Next free `qk-<n>` id. Deterministic, so tests never race a clock. */
export function nextQuickKeyId(existing: QuickKey[]): string {
  let max = 0
  for (const key of existing) {
    const match = /^qk-(\d+)$/.exec(key.id)
    if (match) max = Math.max(max, Number(match[1]))
  }
  return `qk-${max + 1}`
}

/** Replace by id, or append (bounded). Never mutates the input list. */
export function upsertQuickKey(list: QuickKey[], key: QuickKey): QuickKey[] {
  const index = list.findIndex((item) => item.id === key.id)
  if (index >= 0) {
    const next = list.slice()
    next[index] = key
    return next
  }
  return [...list, key].slice(0, MAX_QUICK_KEYS)
}

export function removeQuickKey(list: QuickKey[], id: string): QuickKey[] {
  return list.filter((item) => item.id !== id)
}

/** The key a Cmd/Ctrl+Shift press should fire, if any. */
export function quickKeyForHotkey(list: QuickKey[], letter: string): QuickKey | null {
  const normalized = normalizeHotkey(letter)
  if (!normalized) return null
  return list.find((key) => key.hotkey === normalized) ?? null
}

/**
 * Shape guard for whatever came back over RPC (or out of a hand-edited
 * desktop.json): keep the well-formed entries, drop the rest, and make ids and
 * hotkeys unique so the row and the shortcut handler stay unambiguous.
 */
export function cleanQuickKeys(value: unknown): QuickKey[] {
  if (!Array.isArray(value)) return []
  const out: QuickKey[] = []
  const ids = new Set<string>()
  const hotkeys = new Set<string>()
  for (const raw of value) {
    if (out.length >= MAX_QUICK_KEYS) break
    if (!raw || typeof raw !== "object") continue
    const item = raw as Record<string, unknown>
    const id = typeof item.id === "string" ? item.id.trim() : ""
    const label = typeof item.label === "string" ? item.label.trim() : ""
    const prompt = typeof item.prompt === "string" ? item.prompt.trim() : ""
    if (!id || ids.has(id) || !label || !prompt) continue
    let hotkey = typeof item.hotkey === "string" ? normalizeHotkey(item.hotkey) : ""
    if (hotkey && (hotkeys.has(hotkey) || RESERVED_HOTKEYS[hotkey])) hotkey = ""
    if (hotkey) hotkeys.add(hotkey)
    ids.add(id)
    out.push({
      id: id.slice(0, 128),
      emoji:
        typeof item.emoji === "string"
          ? truncateGraphemes(item.emoji.trim().slice(0, MAX_EMOJI_UNITS), MAX_EMOJI_GRAPHEMES)
          : "",
      label: truncateGraphemes(label, MAX_LABEL_LENGTH),
      prompt: truncateCodePoints(prompt, MAX_PROMPT_LENGTH),
      hotkey,
    })
  }
  return out
}
