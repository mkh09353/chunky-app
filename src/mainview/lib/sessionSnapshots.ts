// Durable per-session transcript snapshots, renderer half.
//
// The in-memory LRU in ./sessionCache.ts dies with the window, so a relaunch
// has nothing to paint until the server has replayed the session's history.
// This module persists the last-seen projection and the cursor it sits at
// through Bun (see src/bun/sessionSnapshots.ts), which owns the files —
// localStorage/IndexedDB are inside the app container and are not durable.
//
// Saving is a side effect of drawing, so `saveSessionSnapshot` is debounced per
// session (trailing, latest wins) and NEVER throws or rejects: a lost cache
// entry only costs the replay it was avoiding.

import type { SessionEventCursor } from "@chunky/protocol"
import { getRpc, nativeRpcAvailable } from "./rpc"
import type { TranscriptState } from "./transcript"

/** What one relaunch needs to paint a session and resume its stream. Holds only
 *  transcript content and stream position — never connection details, tokens or
 *  server URLs, which stay in Bun. */
export interface SessionSnapshot {
  version: 1
  transcript: TranscriptState
  /** Decoded stream cursor the projection sits at, or null for "replay". */
  cursor: SessionEventCursor | null
  /** Where the "load older" pager had reached, if anywhere. */
  olderPage: { before: string | null; hasMore: boolean } | null
  savedAt: number
}

/** Coalesce a burst of projection ticks (a streaming turn) into one write. */
const FLUSH_DELAY_MS = 500

/** The RPC surface this module uses, so tests can stand in for the bridge. */
export interface SessionSnapshotTransport {
  load(sessionId: string): Promise<unknown>
  save(sessionId: string, snapshot: SessionSnapshot): Promise<unknown>
  remove(sessionId: string): Promise<unknown>
}

const nativeTransport: SessionSnapshotTransport = {
  load: async (sessionId) => {
    const rpc = await getRpc()
    const fn = rpc?.request?.sessionSnapshotLoad
    return fn ? await fn({ sessionId }) : null
  },
  save: async (sessionId, snapshot) => {
    const rpc = await getRpc()
    const fn = rpc?.request?.sessionSnapshotSave
    return fn ? await fn({ sessionId, snapshot }) : null
  },
  remove: async (sessionId) => {
    const rpc = await getRpc()
    const fn = rpc?.request?.sessionSnapshotDelete
    return fn ? await fn({ sessionId }) : null
  },
}

let transport: SessionSnapshotTransport = nativeTransport
let available: () => boolean = nativeRpcAvailable
let loggedFailure = false

function note(what: string, error: unknown): void {
  if (loggedFailure) return
  loggedFailure = true
  console.warn(`[snapshots] ${what} failed; transcript snapshots disabled for this window`, error)
}

// ---- Reads ----------------------------------------------------------------

function parseSnapshot(value: unknown): SessionSnapshot | null {
  if (!value || typeof value !== "object") return null
  const envelope = value as { snapshot?: unknown }
  const raw = (envelope.snapshot ?? null) as Record<string, unknown> | null
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null
  if (raw.version !== 1) return null
  const transcript = raw.transcript
  if (!transcript || typeof transcript !== "object" || Array.isArray(transcript)) return null

  const cursorRaw = raw.cursor as Record<string, unknown> | null | undefined
  const cursor =
    cursorRaw && typeof cursorRaw === "object" &&
    typeof cursorRaw.generation === "string" &&
    typeof cursorRaw.nextSeq === "number"
      ? { generation: cursorRaw.generation, nextSeq: cursorRaw.nextSeq }
      : null

  const pageRaw = raw.olderPage as Record<string, unknown> | null | undefined
  const olderPage =
    pageRaw && typeof pageRaw === "object"
      ? {
          before: typeof pageRaw.before === "string" ? pageRaw.before : null,
          hasMore: pageRaw.hasMore === true,
        }
      : null

  return {
    version: 1,
    transcript: transcript as TranscriptState,
    cursor,
    olderPage,
    savedAt: typeof raw.savedAt === "number" ? raw.savedAt : 0,
  }
}

/** The last snapshot written for this session, or null when there is none (no
 *  bridge, missing file, corrupt file, older version). Never rejects. */
export async function loadSessionSnapshot(sessionId: string): Promise<SessionSnapshot | null> {
  if (!sessionId || !available()) return null
  // A pending write is newer than anything on disk; publish it first so a
  // reattach during the debounce window cannot read a stale tail.
  const queued = pending.get(sessionId)
  if (queued) return queued
  try {
    return parseSnapshot(await transport.load(sessionId))
  } catch (error) {
    note("snapshot load", error)
    return null
  }
}

// ---- Writes ---------------------------------------------------------------

const pending = new Map<string, SessionSnapshot>()
let flushTimer: ReturnType<typeof setTimeout> | null = null
let inFlight: Promise<void> = Promise.resolve()
let hideHooked = false

/** Quitting mid-turn must not drop the debounced write. */
function hookPageHide(): void {
  if (hideHooked || typeof window === "undefined") return
  hideHooked = true
  window.addEventListener("pagehide", () => void flushSessionSnapshots())
  window.addEventListener("beforeunload", () => void flushSessionSnapshots())
}

/** Persist a session's snapshot. Safe to call on every projection tick: writes
 *  are coalesced per session (latest wins) and errors are swallowed. */
export async function saveSessionSnapshot(sessionId: string, snapshot: SessionSnapshot): Promise<void> {
  if (!sessionId || !snapshot || !available()) return
  pending.set(sessionId, snapshot)
  hookPageHide()
  if (flushTimer !== null) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    void flush()
  }, FLUSH_DELAY_MS)
}

async function flush(): Promise<void> {
  if (pending.size === 0) return
  const batch = [...pending.entries()]
  pending.clear()
  // Serialised behind the previous flush: two writes for one session must not
  // race, or the older projection could land last.
  inFlight = inFlight.then(async () => {
    for (const [sessionId, snapshot] of batch) {
      try {
        await transport.save(sessionId, snapshot)
      } catch (error) {
        note("snapshot save", error)
      }
    }
  })
  await inFlight
}

/** Write anything queued immediately (pagehide/beforeunload, or before the
 *  renderer hands a session off). Never rejects. */
export async function flushSessionSnapshots(): Promise<void> {
  if (flushTimer !== null) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  try {
    await flush()
    await inFlight
  } catch (error) {
    note("snapshot flush", error)
  }
}

/** Forget a session's snapshot (deleted or rewound session). Never rejects. */
export async function deleteSessionSnapshot(sessionId: string): Promise<void> {
  if (!sessionId) return
  pending.delete(sessionId)
  if (!available()) return
  try {
    await transport.remove(sessionId)
  } catch (error) {
    note("snapshot delete", error)
  }
}

/** Tests only: stand in for the native RPC bridge and clear queued state. */
export function setSessionSnapshotTransportForTest(
  next: SessionSnapshotTransport | null,
  isAvailable: () => boolean = () => next !== null,
): void {
  transport = next ?? nativeTransport
  available = next ? isAvailable : nativeRpcAvailable
  pending.clear()
  if (flushTimer !== null) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  inFlight = Promise.resolve()
  loggedFailure = false
}
