// Per-session transcript snapshots on disk: atomic writes, tolerant reads, a
// bounded directory and a size cap. Losing a snapshot only costs a replay, so
// every failure path must read as "no snapshot" rather than throwing.
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  deleteSessionSnapshot,
  readSessionSnapshot,
  resetSnapshotWarningForTest,
  snapshotDir,
  snapshotPath,
  writeSessionSnapshot,
} from "./sessionSnapshots"

const dirs: string[] = []

function temp(): NodeJS.ProcessEnv {
  const dir = mkdtempSync(join(tmpdir(), "chunky-session-snapshots-"))
  dirs.push(dir)
  return { CHUNKY_HOME: dir } as NodeJS.ProcessEnv
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  resetSnapshotWarningForTest()
})

const transcript = { order: ["main"], threads: {}, status: "idle" }

describe("location", () => {
  test("lives in the desktop state directory, not the replaceable runtime", () => {
    const env = temp()
    expect(snapshotDir(env)).toBe(join(env.CHUNKY_HOME!, "session-snapshots"))
    expect(snapshotDir({} as NodeJS.ProcessEnv)).toMatch(/\.chunky\/state\/session-snapshots$/)
    expect(snapshotPath("s1", env).startsWith(snapshotDir(env))).toBe(true)
  })

  test("path-hostile session ids cannot escape the directory or collide", () => {
    const env = temp()
    const evil = snapshotPath("../../etc/passwd", env)
    // The separators are gone, so the name cannot climb out of the directory.
    expect(evil.slice(snapshotDir(env).length + 1).includes("/")).toBe(false)
    expect(join(evil, "..")).toBe(snapshotDir(env))
    expect(snapshotPath("a/b", env)).not.toBe(snapshotPath("a_b", env))
  })
})

describe("writing and reading", () => {
  test("round-trips the envelope and leaves no temp files behind", () => {
    const env = temp()
    expect(
      writeSessionSnapshot(
        "s1",
        {
          transcript,
          cursor: { generation: "g1", nextSeq: 4 },
          olderPage: { before: "c", hasMore: true },
          savedAt: 111,
        },
        env,
      ),
    ).toEqual({ ok: true })

    expect(readSessionSnapshot("s1", env)).toEqual({
      version: 1,
      savedAt: 111,
      transcript,
      cursor: { generation: "g1", nextSeq: 4 },
      olderPage: { before: "c", hasMore: true },
    })
    expect(readdirSync(snapshotDir(env)).filter((n) => n.endsWith(".tmp"))).toEqual([])
    // version + savedAt lead the document so eviction can read a header only.
    expect(readFileSync(snapshotPath("s1", env), "utf8").startsWith('{"version":1,"savedAt":111,')).toBe(true)
  })

  test("a later write replaces the earlier one", () => {
    const env = temp()
    writeSessionSnapshot("s1", { transcript, savedAt: 1 }, env)
    writeSessionSnapshot("s1", { transcript: { order: ["main", "t2"] }, savedAt: 2 }, env)
    const read = readSessionSnapshot("s1", env)
    expect(read?.savedAt).toBe(2)
    expect(read?.transcript).toEqual({ order: ["main", "t2"] })
  })

  test("missing, corrupt, malformed and version-mismatched files read as null", () => {
    const env = temp()
    expect(readSessionSnapshot("nope", env)).toBeNull()

    writeSessionSnapshot("s1", { transcript, savedAt: 1 }, env)
    const path = snapshotPath("s1", env)

    writeFileSync(path, '{"version":1,"savedAt":1,"transcript":{"order":[')
    expect(readSessionSnapshot("s1", env)).toBeNull()

    writeFileSync(path, JSON.stringify([1, 2, 3]))
    expect(readSessionSnapshot("s1", env)).toBeNull()

    writeFileSync(path, JSON.stringify({ version: 2, savedAt: 1, transcript }))
    expect(readSessionSnapshot("s1", env)).toBeNull()

    writeFileSync(path, JSON.stringify({ version: 1, savedAt: 1 }))
    expect(readSessionSnapshot("s1", env)).toBeNull()

    // ...and a good file written over the rubbish reads again.
    writeSessionSnapshot("s1", { transcript, savedAt: 9 }, env)
    expect(readSessionSnapshot("s1", env)?.savedAt).toBe(9)
  })

  test("rejects an empty session id or a snapshot with no transcript", () => {
    const env = temp()
    expect(writeSessionSnapshot("", { transcript }, env)).toEqual({ ok: false, reason: "invalid" })
    expect(writeSessionSnapshot("s1", { transcript: undefined }, env)).toEqual({ ok: false, reason: "invalid" })
  })

  test("deleting is idempotent", () => {
    const env = temp()
    writeSessionSnapshot("s1", { transcript, savedAt: 1 }, env)
    deleteSessionSnapshot("s1", env)
    deleteSessionSnapshot("s1", env)
    expect(readSessionSnapshot("s1", env)).toBeNull()
  })
})

describe("bounds", () => {
  test("a snapshot larger than the cap is skipped, not written", () => {
    const env = temp()
    const huge = { order: ["main"], blob: "x".repeat(9 * 1024 * 1024) }
    expect(writeSessionSnapshot("big", { transcript: huge, savedAt: 1 }, env)).toEqual({
      ok: false,
      reason: "too-large",
    })
    expect(readSessionSnapshot("big", env)).toBeNull()
  })

  test("the directory keeps at most 50 files, evicting the oldest by savedAt", () => {
    const env = temp()
    for (let i = 0; i < 60; i++) {
      writeSessionSnapshot(`s${i}`, { transcript, savedAt: 1000 + i }, env)
    }
    expect(readdirSync(snapshotDir(env)).filter((n) => n.endsWith(".json")).length).toBe(50)
    // The ten oldest are gone; everything newer survived.
    for (let i = 0; i < 10; i++) expect(readSessionSnapshot(`s${i}`, env)).toBeNull()
    for (let i = 10; i < 60; i++) expect(readSessionSnapshot(`s${i}`, env)?.savedAt).toBe(1000 + i)
  })

  test("eviction is by savedAt, not write order", () => {
    const env = temp()
    // The very first session is written first but claims the newest timestamp.
    writeSessionSnapshot("keep", { transcript, savedAt: 9_000_000 }, env)
    for (let i = 0; i < 55; i++) writeSessionSnapshot(`s${i}`, { transcript, savedAt: 1000 + i }, env)
    expect(readSessionSnapshot("keep", env)?.savedAt).toBe(9_000_000)
    expect(readSessionSnapshot("s0", env)).toBeNull()
  })
})
