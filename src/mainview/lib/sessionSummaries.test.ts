import { describe, expect, test } from "bun:test"
import type { SessionSummary } from "@chunky/protocol"
import {
  absorbAuthoritative,
  applySessionDelta,
  applySessionSnapshot,
  createCompletionTracker,
  forgetRepoTracking,
  isSessionBusy,
  mergeSummary,
  mergeSummaryLists,
  needsAuthoritativeBusy,
  sameSummaryList,
  sessionsInWorkspace,
  trackCompletions,
  unionSummaries,
} from "./sessionSummaries"

const row = (id: string, extra: Partial<SessionSummary> = {}): SessionSummary => ({
  sessionId: id,
  title: id,
  createdAt: 1,
  lastActivity: 1,
  workspace: "/repo",
  ...extra,
})

describe("mergeSummary", () => {
  test("an authoritative row wins outright", () => {
    const merged = mergeSummary(row("a", { busy: true }), row("a", { busy: false }))
    expect(merged.busy).toBe(false)
  })

  test("a running streamed row is busy by implication", () => {
    expect(mergeSummary(undefined, row("a", { running: true })).busy).toBe(true)
  })

  test("a stopped streamed row keeps the last known busy (delegates may live on)", () => {
    const merged = mergeSummary(row("a", { busy: true, running: true }), row("a", { running: false }))
    expect(merged.busy).toBe(true)
    expect(merged.running).toBe(false)
    expect(needsAuthoritativeBusy(row("a", { busy: true }), row("a", { running: false }))).toBe(true)
  })

  test("nothing known stays unknown", () => {
    expect(mergeSummary(undefined, row("a")).busy).toBeUndefined()
    expect(needsAuthoritativeBusy(undefined, row("a"))).toBe(false)
    expect(isSessionBusy(row("a"))).toBe(false)
    expect(isSessionBusy(row("a", { running: true }))).toBe(true)
    expect(isSessionBusy(row("a", { busy: true, running: false }))).toBe(true)
  })
})

describe("snapshot/delta application", () => {
  test("a snapshot replaces membership but preserves known busy", () => {
    const first = absorbAuthoritative(new Map(), [row("a", { busy: true, running: true }), row("b", { busy: false })])
    const { map, stale } = applySessionSnapshot(first, [row("a", { running: false }), row("c")])
    expect([...map.keys()]).toEqual(["a", "c"])
    expect(map.get("a")!.busy).toBe(true)
    expect(stale).toEqual(["a"])
  })

  test("a delta upserts and removes", () => {
    const base = absorbAuthoritative(new Map(), [row("a", { busy: true, running: true }), row("b")])
    const { map, stale } = applySessionDelta(base, {
      upsert: [row("a", { running: false, lastActivity: 9 })],
      remove: ["b"],
    })
    expect([...map.keys()]).toEqual(["a"])
    expect(map.get("a")!.lastActivity).toBe(9)
    expect(map.get("a")!.busy).toBe(true)
    expect(stale).toEqual(["a"])
  })

  test("a poll settles the stale busy", () => {
    const held = absorbAuthoritative(new Map(), [row("a", { busy: true, running: false })])
    const settled = absorbAuthoritative(held, [row("a", { busy: false, running: false })])
    expect(settled.get("a")!.busy).toBe(false)
  })
})

describe("list shaping", () => {
  test("scopes to a workspace, newest first", () => {
    const map = absorbAuthoritative(new Map(), [
      row("old", { lastActivity: 1 }),
      row("new", { lastActivity: 5 }),
      row("elsewhere", { workspace: "/other", lastActivity: 9 }),
    ])
    expect(sessionsInWorkspace(map, "/repo").map((s) => s.sessionId)).toEqual(["new", "old"])
    expect(sessionsInWorkspace(map, null)).toEqual([])
  })

  test("merging lists takes membership from the newer list and busy from either", () => {
    const merged = mergeSummaryLists(
      [row("a", { busy: true, running: true }), row("gone", { busy: false })],
      [row("a", { running: false }), row("fresh")],
    )
    expect(merged.map((s) => s.sessionId)).toEqual(["a", "fresh"])
    expect(merged[0]!.busy).toBe(true)
    expect(merged[1]!.busy).toBeUndefined()
  })

  test("a union keeps rows the newer source did not mention", () => {
    const union = unionSummaries(
      [row("known", { lastActivity: 1 }), row("fresh-elsewhere", { lastActivity: 3 })],
      [row("known", { lastActivity: 7 })],
    )
    expect(union.map((s) => s.sessionId)).toEqual(["known", "fresh-elsewhere"])
    expect(union[0]!.lastActivity).toBe(7)
  })

  test("sameSummaryList spots the fields the sidebar renders", () => {
    expect(sameSummaryList([row("a")], [row("a")])).toBe(true)
    expect(sameSummaryList([row("a")], [row("a", { busy: true })])).toBe(false)
    expect(sameSummaryList([row("a")], [row("a", { lastActivity: 2 })])).toBe(false)
    expect(sameSummaryList([row("a")], [])).toBe(false)
  })
})

