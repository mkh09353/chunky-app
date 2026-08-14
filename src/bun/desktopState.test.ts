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

  test("quick keys merge in without disturbing the tab keys, and clean up", () => {
    const { env, dir } = temp()
    try {
      mergeDesktopState({ activeRepoId: "r1", workspace: "/w" }, env)
      mergeDesktopState(
        {
          quickKeys: [
            { id: "qk-1", emoji: " \u{1F6A2} ", label: " Ship it! ", prompt: " ship ", hotkey: "D" },
            { id: "qk-2", emoji: "", label: "No prompt", prompt: "  ", hotkey: "e" },
            { id: "qk-3", emoji: "", label: "Dup hotkey", prompt: "x", hotkey: "d" },
          ],
        },
        env,
      )
      const state = readDesktopState(env)
      expect(state.activeRepoId).toBe("r1")
      expect(state.workspace).toBe("/w")
      expect(state.quickKeys).toEqual([
        { id: "qk-1", emoji: "\u{1F6A2}", label: "Ship it!", prompt: "ship", hotkey: "d" },
        { id: "qk-3", emoji: "", label: "Dup hotkey", prompt: "x", hotkey: "" },
      ])

      // Writing an unrelated key must leave the quick keys alone.
      mergeDesktopState({ activeRepoId: "r2" }, env)
      expect(readDesktopState(env).quickKeys?.length).toBe(2)

      // An explicit empty list clears them.
      mergeDesktopState({ quickKeys: [] }, env)
      expect(readDesktopState(env).quickKeys).toBeUndefined()
      expect(readDesktopState(env).activeRepoId).toBe("r2")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("a display name merges in, normalises, and clears on empty", () => {
    const { env, dir } = temp()
    try {
      mergeDesktopState({ activeRepoId: "r1", workspace: "/w" }, env)

      // Trimmed, and every whitespace run folded to one space.
      mergeDesktopState({ displayName: "  Ada   Lovelace \n" }, env)
      expect(readDesktopState(env).displayName).toBe("Ada Lovelace")
      // Unrelated keys survive the write.
      expect(readDesktopState(env).activeRepoId).toBe("r1")
      expect(readDesktopState(env).workspace).toBe("/w")

      // Writing something else leaves the name alone.
      mergeDesktopState({ activeRepoId: "r2" }, env)
      expect(readDesktopState(env).displayName).toBe("Ada Lovelace")

      // Whitespace-only clears the override by DELETING the key, so "no
      // override" is absence rather than a stored empty string.
      mergeDesktopState({ displayName: "   " }, env)
      expect(readDesktopState(env).displayName).toBeUndefined()
      expect("displayName" in onDisk(env)).toBe(false)
      expect(readDesktopState(env).activeRepoId).toBe("r2")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("a display name is bounded in graphemes and never split mid-emoji", () => {
    const { env, dir } = temp()
    try {
      mergeDesktopState({ displayName: "N".repeat(200) }, env)
      expect(readDesktopState(env).displayName?.length).toBe(40)

      // 40 ZWJ families: a UTF-16 cap would slice one into replacement glyphs.
      mergeDesktopState({ displayName: "\u{1F469}‍\u{1F469}‍\u{1F467}‍\u{1F466}".repeat(50) }, env)
      const emoji = readDesktopState(env).displayName ?? ""
      expect(emoji).not.toContain("�")
      expect(emoji.endsWith("\u{1F466}")).toBe(true)

      // A non-string is not an override.
      mergeDesktopState({ displayName: 42 as unknown as string }, env)
      expect(readDesktopState(env).displayName).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("a hand-edited or hostile display name is cleaned on read", () => {
    const { env, dir } = temp()
    try {
      mergeDesktopState({ activeRepoId: "r1" }, env)
      writeFileSync(
        desktopStatePath(env),
        JSON.stringify({ activeRepoId: "r1", displayName: "Ada\tLovelace\u0000" }),
      )
      expect(readDesktopState(env).displayName).toBe("Ada Lovelace")

      writeFileSync(desktopStatePath(env), JSON.stringify({ displayName: ["nope"] }))
      expect(readDesktopState(env).displayName).toBeUndefined()
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

// The sidebar's settle/unsettle choice. There is no server-side settled
// lifecycle, so this file is the only record of it and has to survive a
// reinstall like any other durable preference.
describe("session shelf pins", () => {
  test("round trip, and unrelated keys are left alone", () => {
    const { env, dir } = temp()
    try {
      mergeDesktopState({ activeRepoId: "r1" }, env)
      mergeDesktopState({ sessionShelves: { s1: { shelf: "settled", at: 1234 } } }, env)

      expect(readDesktopState(env).sessionShelves).toEqual({ s1: { shelf: "settled", at: 1234 } })
      expect(readDesktopState(env).activeRepoId).toBe("r1")

      // Writing something else leaves the pins alone.
      mergeDesktopState({ displayName: "Ada Lovelace" }, env)
      expect(readDesktopState(env).sessionShelves).toEqual({ s1: { shelf: "settled", at: 1234 } })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("the renderer owns the map, so a patch replaces it wholesale", () => {
    const { env, dir } = temp()
    try {
      mergeDesktopState(
        { sessionShelves: { s1: { shelf: "settled", at: 1 }, s2: { shelf: "active", at: 2 } } },
        env,
      )
      mergeDesktopState({ sessionShelves: { s2: { shelf: "active", at: 2 } } }, env)
      expect(readDesktopState(env).sessionShelves).toEqual({ s2: { shelf: "active", at: 2 } })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("an empty map is stored as absence, not as an empty object", () => {
    const { env, dir } = temp()
    try {
      mergeDesktopState({ activeRepoId: "r1" }, env)
      mergeDesktopState({ sessionShelves: { s1: { shelf: "settled", at: 1 } } }, env)
      mergeDesktopState({ sessionShelves: {} }, env)

      expect(readDesktopState(env).sessionShelves).toBeUndefined()
      expect("sessionShelves" in onDisk(env)).toBe(false)
      expect(readDesktopState(env).activeRepoId).toBe("r1")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("malformed pins are dropped and a rubbish watermark reads as 0", () => {
    const { env, dir } = temp()
    try {
      writeFileSync(
        desktopStatePath(env),
        JSON.stringify({
          sessionShelves: {
            good: { shelf: "settled", at: 99 },
            // A watermark of 0 retires the pin on the session's next observed
            // activity, which is the safe direction to fail in.
            noAt: { shelf: "active" },
            badAt: { shelf: "active", at: "soon" },
            badShelf: { shelf: "archived", at: 1 },
            notAnObject: "settled",
            "": { shelf: "settled", at: 1 },
          },
        }),
      )
      expect(readDesktopState(env).sessionShelves).toEqual({
        good: { shelf: "settled", at: 99 },
        noAt: { shelf: "active", at: 0 },
        badAt: { shelf: "active", at: 0 },
      })

      // An array is not a map of pins.
      writeFileSync(desktopStatePath(env), JSON.stringify({ sessionShelves: ["s1"] }))
      expect(readDesktopState(env).sessionShelves).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("the map is bounded so a hostile renderer cannot grow the file forever", () => {
    const { env, dir } = temp()
    try {
      const huge: Record<string, { shelf: "settled"; at: number }> = {}
      for (let i = 0; i < 900; i++) huge[`s${i}`] = { shelf: "settled", at: i }
      mergeDesktopState({ sessionShelves: huge }, env)
      expect(Object.keys(readDesktopState(env).sessionShelves ?? {})).toHaveLength(500)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// The sidebar's "pin to top" choice. Like the shelves, the protocol has no such
// concept, so this file is the only record of it.
describe("pinned sessions", () => {
  test("round trip, and unrelated keys are left alone", () => {
    const { env, dir } = temp()
    try {
      mergeDesktopState({ activeRepoId: "r1" }, env)
      mergeDesktopState({ pinnedSessions: { s1: 1234 } }, env)

      expect(readDesktopState(env).pinnedSessions).toEqual({ s1: 1234 })
      expect(readDesktopState(env).activeRepoId).toBe("r1")

      // Writing something else leaves the pins alone.
      mergeDesktopState({ sessionShelves: { s2: { shelf: "settled", at: 5 } } }, env)
      expect(readDesktopState(env).pinnedSessions).toEqual({ s1: 1234 })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("the renderer owns the map, so a patch replaces it wholesale", () => {
    const { env, dir } = temp()
    try {
      mergeDesktopState({ pinnedSessions: { s1: 1, s2: 2 } }, env)
      mergeDesktopState({ pinnedSessions: { s2: 2 } }, env)
      expect(readDesktopState(env).pinnedSessions).toEqual({ s2: 2 })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("an empty map is stored as absence, not as an empty object", () => {
    const { env, dir } = temp()
    try {
      mergeDesktopState({ activeRepoId: "r1" }, env)
      mergeDesktopState({ pinnedSessions: { s1: 1 } }, env)
      mergeDesktopState({ pinnedSessions: {} }, env)

      expect(readDesktopState(env).pinnedSessions).toBeUndefined()
      expect("pinnedSessions" in onDisk(env)).toBe(false)
      expect(readDesktopState(env).activeRepoId).toBe("r1")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("malformed pins are dropped and a rubbish timestamp reads as 0", () => {
    const { env, dir } = temp()
    try {
      writeFileSync(
        desktopStatePath(env),
        JSON.stringify({
          pinnedSessions: {
            good: 99,
            // Not a number at all: there is no pin to keep.
            notANumber: "soon",
            nested: { at: 1 },
            // A pin with a rubbish/negative time survives, sorted to the front.
            negative: -5,
            fractional: 3.7,
            "": 1,
          },
        }),
      )
      expect(readDesktopState(env).pinnedSessions).toEqual({
        good: 99,
        negative: 0,
        fractional: 3,
      })

      // An array is not a map of pins.
      writeFileSync(desktopStatePath(env), JSON.stringify({ pinnedSessions: ["s1"] }))
      expect(readDesktopState(env).pinnedSessions).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("the map is bounded so a hostile renderer cannot grow the file forever", () => {
    const { env, dir } = temp()
    try {
      const huge: Record<string, number> = {}
      for (let i = 0; i < 900; i++) huge[`s${i}`] = i
      mergeDesktopState({ pinnedSessions: huge }, env)
      expect(Object.keys(readDesktopState(env).pinnedSessions ?? {})).toHaveLength(500)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("an over-long session id is rejected", () => {
    const { env, dir } = temp()
    try {
      mergeDesktopState({ pinnedSessions: { ["x".repeat(200)]: 1, ok: 2 } }, env)
      expect(readDesktopState(env).pinnedSessions).toEqual({ ok: 2 })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
