import { describe, expect, test } from "bun:test"
import { initialState, reduce } from "./transcript"
import { isPersistedSessionEvent, rebuildTranscript, SessionCache } from "./sessionCache"

describe("SessionCache", () => {
  test("evicts the least recently used transcript", () => {
    const cache = new SessionCache(2)
    cache.set("one", { transcript: initialState, goal: null, repoId: "repo", events: [] })
    cache.set("two", { transcript: initialState, goal: null, repoId: "repo", events: [] })
    expect(cache.get("one")).toBeDefined()
    cache.set("three", { transcript: initialState, goal: null, repoId: "repo", events: [] })

    expect(cache.get("one")).toBeDefined()
    expect(cache.get("two")).toBeUndefined()
    expect(cache.get("three")).toBeDefined()
  })

  test("drops entries absent from a reconciled repo list", () => {
    const cache = new SessionCache()
    cache.set("keep", { transcript: initialState, goal: null, repoId: "repo", events: [] })
    cache.set("drop", { transcript: initialState, goal: null, repoId: "repo", events: [] })
    cache.set("other", { transcript: initialState, goal: null, repoId: "other", events: [] })

    cache.reconcileRepo("repo", new Set(["keep"]))

    expect(cache.get("keep")).toBeDefined()
    expect(cache.get("drop")).toBeUndefined()
    expect(cache.get("other")).toBeDefined()
  })

  test("excludes interleaved live-only events and rebuilds a divergent replay without duplicates", () => {
    const persisted = [
      { type: "message.user" as const, text: "hello" },
      { type: "message.start" as const, role: "assistant" as const },
      { type: "message.delta" as const, text: "world" },
      { type: "message.end" as const },
    ]
    const liveOnly = { type: "background.changed" as const, sessionId: "s", tasks: 1, monitors: 0 }
    const cachedEvents = [persisted[0]!, liveOnly, ...persisted.slice(1)]
    const prefix = cachedEvents.filter(isPersistedSessionEvent)
    expect(prefix).toEqual(persisted)

    // A changed server history diverges after the user message. Rebuilding its
    // full replay yields exactly its clean reduction, not the cached tail plus
    // a duplicate replay tail.
    const replay = [persisted[0]!, { type: "message.start" as const, role: "assistant" as const }, { type: "message.delta" as const, text: "rewritten" }, { type: "message.end" as const }]
    const shadow = replay.reduce(reduce, initialState)
    expect(shadow).toEqual(rebuildTranscript(replay))
    expect(shadow.threads.main!.items).toHaveLength(2)
  })
})
