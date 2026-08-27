import { describe, expect, test } from "bun:test"
import type { AgentEvent } from "@chunky/protocol"
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

  test("commitCursor stores durable+cursor and drops the legacy events prefix", () => {
    const cache = new SessionCache()
    const transcript = rebuildTranscript([{ type: "message.user", text: "hello" }])
    cache.set("s", { transcript: initialState, goal: null, repoId: "repo", events: [{ type: "message.user", text: "stale" }] })
    cache.commitCursor("s", {
      transcript,
      durable: transcript,
      cursor: "cursor-1",
      goal: null,
      repoId: "repo",
    })
    const entry = cache.get("s")!
    expect(entry.events).toEqual([])
    expect(entry.cursor).toBe("cursor-1")
    expect(entry.durable).toEqual(transcript)
    expect(entry.transcript).toEqual(transcript)
  })
})

describe("ports.changed is live-only and session-scoped", () => {
  const portsEvent = (sessionId: string, port: number): AgentEvent =>
    ({
      type: "ports.changed",
      sessionId,
      ports: [
        {
          port,
          address: "127.0.0.1",
          pid: 42,
          command: "bun run dev",
          taskId: "t1",
          url: `http://localhost:${port}`,
        },
      ],
    })

  test("never enters the persisted replay prefix", () => {
    const ev = portsEvent("s", 5173)
    expect(isPersistedSessionEvent(ev)).toBe(false)

    const cache = new SessionCache()
    const transcript = reduce(initialState, ev)
    cache.remember("s", transcript, null, "repo", ev)
    // First event for the session: the entry exists, but with an empty prefix.
    expect(cache.get("s")!.events).toEqual([])
    expect(cache.get("s")!.transcript.ports).toHaveLength(1)

    const user: AgentEvent = { type: "message.user", text: "hi" }
    const withUser = reduce(transcript, user)
    cache.remember("s", withUser, null, "repo", user)
    cache.remember("s", reduce(withUser, portsEvent("s", 4620)), null, "repo", portsEvent("s", 4620))
    expect(cache.get("s")!.events).toEqual([user])
    // …and rebuilding that prefix (what a replay does) yields no ports at all.
    expect(rebuildTranscript(cache.get("s")!.events).ports).toEqual([])
    // The live projection still holds the latest snapshot.
    expect(cache.get("s")!.transcript.ports.map((p) => p.port)).toEqual([4620])
  })

  test("does not leak across cached sessions", () => {
    const cache = new SessionCache()
    const a = portsEvent("a", 5173)
    cache.remember("a", reduce(initialState, a), null, "repo", a)
    cache.remember("b", initialState, null, "repo", { type: "message.user", text: "hi" })

    expect(cache.get("a")!.transcript.ports.map((p) => p.port)).toEqual([5173])
    expect(cache.get("b")!.transcript.ports).toEqual([])
    // A fresh snapshot for b leaves a alone.
    const b = portsEvent("b", 4620)
    cache.remember("b", reduce(cache.get("b")!.transcript, b), null, "repo", b)
    expect(cache.get("a")!.transcript.ports.map((p) => p.port)).toEqual([5173])
    expect(cache.get("b")!.transcript.ports.map((p) => p.port)).toEqual([4620])
  })

  test("an attach-time snapshot corrects a stale cached projection", () => {
    const cache = new SessionCache()
    const stale = portsEvent("s", 5173)
    cache.remember("s", reduce(initialState, stale), null, "repo", stale)
    // The task died while the session was not attached; the server's attach
    // snapshot is empty and authoritative.
    const empty: AgentEvent = { type: "ports.changed", sessionId: "s", ports: [] }
    cache.remember("s", reduce(cache.get("s")!.transcript, empty), null, "repo", empty)
    expect(cache.get("s")!.transcript.ports).toEqual([])
    expect(cache.get("s")!.events).toEqual([])
  })
})
