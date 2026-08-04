// Durable desktop UI state: ~/.chunky/state/desktop.json.
//
// The renderer's own storage (WKWebView localStorage) lives inside the app
// container, so it does not survive a reinstall and is not guaranteed across
// updates. Anything the user would notice losing — which repository tab is
// open, which thread each tab reopens — belongs here instead, next to the
// server's settings.json/repos.json in the desktop state directory.
//
// Writes are merge-on-write and atomic: read what is on disk, apply only the
// keys in the patch, publish with a temp file + rename so a reader never sees a
// truncated document and a concurrent writer's unrelated keys survive.
import { randomBytes } from "node:crypto"
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

/** Desktop-owned persistent state. Do not use the replaceable runtime directory. */
export function stateDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.CHUNKY_HOME || join(homedir(), ".chunky", "state")
}

export function desktopStatePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(stateDir(env), "desktop.json")
}

/** A composer quick key: an icon, a label, the prompt it sends, a hotkey. */
export interface DesktopQuickKey {
  id: string
  emoji: string
  label: string
  prompt: string
  /** Lowercase single letter, or "" for no hotkey. */
  hotkey: string
}

/** An explicit sidebar shelf choice for one session: the working list, or
 *  history. Watermarked with the session's `lastActivity` at the moment the
 *  choice was made, so the renderer can retire it once real work happens. */
export interface DesktopShelfPin {
  shelf: "settled" | "active"
  at: number
}

export interface DesktopState {
  /** The workspace the desktop last resolved a server for. */
  workspace?: string
  /** The repository tab the user had open. */
  activeRepoId?: string | null
  /** Repo id -> the session that tab should reopen. */
  lastSessionByRepo?: Record<string, string>
  /** User-configured composer quick keys, in display order. */
  quickKeys?: DesktopQuickKey[]
  /** Optional sidebar display name, overriding the git-derived one. Absent
   *  means "no override" — an empty value is deleted, never stored as "". */
  displayName?: string
  /** Session id -> the user's explicit shelf choice. Absent means the sidebar
   *  decides for itself. There is no server-side settled lifecycle, so this
   *  per-device pin is the only record of the choice. */
  sessionShelves?: Record<string, DesktopShelfPin>
}

/** Bounds so a malformed or hostile renderer can't grow the file without end. */
const MAX_ID_LENGTH = 128
const MAX_SESSION_ENTRIES = 500
const MAX_QUICK_KEYS = 24
// Quick-key text is bounded in GRAPHEMES: an emoji like 🧑‍💻 is five UTF-16 units
// and 👩‍👩‍👧‍👦 is eleven, so a unit cap would slice a ZWJ sequence into garbage.
const MAX_QUICK_KEY_EMOJI = 2
const MAX_QUICK_KEY_LABEL = 40
const MAX_QUICK_KEY_PROMPT = 4000
/** Absurdity guard applied before the (more expensive) grapheme pass. */
const MAX_QUICK_KEY_UNITS = 16_000
/** A sidebar name, bounded like a quick-key label — the same kind of short,
 *  human-facing string in a narrow row. Graphemes, so an emoji stays whole. */
const MAX_DISPLAY_NAME = 40

function cleanId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > MAX_ID_LENGTH) return undefined
  return trimmed
}

function cleanSessionMap(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const out: Record<string, string> = {}
  let count = 0
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (count >= MAX_SESSION_ENTRIES) break
    const repoId = cleanId(key)
    const sessionId = cleanId(raw)
    if (!repoId || !sessionId) continue
    out[repoId] = sessionId
    count++
  }
  return out
}

/** Keep the well-formed shelf pins, drop the rest. Bounded like the session
 *  map: a pin is one small row per session the user has filed by hand. */
function cleanShelfPins(value: unknown): Record<string, DesktopShelfPin> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const out: Record<string, DesktopShelfPin> = {}
  let count = 0
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (count >= MAX_SESSION_ENTRIES) break
    const sessionId = cleanId(key)
    if (!sessionId || !raw || typeof raw !== "object" || Array.isArray(raw)) continue
    const pin = raw as Record<string, unknown>
    if (pin.shelf !== "settled" && pin.shelf !== "active") continue
    // A missing/rubbish watermark reads as 0, which makes the pin retire on the
    // session's next observed activity rather than sticking forever.
    const at = typeof pin.at === "number" && Number.isFinite(pin.at) ? Math.max(0, Math.floor(pin.at)) : 0
    out[sessionId] = { shelf: pin.shelf, at }
    count++
  }
  return out
}

const graphemeSegmenter =
  typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : null

/** Trim and bound by user-perceived character, never mid-emoji. */
function cleanText(value: unknown, max: number): string {
  if (typeof value !== "string") return ""
  const trimmed = value.trim().slice(0, MAX_QUICK_KEY_UNITS)
  const parts = graphemeSegmenter
    ? Array.from(graphemeSegmenter.segment(trimmed), (part) => part.segment)
    : Array.from(trimmed)
  return parts.length <= max ? trimmed : parts.slice(0, max).join("")
}

