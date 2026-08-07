// Optimistic user rows: appear on send, resolve against the authoritative
// echo, survive a replay rebuild, and say so when the send failed.
// Run with: bun test src/mainview/lib/pendingSends.test.ts
import { describe, expect, test } from "bun:test"
import type { AgentEvent, QueueEntry } from "@chunky/protocol"
import {
  createPendingSend,
  dropPendingSend,
  markPendingSendFailed,
  pendingMessages,
  samePendingSends,
  shouldAppendOptimistically,
  unresolvedPendingSends,
  userItemCount,
  type PendingSend,
} from "./pendingSends"
import { buildActiveThread } from "./mapTranscript"
import { rebuildTranscript } from "./sessionCache"
import { initialState, mainItems, reduce, type TranscriptState } from "./transcript"

const settledTurn: AgentEvent[] = [
  { type: "message.user", text: "first question" },
  { type: "message.start", role: "assistant" },
  { type: "message.delta", text: "an answer" },
  { type: "message.end" },
]

const at = (events: AgentEvent[]): TranscriptState => rebuildTranscript(events)

/** The user rows a reader would actually see, in order. */
function userRows(state: TranscriptState, pending: readonly PendingSend[]) {
  const thread = buildActiveThread(undefined, state, "Sonnet", pending)
  return thread.messages
    .filter((m) => m.role === "user")
    .map((m) => ({
      id: m.id,
      text: m.blocks.map((b) => b.content).join(""),
      sending: m.sending ?? false,
      sendError: m.sendError,
      imageCount: m.imageCount,
    }))
}

const send = (state: TranscriptState, text: string, imageCount = 0, id = "pending-1") =>
  createPendingSend({ id, text, imageCount, items: mainItems(state) })

describe("optimistic append", () => {
  test("the sent message is on screen before any server event arrives", () => {
    const state = at(settledTurn)
    const pending = [send(state, "and now the tests", 2)]

    const rows = userRows(state, unresolvedPendingSends(pending, mainItems(state)))
    expect(rows).toHaveLength(2)
    expect(rows[1]).toMatchObject({
      text: "and now the tests",
      sending: true,
      imageCount: 2,
    })
    // Compact attachment metadata only: a count, never the base64 that was sent.
    expect(JSON.stringify(pending)).not.toContain("base64")
  })

  test("the optimistic row cannot collide with a mapped transcript id", () => {
    const state = at(settledTurn)
    const pending = [send(state, "hello")]
    const ids = buildActiveThread(undefined, state, undefined, pending).messages.map((m) => m.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids.at(-1)).toBe("pending-1")
  })

  test("a queued send is not optimistic — the queue chips own it", () => {
    expect(shouldAppendOptimistically("queue")).toBe(false)
    expect(shouldAppendOptimistically("auto")).toBe(true)
    expect(shouldAppendOptimistically("interject")).toBe(true)
    expect(shouldAppendOptimistically(undefined)).toBe(true)
  })
})

