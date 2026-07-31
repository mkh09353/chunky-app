import { describe, expect, test } from "bun:test"
import { initialState } from "./transcript"
import { SessionCache } from "./sessionCache"

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
})
