// Durable desktop UI state for the renderer: which repository tab is open and
// which thread each tab should reopen.
//
// This used to live in localStorage. WKWebView localStorage sits inside the app
// container, so a reinstall (and, depending on the update path, an update) wipes
// it — the user's tab selection and per-tab thread silently reset. The authority
// is now ~/.chunky/state/desktop.json, written by Bun with merge-on-write (see
// src/bun/desktopState.ts) through the RPC bridge in ./rpc.
//
// localStorage is kept as a MIRROR only: it is the fallback for the plain-browser
// build (no RPC) and the migration source the first time a desktop build runs
// after this change.

import { getRpc, nativeRpcAvailable } from "./rpc"
import { cleanQuickKeys, type QuickKey } from "./quickKeys"

export interface DesktopUiState {
  activeRepoId: string | null
  /** Repo id -> the session that tab reopens. */
  lastSessionByRepo: Record<string, string>
  /** Composer quick keys. Durable config: never mirrored to localStorage. */
  quickKeys: QuickKey[]
}

const ACTIVE_REPO_KEY = "chunky.activeRepoId"
const LAST_SESSION_KEY = "chunky.lastSessionByRepo"
/** Coalesce bursts (switching threads quickly) into one RPC round trip. */
const FLUSH_DELAY_MS = 150

function emptyState(): DesktopUiState {
  return { activeRepoId: null, lastSessionByRepo: {}, quickKeys: [] }
}

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage
  } catch {
    return null
  }
}

/** The pre-migration localStorage values, for the browser build and as the
 *  one-time seed for desktop.json. Never throws. */
export function readLegacyUiState(): DesktopUiState {
  const store = storage()
  if (!store) return emptyState()
  const state = emptyState()
  try {
    const active = store.getItem(ACTIVE_REPO_KEY)
    if (active) state.activeRepoId = active
  } catch {
    /* ignore */
  }
  try {
    const raw = store.getItem(LAST_SESSION_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : null
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const [repoId, sessionId] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof sessionId === "string" && sessionId) state.lastSessionByRepo[repoId] = sessionId
      }
    }
  } catch {
    /* corrupt value → ignore */
  }
  return state
}

// Only the two tab preferences are mirrored. Quick keys are user CONFIG, not a
// disposable UI preference, so desktop.json is their only home.
function mirrorToStorage(state: DesktopUiState): void {
  const store = storage()
  if (!store) return
  try {
    if (state.activeRepoId) store.setItem(ACTIVE_REPO_KEY, state.activeRepoId)
    else store.removeItem(ACTIVE_REPO_KEY)
    store.setItem(LAST_SESSION_KEY, JSON.stringify(state.lastSessionByRepo))
  } catch {
    /* quota/private mode → the durable copy is desktop.json anyway */
  }
}

// The in-memory view. Seeded synchronously from localStorage so callers that
// need a value before the RPC round trip resolves are no worse off than before.
let cached: DesktopUiState = emptyState()
let seeded = false
let loading: Promise<DesktopUiState> | null = null

function ensureSeed(): DesktopUiState {
  if (!seeded) {
    cached = readLegacyUiState()
    seeded = true
  }
  return cached
}

/** Synchronous best-known state (localStorage seed until the load resolves). */
export function desktopUiSnapshot(): DesktopUiState {
  return ensureSeed()
}

function parseState(value: unknown): DesktopUiState | null {
  if (!value || typeof value !== "object") return null
  const raw = value as { activeRepoId?: unknown; lastSessionByRepo?: unknown; quickKeys?: unknown }
  const state = emptyState()
  state.quickKeys = cleanQuickKeys(raw.quickKeys)
  if (typeof raw.activeRepoId === "string" && raw.activeRepoId) state.activeRepoId = raw.activeRepoId
  if (raw.lastSessionByRepo && typeof raw.lastSessionByRepo === "object") {
    for (const [repoId, sessionId] of Object.entries(raw.lastSessionByRepo as Record<string, unknown>)) {
      if (typeof sessionId === "string" && sessionId) state.lastSessionByRepo[repoId] = sessionId
    }
  }
  return state
}

/**
 * Load the durable state once per app session. On a desktop build with nothing
 * persisted yet, any legacy localStorage values are adopted and written through
 * — so an existing install keeps its open tab across the upgrade.
 */