describe("reconciling with the authoritative echo", () => {
  test("the server row replaces the optimistic one — never both", () => {
    const before = at(settledTurn)
    const pending = [send(before, "and now the tests")]
    expect(userRows(before, unresolvedPendingSends(pending, mainItems(before)))).toHaveLength(2)

    // The echo lands: same text, verbatim, exactly as deliverMessage emits it.
    const after = reduce(before, { type: "message.user", text: "and now the tests" })
    const resolved = unresolvedPendingSends(pending, mainItems(after))
    expect(resolved).toHaveLength(0)

    const rows = userRows(after, resolved)
    expect(rows).toHaveLength(2)
    expect(rows[1]!.text).toBe("and now the tests")
    expect(rows[1]!.sending).toBe(false)
    // The authoritative row, not the optimistic one.
    expect(rows[1]!.id).not.toBe("pending-1")
  })

  test("an interjection echo resolves the row it belongs to", () => {
    const before = at(settledTurn)
    const pending = [send(before, "actually, stop")]
    const after = reduce(before, {
      type: "message.interjection",
      sessionId: "s",
      text: "actually, stop",
      injected: false,
    })
    expect(unresolvedPendingSends(pending, mainItems(after))).toHaveLength(0)
    expect(userRows(after, unresolvedPendingSends(pending, mainItems(after)))).toHaveLength(2)
  })

  test("re-sending identical text does not resolve against the OLD row", () => {
    // The trap this baseline exists for: "ok" was already said once, so a
    // naive text match would resolve the new "ok" instantly and it would look
    // like it was never sent at all.
    const before = at([...settledTurn, { type: "message.user", text: "ok" }])
    const pending = [send(before, "ok")]
    expect(unresolvedPendingSends(pending, mainItems(before))).toEqual(pending)

    const after = reduce(before, { type: "message.user", text: "ok" })
    expect(unresolvedPendingSends(pending, mainItems(after))).toHaveLength(0)
  })

  test("two identical sends resolve first-in-first-out, one echo each", () => {
    const before = at(settledTurn)
    const first = send(before, "ok", 0, "pending-1")
    const second = send(before, "ok", 0, "pending-2")
    const pending = [first, second]

    const oneEcho = reduce(before, { type: "message.user", text: "ok" })
    // One echo claims exactly one row — the older one.
    expect(unresolvedPendingSends(pending, mainItems(oneEcho))).toEqual([second])

    const bothEchoed = reduce(oneEcho, { type: "message.user", text: "ok" })
    expect(unresolvedPendingSends(pending, mainItems(bothEchoed))).toHaveLength(0)
    expect(userRows(bothEchoed, []).filter((r) => r.text === "ok")).toHaveLength(2)
  })

  test("another session's injection never claims our pending row", () => {
    const before = at(settledTurn)
    const pending = [send(before, "run the suite")]
    // send_to_session / monitor injections carry `from` and are somebody else's.
    const after = reduce(before, { type: "message.user", text: "run the suite", from: "monitor" })
    expect(unresolvedPendingSends(pending, mainItems(after))).toEqual(pending)
    // Both rows render: the injection AND our still-pending send. Neither is
    // silently dropped and neither is duplicated.
    const rows = userRows(after, unresolvedPendingSends(pending, mainItems(after)))
    expect(rows.map((r) => r.sending)).toEqual([false, false, true])
  })

  test("an unmatched echo leaves the pending row alone rather than dropping it", () => {
    const before = at(settledTurn)
    const pending = [send(before, "what I typed")]
    const after = reduce(before, { type: "message.user", text: "something else entirely" })
    expect(unresolvedPendingSends(pending, mainItems(after))).toEqual(pending)
  })

  test("a send the server queued resolves against its queue chip", () => {
    // The race: the composer chose `auto` while idle, but a turn started first,
    // so the server enqueued it and no message.user is coming until the drain.
    const before = at(settledTurn)
    const pending = [send(before, "next up")]
    const entries: QueueEntry[] = [
      { id: "q1", version: 1, text: "next up", shown: "next up", kind: "prompt", position: 0, createdAt: 0 },
    ]
    const queued = reduce(before, { type: "queue.changed", sessionId: "s", entries, running: true })
    expect(unresolvedPendingSends(pending, mainItems(queued), queued.queue.entries)).toHaveLength(0)
  })
})