/**
 * Normalise a display-name override: control characters and every whitespace
 * run (tabs, newlines pasted in from anywhere) fold to a single space, the ends
 * are trimmed, and the result is bounded in graphemes. "" means "no override",
 * which the reader and the merge both treat as absence.
 */
function cleanDisplayName(value: unknown): string {
  if (typeof value !== "string") return ""
  const folded = value
    .slice(0, MAX_QUICK_KEY_UNITS)
    // biome-ignore lint/suspicious/noControlCharactersInRegex: folding them is the point
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
  return cleanText(folded, MAX_DISPLAY_NAME)
}

/** Keep the well-formed quick keys, drop the rest; ids and hotkeys are unique. */
function cleanQuickKeys(value: unknown): DesktopQuickKey[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out: DesktopQuickKey[] = []
  const ids = new Set<string>()
  const hotkeys = new Set<string>()
  for (const raw of value) {
    if (out.length >= MAX_QUICK_KEYS) break
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue
    const item = raw as Record<string, unknown>
    const id = cleanId(item.id)
    const label = cleanText(item.label, MAX_QUICK_KEY_LABEL)
    const prompt = cleanText(item.prompt, MAX_QUICK_KEY_PROMPT)
    if (!id || ids.has(id) || !label || !prompt) continue
    const letter = cleanText(item.hotkey, 1).toLowerCase()
    const hotkey = /^[a-z]$/.test(letter) && !hotkeys.has(letter) ? letter : ""
    if (hotkey) hotkeys.add(hotkey)
    ids.add(id)
    out.push({ id, emoji: cleanText(item.emoji, MAX_QUICK_KEY_EMOJI), label, prompt, hotkey })
  }
  return out
}

/** Parse whatever is on disk, tolerating absence, corruption and stray keys. */
export function readDesktopState(env: NodeJS.ProcessEnv = process.env): DesktopState {
  try {
    const parsed: unknown = JSON.parse(readFileSync(desktopStatePath(env), "utf8"))
    if (!parsed || typeof parsed !== "object") return {}
    const raw = parsed as Record<string, unknown>
    const state: DesktopState = {}
    if (typeof raw.workspace === "string" && raw.workspace) state.workspace = raw.workspace
    const activeRepoId = cleanId(raw.activeRepoId)
    if (activeRepoId) state.activeRepoId = activeRepoId
    const sessions = cleanSessionMap(raw.lastSessionByRepo)
    if (sessions) state.lastSessionByRepo = sessions
    const quickKeys = cleanQuickKeys(raw.quickKeys)
    if (quickKeys && quickKeys.length > 0) state.quickKeys = quickKeys
    const displayName = cleanDisplayName(raw.displayName)
    if (displayName) state.displayName = displayName
    const sessionShelves = cleanShelfPins(raw.sessionShelves)
    if (sessionShelves && Object.keys(sessionShelves).length > 0) state.sessionShelves = sessionShelves
    return state
  } catch {
    return {}
  }
}

/**
 * Apply `patch` on top of the current file and publish it atomically. Keys that
 * are absent from the patch are left untouched; `activeRepoId: null` clears the
 * remembered tab. Returns the merged state (or the unchanged state on failure —
 * losing a UI preference must never take the app down).
 */
export function mergeDesktopState(
  patch: DesktopState,
  env: NodeJS.ProcessEnv = process.env,
): DesktopState {
  const current = readDesktopState(env)
  const next: DesktopState = { ...current }

  if (patch.workspace !== undefined) {
    if (typeof patch.workspace === "string" && patch.workspace) next.workspace = patch.workspace
  }
  if (patch.activeRepoId !== undefined) {
    const id = cleanId(patch.activeRepoId)
    if (id) next.activeRepoId = id
    else delete next.activeRepoId
  }
  if (patch.lastSessionByRepo !== undefined) {
    const sessions = cleanSessionMap(patch.lastSessionByRepo)
    if (sessions && Object.keys(sessions).length > 0) next.lastSessionByRepo = sessions
    else delete next.lastSessionByRepo
  }
  if (patch.quickKeys !== undefined) {
    const quickKeys = cleanQuickKeys(patch.quickKeys)
    if (quickKeys && quickKeys.length > 0) next.quickKeys = quickKeys
    else delete next.quickKeys
  }
  if (patch.displayName !== undefined) {
    // Empty (or whitespace-only) clears the override, restoring the git name.
    const displayName = cleanDisplayName(patch.displayName)
    if (displayName) next.displayName = displayName
    else delete next.displayName
  }
  if (patch.sessionShelves !== undefined) {
    // The renderer owns the whole map, so a patch replaces it wholesale; an
    // empty map means "nothing is pinned" and is stored as absence.
    const shelves = cleanShelfPins(patch.sessionShelves)
    if (shelves && Object.keys(shelves).length > 0) next.sessionShelves = shelves
    else delete next.sessionShelves
  }

  const path = desktopStatePath(env)
  const temporary = `${path}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`
  try {
    mkdirSync(stateDir(env), { recursive: true })
    try {
      writeFileSync(temporary, JSON.stringify(next, null, 2), { mode: 0o600 })
      renameSync(temporary, path)
    } catch (err) {
      rmSync(temporary, { force: true })
      throw err
    }
    return next
  } catch {
    return current
  }
}