describe("trackCompletions", () => {
  const MIN = 3_000

  test("never fires for a run this client did not observe start", () => {
    const tracker = createCompletionTracker()
    // First sight of an already-idle session (a replay/first load).
    expect(trackCompletions(tracker, [{ key: "r:a", sessionId: "a", running: false }], 0, MIN)).toEqual({
      completed: false,
      done: [],
    })
  })

  test("fires once a long enough observed run goes idle", () => {
    const tracker = createCompletionTracker()
    trackCompletions(tracker, [{ key: "r:a", sessionId: "a", running: true }], 0, MIN)
    expect(
      trackCompletions(tracker, [{ key: "r:a", sessionId: "a", running: false }], 5_000, MIN),
    ).toEqual({ completed: true, done: ["a"] })
  })

  test("a blip shorter than the gate is not a completion", () => {
    const tracker = createCompletionTracker()
    trackCompletions(tracker, [{ key: "r:a", sessionId: "a", running: true }], 0, MIN)
    expect(
      trackCompletions(tracker, [{ key: "r:a", sessionId: "a", running: false }], 1_000, MIN),
    ).toEqual({ completed: false, done: [] })
  })

  test("only reports the transition once", () => {
    const tracker = createCompletionTracker()
    trackCompletions(tracker, [{ key: "r:a", sessionId: "a", running: true }], 0, MIN)
    trackCompletions(tracker, [{ key: "r:a", sessionId: "a", running: false }], 5_000, MIN)
    expect(
      trackCompletions(tracker, [{ key: "r:a", sessionId: "a", running: false }], 6_000, MIN),
    ).toEqual({ completed: false, done: [] })
  })

  test("repos are folded in independently and can be forgotten", () => {
    const tracker = createCompletionTracker()
    trackCompletions(
      tracker,
      [
        { key: "one:a", sessionId: "a", running: true },
        { key: "two:b", sessionId: "b", running: true },
      ],
      0,
      MIN,
    )
    // Folding only repo one must not disturb repo two's bookkeeping.
    trackCompletions(tracker, [{ key: "one:a", sessionId: "a", running: false }], 5_000, MIN)
    expect(tracker.was.get("two:b")).toBe(true)

    forgetRepoTracking(tracker, "two")
    expect(tracker.was.has("two:b")).toBe(false)
    expect(tracker.was.has("one:a")).toBe(true)
  })
})

// The server now puts `busy` on shell/stream rows (chunky: shellSummary /
// shellSessions). These pin the two halves of that contract: a row that states
// `busy` is taken at its word and costs no confirming poll, while a row from an
// older server that omits it still falls back to the poll.
describe("a stream that carries busy", () => {
  test("is trusted verbatim, even when it contradicts what we knew", () => {
    // Root run stopped AND no delegate left: the server says settled, so the
    // previously-known busy must not survive.
    const previous = row("a", { busy: true, running: true })
    const streamed = row("a", { busy: false, running: false })
    expect(mergeSummary(previous, streamed).busy).toBe(false)
    expect(isSessionBusy(mergeSummary(previous, streamed))).toBe(false)
  })

  test("costs no confirming poll in either direction", () => {
    const previous = row("a", { busy: true, running: true })
    // Root stopped but a sidekick is still working — the case that used to be
    // unknowable from the stream alone.
    expect(needsAuthoritativeBusy(previous, row("a", { busy: true, running: false }))).toBe(false)
    // Root stopped and nothing else is alive.
    expect(needsAuthoritativeBusy(previous, row("a", { busy: false, running: false }))).toBe(false)
  })

  test("settles a session through snapshot and delta without going stale", () => {
    const known = absorbAuthoritative(new Map(), [row("a", { busy: true, running: true })])

    const snap = applySessionSnapshot(known, [row("a", { busy: false, running: false })])
    expect(snap.stale).toEqual([])
    expect(snap.map.get("a")!.busy).toBe(false)

    const delta = applySessionDelta(known, { upsert: [row("a", { busy: false, running: false })], remove: [] })
    expect(delta.stale).toEqual([])
    expect(delta.map.get("a")!.busy).toBe(false)
  })

  test("lets a delegate-only completion drive a tracked running→idle transition", () => {
    const tracker = createCompletionTracker()
    const busyRow = row("a", { busy: true, running: false })
    const idleRow = row("a", { busy: false, running: false })
    // Observed busy first (delegate working while the root run is stopped)...
    trackCompletions(tracker, [{ key: "r:a", sessionId: "a", running: isSessionBusy(busyRow) }], 0, 3_000)
    // ...then the delegate finishes and the stream says so directly.
    const result = trackCompletions(
      tracker,
      [{ key: "r:a", sessionId: "a", running: isSessionBusy(idleRow) }],
      5_000,
      3_000,
    )
    expect(result.completed).toBe(true)
    expect(result.done).toEqual(["a"])
  })
})

describe("a stream from an older server (no busy)", () => {
  test("still keeps the last known busy and asks for a confirming poll", () => {
    const known = absorbAuthoritative(new Map(), [row("a", { busy: true, running: true })])
    const { map, stale } = applySessionDelta(known, { upsert: [row("a", { running: false })], remove: [] })
    expect(stale).toEqual(["a"])
    expect(map.get("a")!.busy).toBe(true)
  })
})
