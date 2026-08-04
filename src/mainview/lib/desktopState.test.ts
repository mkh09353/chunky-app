// The renderer half of durable UI state. Without the native RPC bridge (the
// plain-browser build, and this test environment) it must behave exactly as the
// old localStorage code did — that fallback is also the migration source the
// first time a desktop build reads desktop.json.
import { beforeEach, describe, expect, test } from "bun:test"

/** In-memory stand-in for localStorage. */
function fakeStorage(initial: Record<string, string> = {}) {
  const data: Record<string, string> = { ...initial }
  return {
    data,
    getItem: (key: string) => (key in data ? data[key]! : null),
    setItem: (key: string, value: string) => {
      data[key] = value
    },
    removeItem: (key: string) => {
      delete data[key]
    },
  }
}

const ACTIVE_REPO_KEY = "chunky.activeRepoId"
const LAST_SESSION_KEY = "chunky.lastSessionByRepo"

let store = fakeStorage()
;(globalThis as { localStorage?: unknown }).localStorage = store

const {
  desktopUiSnapshot,
  flushDesktopUiState,
  forgetRepoSessions,
  loadDesktopUiState,
  quickKeysSnapshot,
  readLegacyUiState,
  rememberActiveRepo,
  rememberLastSession,
  replaceLastSessions,
  resetDesktopUiStateForTest,
  saveQuickKeys,
} = await import("./desktopState")

function reset(initial: Record<string, string> = {}) {
  store = fakeStorage(initial)
  ;(globalThis as { localStorage?: unknown }).localStorage = store
  resetDesktopUiStateForTest()
}

beforeEach(() => reset())

describe("legacy localStorage values", () => {
  test("are read as the seed for migration", () => {
    reset({
      [ACTIVE_REPO_KEY]: "r1",
      [LAST_SESSION_KEY]: JSON.stringify({ r1: "s1", r2: "s2" }),
    })
    expect(readLegacyUiState()).toEqual({
      activeRepoId: "r1",
      lastSessionByRepo: { r1: "s1", r2: "s2" },
      quickKeys: [],
    })
    expect(desktopUiSnapshot().activeRepoId).toBe("r1")
  })

  test("survive corruption and absence", () => {
    reset({ [LAST_SESSION_KEY]: "{not json" })
    expect(readLegacyUiState()).toEqual({ activeRepoId: null, lastSessionByRepo: {}, quickKeys: [] })
    reset({ [LAST_SESSION_KEY]: JSON.stringify({ r1: 7, r2: "s2" }) })
    expect(readLegacyUiState().lastSessionByRepo).toEqual({ r2: "s2" })
  })
})

describe("without the native bridge", () => {
  test("loading falls back to the legacy values", async () => {
    reset({ [ACTIVE_REPO_KEY]: "r9" })
    await expect(loadDesktopUiState()).resolves.toEqual({
      activeRepoId: "r9",
      lastSessionByRepo: {},
      quickKeys: [],
    })
  })

  test("writes still mirror to localStorage so the browser build is unchanged", async () => {
    rememberActiveRepo("r1")
    rememberLastSession("r1", "s1")
    rememberLastSession("r2", "s2")

    expect(store.data[ACTIVE_REPO_KEY]).toBe("r1")
    expect(JSON.parse(store.data[LAST_SESSION_KEY]!)).toEqual({ r1: "s1", r2: "s2" })
    // No RPC available → nothing is queued and flushing is a no-op.
    await expect(flushDesktopUiState()).resolves.toBeUndefined()
  })

  test("forgetting a repo drops only its thread", () => {
    rememberLastSession("r1", "s1")
    rememberLastSession("r2", "s2")
    forgetRepoSessions("r1")
    expect(desktopUiSnapshot().lastSessionByRepo).toEqual({ r2: "s2" })
    expect(JSON.parse(store.data[LAST_SESSION_KEY]!)).toEqual({ r2: "s2" })
  })

  test("clearing the active repo removes it rather than storing an empty value", () => {
    rememberActiveRepo("r1")
    rememberActiveRepo(null)
    expect(ACTIVE_REPO_KEY in store.data).toBe(false)
    expect(desktopUiSnapshot().activeRepoId).toBeNull()
  })

  test("replacing the session map adopts it wholesale", () => {
    rememberLastSession("r1", "s1")
    replaceLastSessions({ r3: "s3" })
    expect(desktopUiSnapshot().lastSessionByRepo).toEqual({ r3: "s3" })
  })

  test("ignores empty ids", () => {
    rememberLastSession("", "s1")
    rememberLastSession("r1", "")
    expect(desktopUiSnapshot().lastSessionByRepo).toEqual({})
  })
})

describe("quick keys", () => {
  const chip = { id: "qk-1", emoji: "🚢", label: "Ship it!", prompt: "ship it", hotkey: "d" }

  test("start empty and read back what was saved", () => {
    expect(quickKeysSnapshot()).toEqual([])
    saveQuickKeys([chip])
    expect(quickKeysSnapshot()).toEqual([chip])
    expect(desktopUiSnapshot().quickKeys).toEqual([chip])
  })

  test("are never mirrored into localStorage — desktop.json owns them", () => {
    saveQuickKeys([chip])
    rememberActiveRepo("r1")
    expect(JSON.stringify(store.data)).not.toContain("Ship it!")
  })

  test("a later save replaces the list wholesale", () => {
    saveQuickKeys([chip])
    saveQuickKeys([])
    expect(quickKeysSnapshot()).toEqual([])
  })
})