describe("send failures", () => {
  test("a failed send stays on the row, marked, instead of vanishing", () => {
    const state = at(settledTurn)
    const failed = markPendingSendFailed([send(state, "this one breaks")], "pending-1", "network down")
    const rows = userRows(state, unresolvedPendingSends(failed, mainItems(state)))
    expect(rows[1]).toMatchObject({
      text: "this one breaks",
      sending: false,
      sendError: "network down",
    })
  })

  test("a failed row still resolves if the echo turns up after all", () => {
    // The POST died after the server had accepted it: the row was wrong about
    // failing, and the authoritative message must not end up duplicated.
    const before = at(settledTurn)
    const failed = markPendingSendFailed([send(before, "landed anyway")], "pending-1", "timeout")
    const after = reduce(before, { type: "message.user", text: "landed anyway" })
    expect(unresolvedPendingSends(failed, mainItems(after))).toHaveLength(0)
  })

  test("a blocked send (cache guard, nothing ran) drops its row", () => {
    const state = at(settledTurn)
    const pending = [send(state, "expensive question")]
    expect(dropPendingSend(pending, "pending-1")).toEqual([])
    expect(dropPendingSend(pending, "pending-other")).toEqual(pending)
  })
})

describe("surviving the replay path", () => {
  test("a rebuild from event zero does not wipe a still-pending row", () => {
    // Divergent replay: ReplayReconciler hands back a prefix, the projection is
    // rebuilt from it (App.tsx attachSession), and the reduced transcript is
    // replaced wholesale. Pending rows live outside TranscriptState, so they
    // are still there — and still pending, because the rebuilt history has no
    // echo for them.
    const before = at(settledTurn)
    const pending = [send(before, "sent mid-reconnect")]

    const rebuilt = rebuildTranscript(settledTurn.slice(0, 2))
    expect(unresolvedPendingSends(pending, mainItems(rebuilt))).toEqual(pending)
    expect(userRows(rebuilt, unresolvedPendingSends(pending, mainItems(rebuilt))).at(-1)).toMatchObject({
      text: "sent mid-reconnect",
      sending: true,
    })

    // …and when the replay catches up and the echo finally arrives, it resolves
    // exactly once.
    const caughtUp = reduce(at(settledTurn), { type: "message.user", text: "sent mid-reconnect" })
    expect(unresolvedPendingSends(pending, mainItems(caughtUp))).toHaveLength(0)
  })

  test("a rebuild that loses the echo brings the pending row back, never a silent drop", () => {
    const echoed = reduce(at(settledTurn), { type: "message.user", text: "sent mid-reconnect" })
    const pending = [createPendingSend({ id: "pending-1", text: "sent mid-reconnect", items: mainItems(at(settledTurn)) })]
    expect(unresolvedPendingSends(pending, mainItems(echoed))).toHaveLength(0)

    const shrunk = rebuildTranscript(settledTurn)
    expect(unresolvedPendingSends(pending, mainItems(shrunk))).toEqual(pending)
  })

  test("nothing optimistic is reduced into the transcript itself", () => {
    // The whole point of keeping these out of the event log: the reduced
    // transcript is exactly the server's history, pending rows or not.
    const state = at(settledTurn)
    const pending = [send(state, "purely local")]
    expect(userItemCount(mainItems(state))).toBe(1)
    expect(mainItems(state).some((it) => it.kind === "user" && it.text === "purely local")).toBe(false)
    expect(pendingMessages(pending)[0]!.id).toBe("pending-1")
    expect(state).toEqual(at(settledTurn))
  })
})

describe("pruning", () => {
  test("samePendingSends compares identity so a settled list stops re-rendering", () => {
    const state = at(settledTurn)
    const pending = [send(state, "a", 0, "pending-1"), send(state, "b", 0, "pending-2")]
    expect(samePendingSends(pending, unresolvedPendingSends(pending, mainItems(state)))).toBe(true)

    const echoed = reduce(state, { type: "message.user", text: "a" })
    const next = unresolvedPendingSends(pending, mainItems(echoed))
    expect(samePendingSends(pending, next)).toBe(false)
    expect(samePendingSends(next, unresolvedPendingSends(next, mainItems(echoed)))).toBe(true)
  })

  test("an empty list is cheap and stable", () => {
    expect(unresolvedPendingSends([], mainItems(initialState))).toEqual([])
    expect(pendingMessages([])).toEqual([])
  })
})
