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

export interface DesktopState {
  /** The workspace the desktop last resolved a server for. */
  workspace?: string
  /** The repository tab the user had open. */
  activeRepoId?: string | null
  /** Repo id -> the session that tab should reopen. */
  lastSessionByRepo?: Record<string, string>
}

/** Bounds so a malformed or hostile renderer can't grow the file without end. */
const MAX_ID_LENGTH = 128
const MAX_SESSION_ENTRIES = 500

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
