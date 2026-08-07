import { describe, expect, test } from "bun:test"
import type { AgentEvent } from "@chunky/protocol"
import { initialState, reduce, type TranscriptState } from "./transcript"
import { rebuildTranscript, SessionCache } from "./sessionCache"
import { ReplayReconciler, sameReplayEvent } from "./replayReconciler"

const history: AgentEvent[] = [
  { type: "message.user", text: "build it" },
  { type: "message.start", role: "assistant" },
  { type: "message.delta", text: "on it" },
  { type: "message.end" },
]

/** Drive a replay the way attachSession does, returning what ends up on screen. */
function replay(cached: AgentEvent[] | null, incoming: AgentEvent[]) {
  const reconciler = new ReplayReconciler(cached)
  let state = cached ? rebuildTranscript(cached) : initialState
  let completedAt: number | null = null
  let rebuiltAt: number | null = null
  for (const [i, ev] of incoming.entries()) {
    const decision = reconciler.next(ev)
    if (decision.kind === "skip") {
      if (decision.complete) completedAt = i
      continue
    }
    if (decision.kind === "rebuild") {
      rebuiltAt = i
      state = rebuildTranscript(decision.prefix)
    }
    state = reduce(state, ev)
  }
  return { state, completedAt, rebuiltAt, live: reconciler.live }
}

describe("ReplayReconciler", () => {
  test("with no cache every replayed event is new", () => {
    const result = replay(null, history)
    expect(result.rebuiltAt).toBeNull()
    expect(result.state).toEqual(rebuildTranscript(history))
    expect(result.live).toBe(true)
  })

  test("discards the cached prefix and reports where it ends", () => {
    const result = replay(history, history)
    expect(result.completedAt).toBe(history.length - 1)
    expect(result.rebuiltAt).toBeNull()
    // Unchanged: the cached projection was already correct.
    expect(result.state).toEqual(rebuildTranscript(history))
  })

  test("reduces only what happened while the session was unattached", () => {
    const progressed: AgentEvent[] = [
      ...history,
      { type: "message.user", text: "and tests" },
      { type: "message.start", role: "assistant" },
      { type: "message.delta", text: "done" },
      { type: "message.end" },
    ]
    const result = replay(history, progressed)
    expect(result.completedAt).toBe(history.length - 1)
    expect(result.rebuiltAt).toBeNull()
    // No duplicated turn: exactly the reduction of the server's own history.
    expect(result.state).toEqual(rebuildTranscript(progressed))
  })

  test("a divergent history rebuilds from the matched prefix, without duplicates", () => {
    const rewritten: AgentEvent[] = [
      history[0]!,
      { type: "message.start", role: "assistant" },
      { type: "message.delta", text: "rewritten" },
      { type: "message.end" },
    ]
    const result = replay(history, rewritten)
    // The first two events still match. Divergence is detected at the changed
    // delta, so the rebuild starts there rather than at message.start.
    expect(result.rebuiltAt).toBe(2)
    expect(result.state).toEqual(rebuildTranscript(rewritten))
    expect(result.state.threads.main!.items).toHaveLength(2)
  })

  test("after divergence a coincidentally equal event is never swallowed", () => {
    // The cached prefix and the replay share `message.end` at the same index,
    // which must NOT be skipped once comparison has been abandoned.
    const cached: AgentEvent[] = [
      { type: "message.user", text: "a" },
      { type: "message.start", role: "assistant" },
      { type: "message.delta", text: "cached" },
      { type: "message.end" },
    ]
    const server: AgentEvent[] = [
      { type: "message.user", text: "a" },
      { type: "message.user", text: "b" },
      { type: "message.delta", text: "cached" },
      { type: "message.end" },
    ]
    const result = replay(cached, server)
    expect(result.rebuiltAt).toBe(1)
    expect(result.state).toEqual(rebuildTranscript(server))
  })

  test("reset re-arms the prefix for a reconnect that replays from zero", () => {
    const reconciler = new ReplayReconciler(history)
    for (const ev of history) reconciler.next(ev)
    expect(reconciler.live).toBe(true)

    // The reconnect hands back the cache entry, now longer than before.
    const grown: AgentEvent[] = [...history, { type: "message.user", text: "more" }]
    reconciler.reset(grown)
    expect(reconciler.live).toBe(false)
    for (const ev of grown) expect(reconciler.next(ev).kind).toBe("skip")
    expect(reconciler.matchedCount).toBe(grown.length)
    expect(reconciler.next({ type: "message.start", role: "assistant" })).toEqual({ kind: "accept" })
  })

  test("a live event remembered into the cached array is never compared against", () => {
    // The session cache appends to its retained `events` in place, so the array
    // handed to reset() keeps growing while this replay runs. Recognising the
    // prefix must depend on what it held AT reset, not on its current length.
    const cached: AgentEvent[] = [...history]
    const reconciler = new ReplayReconciler(cached)
    for (const ev of history) expect(reconciler.next(ev).kind).toBe("skip")
    expect(reconciler.live).toBe(true)

    // First genuinely-new event: accepted, then remembered into the same array.
    const sent: AgentEvent = { type: "message.user", text: "and now this" }
    expect(reconciler.next(sent)).toEqual({ kind: "accept" })
    cached.push(sent)

    // The event that follows must still be plain news. Diffing it against the
    // just-remembered `sent` would report a bogus divergence and rebuild from a
    // prefix that drops the user's message.
    expect(reconciler.next({ type: "message.start", role: "assistant" })).toEqual({ kind: "accept" })
    expect(reconciler.live).toBe(true)
  })

  test("a message sent after reattaching survives the replay", () => {
    // End-to-end against the real SessionCache, mirroring attachSession's
    // onEvent loop (App.tsx): construct the reconciler from the cache entry,
    // skip/rebuild/accept, then remember each event onto the projection.
    const cache = new SessionCache()
    const attach = (id: string, incoming: AgentEvent[]): TranscriptState => {
      const cached = cache.get(id)
      const reconciler = new ReplayReconciler(cached?.events)
      let state = cached?.transcript ?? initialState
      if (!cached) cache.set(id, { transcript: initialState, goal: null, repoId: null, events: [] })
      for (const ev of incoming) {
        const decision = reconciler.next(ev)
        if (decision.kind === "skip") continue
        if (decision.kind === "rebuild") {
          state = rebuildTranscript(decision.prefix)
          cache.set(id, { transcript: state, goal: null, repoId: null, events: [...decision.prefix] })
        }
        state = reduce(state, ev)
        cache.remember(id, state, null, null, ev)
      }
      return state
    }
    const userTexts = (state: TranscriptState) =>
      state.threads.main!.items.flatMap((it) => (it.kind === "user" ? [it.text] : []))

    attach("s1", history)
    expect(cache.get("s1")!.events).toHaveLength(history.length)

    // Reattach (session switch or SSE reconnect): the server replays from event
    // zero, then the reader sends a message and the agent starts answering.
    const sent = attach("s1", [
      ...history,
      { type: "message.user", text: "and tests please" },
      { type: "message.start", role: "assistant" },
      { type: "message.delta", text: "working" },
    ])
    expect(userTexts(sent)).toEqual(["build it", "and tests please"])
  })

  test("sameReplayEvent compares payloads, not just types", () => {
    expect(sameReplayEvent({ type: "message.delta", text: "x" }, { type: "message.delta", text: "x" })).toBe(true)
    expect(sameReplayEvent({ type: "message.delta", text: "x" }, { type: "message.delta", text: "y" })).toBe(false)
    expect(sameReplayEvent({ type: "message.end" }, undefined)).toBe(false)
  })
})
