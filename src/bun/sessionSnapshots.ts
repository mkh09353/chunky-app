// Durable per-session transcript snapshots: ~/.chunky/state/session-snapshots/.
//
// A relaunch should paint the last-seen transcript tail immediately and resume
// the server's event stream from the cursor it left off at, instead of waiting
// for a full history replay. The renderer's own storage (WKWebView
// localStorage) lives inside the app container and does not survive a
// reinstall, and the runtime directory (~/.chunky/app) is replaced wholesale on
// upgrade — so, like desktop.json, these files live in the desktop state
// directory next to the server's settings.
//
// One JSON file per session. Writes are atomic (temp file + rename) so a reader
// never sees a truncated document; reads tolerate absence, corruption and a
// version bump by returning null, because a missing snapshot only costs a
// replay. The store keeps the payload opaque: the transcript projection is the
// renderer's shape and is never interpreted here.
import { createHash, randomBytes } from "node:crypto"
import {
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { join } from "node:path"
import { stateDir } from "./desktopState"

/** The on-disk envelope. `transcript`, `cursor` and `olderPage` are renderer
 *  shapes and are stored verbatim; only the envelope is validated here. */
export interface StoredSessionSnapshot {
  version: 1
  /** Epoch ms of the write. Also the eviction order. */
  savedAt: number
  transcript: unknown
  cursor: unknown
  olderPage: unknown
}

export const SNAPSHOT_VERSION = 1
/** Snapshots are a cache, not an archive: bound the directory. */
const MAX_SNAPSHOTS = 50
/** A projection this large is pathological; replaying is cheaper than storing. */
const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024
/** Enough to cover the `{"version":1,"savedAt":...` prefix we always write. */
const HEADER_BYTES = 128

export function snapshotDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(stateDir(env), "session-snapshots")
}

/**
 * Where one session's snapshot lives. Session ids come from the server and are
 * not guaranteed to be path-safe, so the name is a sanitised prefix (so the
 * directory stays greppable by a human) plus a hash of the full id (so two
 * distinct ids can never collide on one file).
 */
export function snapshotPath(sessionId: string, env: NodeJS.ProcessEnv = process.env): string {
  const safe = sessionId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 48)
  const digest = createHash("sha256").update(sessionId).digest("hex").slice(0, 12)
  return join(snapshotDir(env), `${safe}-${digest}.json`)
}

/** Parse whatever is on disk. Missing, corrupt, malformed or written by a
 *  future/previous version all read as null: the caller simply replays. */
export function readSessionSnapshot(
  sessionId: string,
  env: NodeJS.ProcessEnv = process.env,
): StoredSessionSnapshot | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(snapshotPath(sessionId, env), "utf8"))
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
    const raw = parsed as Record<string, unknown>
    if (raw.version !== SNAPSHOT_VERSION) return null
    if (!raw.transcript || typeof raw.transcript !== "object") return null
    const savedAt =
      typeof raw.savedAt === "number" && Number.isFinite(raw.savedAt)
        ? Math.max(0, Math.floor(raw.savedAt))
        : 0
    return {
      version: SNAPSHOT_VERSION,
      savedAt,
      transcript: raw.transcript,
      cursor: raw.cursor ?? null,
      olderPage: raw.olderPage ?? null,
    }
  } catch {
    return null
  }
}

export type SnapshotWriteResult =
  | { ok: true }
  | { ok: false; reason: "too-large" | "write-failed" | "invalid" }

let warnedOversize = false

/**
 * Publish one session's snapshot atomically, then evict the oldest files if the
 * directory has outgrown its cap. Failure is reported, never thrown: losing a
 * paint-ahead cache must not surface anywhere the user can see it.
 */
export function writeSessionSnapshot(
  sessionId: string,
  snapshot: { transcript: unknown; cursor?: unknown; olderPage?: unknown; savedAt?: unknown },
  env: NodeJS.ProcessEnv = process.env,
): SnapshotWriteResult {
  if (!sessionId || typeof sessionId !== "string") return { ok: false, reason: "invalid" }
  if (!snapshot || typeof snapshot !== "object" || !snapshot.transcript) {
    return { ok: false, reason: "invalid" }
  }
  const savedAt =
    typeof snapshot.savedAt === "number" && Number.isFinite(snapshot.savedAt)
      ? Math.max(0, Math.floor(snapshot.savedAt))
      : Date.now()
  // `version` and `savedAt` are serialised first on purpose: eviction reads only
  // the first bytes of each file rather than parsing megabytes of transcript.
  const body = JSON.stringify({
    version: SNAPSHOT_VERSION,
    savedAt,
    transcript: snapshot.transcript,
    cursor: snapshot.cursor ?? null,
    olderPage: snapshot.olderPage ?? null,
  })
  if (!body) return { ok: false, reason: "invalid" }
  if (Buffer.byteLength(body, "utf8") > MAX_SNAPSHOT_BYTES) {
    if (!warnedOversize) {
      warnedOversize = true
      console.warn(
        `[snapshots] transcript snapshot exceeds ${MAX_SNAPSHOT_BYTES} bytes; skipping (further occurrences silent)`,
      )
    }
    return { ok: false, reason: "too-large" }
  }

  const path = snapshotPath(sessionId, env)
  const temporary = `${path}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`
  try {
    mkdirSync(snapshotDir(env), { recursive: true })
    try {
      writeFileSync(temporary, body, { mode: 0o600 })
      renameSync(temporary, path)
    } catch (err) {
      rmSync(temporary, { force: true })
      throw err
    }
  } catch {
    return { ok: false, reason: "write-failed" }
  }
  evictOldest(env)
  return { ok: true }
}

export function deleteSessionSnapshot(sessionId: string, env: NodeJS.ProcessEnv = process.env): void {
  try {
    unlinkSync(snapshotPath(sessionId, env))
  } catch {
    /* already gone, or never written */
  }
}

/** `savedAt` without parsing the whole document: read the header only, and fall
 *  back to the file's mtime if the prefix is not what we write. */
function savedAtOf(path: string): number {
  let fd: number | null = null
  try {
    fd = openSync(path, "r")
    const buffer = Buffer.alloc(HEADER_BYTES)
    const read = readSync(fd, buffer, 0, HEADER_BYTES, 0)
    const header = buffer.subarray(0, read).toString("utf8")
    const match = /"savedAt"\s*:\s*(\d+)/.exec(header)
    if (match) return Number(match[1])
  } catch {
    /* fall through to the mtime */
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {
        /* nothing to do */
      }
    }
  }
  try {
    return statSync(path).mtimeMs
  } catch {
    return 0
  }
}

/** Keep the newest MAX_SNAPSHOTS files; drop the rest, oldest first. */
function evictOldest(env: NodeJS.ProcessEnv = process.env): void {
  try {
    const dir = snapshotDir(env)
    const files = readdirSync(dir).filter((name) => name.endsWith(".json"))
    if (files.length <= MAX_SNAPSHOTS) return
    const ranked = files
      .map((name) => ({ name, savedAt: savedAtOf(join(dir, name)) }))
      .sort((a, b) => b.savedAt - a.savedAt || (a.name < b.name ? -1 : 1))
    for (const stale of ranked.slice(MAX_SNAPSHOTS)) {
      try {
        unlinkSync(join(dir, stale.name))
      } catch {
        /* another window may have evicted it already */
      }
    }
  } catch {
    /* an un-evicted cache is not a failure worth reporting */
  }
}

/** Tests only: the oversize warning is deliberately once-per-process. */
export function resetSnapshotWarningForTest(): void {
  warnedOversize = false
}