export function loadDesktopUiState(): Promise<DesktopUiState> {
  if (loading) return loading
  const legacy = ensureSeed()
  loading = (async () => {
    if (!nativeRpcAvailable()) return legacy
    try {
      const rpc = await getRpc()
      const fn = rpc?.request?.desktopStateGet
      if (!fn) return legacy
      const durable = parseState(await fn())
      if (!durable) return legacy
      const empty =
        !durable.activeRepoId &&
        Object.keys(durable.lastSessionByRepo).length === 0 &&
        durable.quickKeys.length === 0
      if (empty) {
        // Nothing durable yet: migrate whatever the webview still remembers.
        const hasLegacy = !!legacy.activeRepoId || Object.keys(legacy.lastSessionByRepo).length > 0
        if (hasLegacy) {
          cached = legacy
          queue({ activeRepoId: legacy.activeRepoId, lastSessionByRepo: legacy.lastSessionByRepo })
        }
        return cached
      }
      cached = durable
      mirrorToStorage(cached)
      return cached
    } catch {
      return legacy
    }
  })()
  return loading
}

// ---- Writes ---------------------------------------------------------------

let pending: {
  activeRepoId?: string | null
  lastSessionByRepo?: Record<string, string>
  quickKeys?: QuickKey[]
} = {}
let flushTimer: ReturnType<typeof setTimeout> | null = null
let hideHooked = false

/** Quitting right after a click must not drop the debounced write. */
function hookPageHide(): void {
  if (hideHooked || typeof window === "undefined") return
  hideHooked = true
  window.addEventListener("pagehide", () => void flushDesktopUiState())
  window.addEventListener("beforeunload", () => void flushDesktopUiState())
}

function queue(patch: {
  activeRepoId?: string | null
  lastSessionByRepo?: Record<string, string>
  quickKeys?: QuickKey[]
}): void {
  pending = { ...pending, ...patch }
  if (!nativeRpcAvailable()) {
    pending = {}
    return
  }
  hookPageHide()
  if (flushTimer !== null) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    void flush()
  }, FLUSH_DELAY_MS)
}

async function flush(): Promise<void> {
  const patch = pending
  pending = {}
  if (Object.keys(patch).length === 0) return
  try {
    const rpc = await getRpc()
    const fn = rpc?.request?.desktopStateSet
    if (fn) await fn(patch)
  } catch {
    /* a lost UI preference must never surface as an error */
  }
}

/** Write any queued state immediately (e.g. before the window closes). */
export async function flushDesktopUiState(): Promise<void> {
  if (flushTimer !== null) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  await flush()
}

/** Remember which repository tab is open. `null` forgets it. */
export function rememberActiveRepo(repoId: string | null): void {
  const state = ensureSeed()
  if (state.activeRepoId === repoId) return
  state.activeRepoId = repoId
  mirrorToStorage(state)
  queue({ activeRepoId: repoId })
}

/** Remember the thread a repository tab should reopen. */
export function rememberLastSession(repoId: string, sessionId: string): void {
  if (!repoId || !sessionId) return
  const state = ensureSeed()
  if (state.lastSessionByRepo[repoId] === sessionId) return
  state.lastSessionByRepo[repoId] = sessionId
  mirrorToStorage(state)
  queue({ lastSessionByRepo: { ...state.lastSessionByRepo } })
}

/** Drop a repository's remembered thread (the repo was removed). */
export function forgetRepoSessions(repoId: string): void {
  const state = ensureSeed()
  if (!(repoId in state.lastSessionByRepo)) return
  delete state.lastSessionByRepo[repoId]
  mirrorToStorage(state)
  queue({ lastSessionByRepo: { ...state.lastSessionByRepo } })
}

/** Adopt a full map (used when the app rehydrates its in-memory copy). */
export function replaceLastSessions(map: Record<string, string>): void {
  const state = ensureSeed()
  state.lastSessionByRepo = { ...map }
  mirrorToStorage(state)
  queue({ lastSessionByRepo: { ...state.lastSessionByRepo } })
}

/** The quick keys last read from (or written to) desktop.json. */
export function quickKeysSnapshot(): QuickKey[] {
  return ensureSeed().quickKeys
}

/** Persist the whole quick-key list; the Bun writer merges it into the file. */
export function saveQuickKeys(keys: QuickKey[]): void {
  const state = ensureSeed()
  state.quickKeys = [...keys]
  queue({ quickKeys: state.quickKeys })
}

/** Test-only: forget the process cache and any queued write. */
export function resetDesktopUiStateForTest(): void {
  cached = emptyState()
  seeded = false
  loading = null
  pending = {}
  if (flushTimer !== null) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
}
