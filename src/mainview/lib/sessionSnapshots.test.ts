// The renderer half of the transcript snapshot store: coalesced per-session
// writes (latest wins), a forced flush for pagehide, and total silence on
// failure — a lost snapshot only costs the replay it was avoiding.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { TranscriptState } from "./transcript"
import {
  deleteSessionSnapshot,
  flushSessionSnapshots,
  loadSessionSnapshot,
  saveSessionSnapshot,
  setSessionSnapshotTransportForTest,
  type SessionSnapshot,
} from "./sessionSnapshots"

const transcript = { order: ["main"], threads: {} } as unknown as TranscriptState

function snapshot(savedAt: number, order: string[] = ["main"]): SessionSnapshot {
  return {
    version: 1,
    transcript: { ...transcript, order } as TranscriptState,
    cursor: { generation: "g1", nextSeq: savedAt },
    olderPage: null,
    savedAt,
  }
}

type Call = { sessionId: string; snapshot: SessionSnapshot }

let saves: Call[] = []
let removes: string[] = []
let loadResult: unknown = null
let failWith: Error | null = null

function install(): void {
  saves = []
  removes = []
  failWith = null
  loadResult = null
  setSessionSnapshotTransportForTest({
    load: async (sessionId) => {
      if (failWith) throw failWith
      void sessionId
      return loadResult
    },
    save: async (sessionId, value) => {
      if (failWith) throw failWith
      saves.push({ sessionId, snapshot: value })
      return { ok: true }
    },
    remove: async (sessionId) => {
      if (failWith) throw failWith
      removes.push(sessionId)
      return { ok: true }
    },
  })
}

beforeEach(install)
afterEach(() => setSessionSnapshotTransportForTest(null))

describe("loading", () => {
  test("parses the Bun envelope", async () => {
    loadResult = {
      ok: true,
      snapshot: {
        version: 1,
        savedAt: 7,
        transcript,
        cursor: { generation: "g1", nextSeq: 4 },
        olderPage: { before: "c", hasMore: true },
      },
    }
    expect(await loadSessionSnapshot("s1")).toEqual({
      version: 1,
      transcript,
      cursor: { generation: "g1", nextSeq: 4 },
      olderPage: { before: "c", hasMore: true },
      savedAt: 7,
    })
  })

  test("absent, mismatched and malformed payloads read as null", async () => {
    loadResult = { ok: true, snapshot: null }
    expect(await loadSessionSnapshot("s1")).toBeNull()
    loadResult = { ok: true, snapshot: { version: 2, transcript, savedAt: 1 } }
    expect(await loadSessionSnapshot("s1")).toBeNull()
    loadResult = { ok: true, snapshot: { version: 1, savedAt: 1 } }
    expect(await loadSessionSnapshot("s1")).toBeNull()
    loadResult = "nonsense"
    expect(await loadSessionSnapshot("s1")).toBeNull()
    expect(await loadSessionSnapshot("")).toBeNull()
  })

  test("a cursor or older-page of the wrong shape degrades to null", async () => {
    loadResult = {
      ok: true,
      snapshot: { version: 1, savedAt: 1, transcript, cursor: { generation: 4 }, olderPage: { hasMore: "yes" } },
    }
    expect(await loadSessionSnapshot("s1")).toEqual({
      version: 1,
      transcript,
      cursor: null,
      olderPage: { before: null, hasMore: false },
      savedAt: 1,
    })
  })

  test("returns the still-queued snapshot rather than the older file", async () => {
    loadResult = { ok: true, snapshot: { version: 1, savedAt: 1, transcript } }
    await saveSessionSnapshot("s1", snapshot(5, ["main", "t2"]))
    const loaded = await loadSessionSnapshot("s1")
    expect(loaded?.savedAt).toBe(5)
    await flushSessionSnapshots()
  })

  test("a throwing bridge reads as null", async () => {
    failWith = new Error("bridge down")
    expect(await loadSessionSnapshot("s1")).toBeNull()
  })

  test("no native bridge means no snapshots", async () => {
    setSessionSnapshotTransportForTest(null, () => false)
    expect(await loadSessionSnapshot("s1")).toBeNull()
  })
})

describe("saving", () => {
  test("is debounced per session, and the latest write wins", async () => {
    await saveSessionSnapshot("s1", snapshot(1))
    await saveSessionSnapshot("s1", snapshot(2))
    await saveSessionSnapshot("s1", snapshot(3, ["main", "t9"]))
    expect(saves).toEqual([])

    await flushSessionSnapshots()
    expect(saves.length).toBe(1)
    expect(saves[0]!.sessionId).toBe("s1")
    expect(saves[0]!.snapshot.savedAt).toBe(3)
    expect(saves[0]!.snapshot.transcript.order).toEqual(["main", "t9"])
  })

  test("keeps the newest snapshot of each session in one flush", async () => {
    await saveSessionSnapshot("s1", snapshot(1))
    await saveSessionSnapshot("s2", snapshot(2))
    await saveSessionSnapshot("s1", snapshot(3))
    await flushSessionSnapshots()
    expect(saves.map((call) => [call.sessionId, call.snapshot.savedAt])).toEqual([
      ["s1", 3],
      ["s2", 2],
    ])
  })

  test("the trailing timer writes without an explicit flush", async () => {
    await saveSessionSnapshot("s1", snapshot(1))
    await new Promise((resolve) => setTimeout(resolve, 700))
    expect(saves.map((call) => call.snapshot.savedAt)).toEqual([1])
  })

  test("flushing with nothing queued is a no-op", async () => {
    await flushSessionSnapshots()
    expect(saves).toEqual([])
  })

  test("a failing write never rejects the caller", async () => {
    await saveSessionSnapshot("s1", snapshot(1))
    failWith = new Error("disk full")
    await expect(flushSessionSnapshots()).resolves.toBeUndefined()
  })

  test("saving without a native bridge is dropped, not queued", async () => {
    setSessionSnapshotTransportForTest(null, () => false)
    await expect(saveSessionSnapshot("s1", snapshot(1))).resolves.toBeUndefined()
    await flushSessionSnapshots()
    expect(saves).toEqual([])
  })
})

describe("deleting", () => {
  test("drops the queued write and forgets the file", async () => {
    await saveSessionSnapshot("s1", snapshot(1))
    await deleteSessionSnapshot("s1")
    await flushSessionSnapshots()
    expect(saves).toEqual([])
    expect(removes).toEqual(["s1"])
  })

  test("never rejects", async () => {
    failWith = new Error("gone")
    await expect(deleteSessionSnapshot("s1")).resolves.toBeUndefined()
  })
})
