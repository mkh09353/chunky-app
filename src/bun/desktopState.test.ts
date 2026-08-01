// desktop.json is the durable home of renderer UI state (open repo tab, per-tab
// thread). It is shared with the connection manager's workspace key, so writes
// must merge rather than replace, and must publish atomically.
import { describe, expect, test } from "bun:test"
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { desktopStatePath, mergeDesktopState, readDesktopState, stateDir } from "./desktopState"

function temp(): { env: NodeJS.ProcessEnv; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "chunky-desktop-state-"))
  return { env: { CHUNKY_HOME: dir } as NodeJS.ProcessEnv, dir }
}

function onDisk(env: NodeJS.ProcessEnv): Record<string, unknown> {
  return JSON.parse(readFileSync(desktopStatePath(env), "utf8")) as Record<string, unknown>
}

describe("desktop state location", () => {
  test("honours CHUNKY_HOME and defaults under the home directory", () => {
    const { env, dir } = temp()
    try {
      expect(stateDir(env)).toBe(dir)
      expect(desktopStatePath(env)).toBe(join(dir, "desktop.json"))
      expect(stateDir({} as NodeJS.ProcessEnv)).toMatch(/\.chunky\/state$/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("reading", () => {
  test("missing, corrupt and malformed files read as empty rather than throwing", () => {
    const { env, dir } = temp()
    try {
      expect(readDesktopState(env)).toEqual({})
      writeFileSync(desktopStatePath(env), "{ not json")
      expect(readDesktopState(env)).toEqual({})
      writeFileSync(desktopStatePath(env), JSON.stringify({ activeRepoId: 42, lastSessionByRepo: [] }))
      expect(readDesktopState(env)).toEqual({})
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("merge-on-write", () => {
  test("keeps keys the patch does not mention", () => {
    const { env, dir } = temp()
    try {
      mergeDesktopState({ workspace: "/tmp/work" }, env)
      mergeDesktopState({ activeRepoId: "r1" }, env)
      mergeDesktopState({ lastSessionByRepo: { r1: "s1" } }, env)

      expect(readDesktopState(env)).toEqual({
        workspace: "/tmp/work",
        activeRepoId: "r1",
        lastSessionByRepo: { r1: "s1" },
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("preserves a concurrent writer's key written after this caller last read", () => {
    const { env, dir } = temp()
    try {
      mergeDesktopState({ activeRepoId: "r1" }, env)
      // Another part of the app (the connection manager) writes the workspace.
      writeFileSync(
        desktopStatePath(env),
        JSON.stringify({ activeRepoId: "r1", workspace: "/tmp/other" }, null, 2),
      )
      mergeDesktopState({ lastSessionByRepo: { r1: "s1" } }, env)

      expect(onDisk(env).workspace).toBe("/tmp/other")
      expect(onDisk(env).activeRepoId).toBe("r1")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("null clears the remembered tab and an empty map clears the sessions", () => {
    const { env, dir } = temp()
    try {
      mergeDesktopState({ activeRepoId: "r1", lastSessionByRepo: { r1: "s1" }, workspace: "/tmp/w" }, env)
      mergeDesktopState({ activeRepoId: null }, env)
      expect(readDesktopState(env).activeRepoId).toBeUndefined()
      expect(readDesktopState(env).lastSessionByRepo).toEqual({ r1: "s1" })

      mergeDesktopState({ lastSessionByRepo: {} }, env)
      expect(readDesktopState(env).lastSessionByRepo).toBeUndefined()
      // The unrelated key is still there.
      expect(readDesktopState(env).workspace).toBe("/tmp/w")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("bounds ids and entry count, dropping junk instead of persisting it", () => {
    const { env, dir } = temp()
    try {
      const huge = Object.fromEntries(
        Array.from({ length: 600 }, (_, i) => [`repo-${i}`, `session-${i}`]),
      )
      mergeDesktopState(
        {
          activeRepoId: "x".repeat(500),
          lastSessionByRepo: { ...huge, bad: 7 as unknown as string, "": "s" },
        },
        env,
      )
      const state = readDesktopState(env)
      expect(state.activeRepoId).toBeUndefined()
      expect(Object.keys(state.lastSessionByRepo ?? {}).length).toBe(500)
      expect(state.lastSessionByRepo?.bad).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("publishes by temp-file rename and leaves nothing behind", () => {
    const { env, dir } = temp()
    try {
      mergeDesktopState({ activeRepoId: "r1" }, env)
      expect(readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([])
      expect(readdirSync(dir)).toEqual(["desktop.json"])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("an unwritable location returns the current state instead of throwing", () => {
    const env = { CHUNKY_HOME: "/proc/definitely/not/writable" } as NodeJS.ProcessEnv
    expect(() => mergeDesktopState({ activeRepoId: "r1" }, env)).not.toThrow()
    expect(mergeDesktopState({ activeRepoId: "r1" }, env)).toEqual({})
  })
})
