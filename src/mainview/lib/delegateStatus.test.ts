// Folding a server delegate snapshot into the transcript's own projection.
//
// The rules under test are the ones that keep a poll from lying to the reader:
// match by run id first and thread id second (NEVER by the app-local
// RunRecord.id), settle only what the stream has not settled, and never revive.
import { describe, expect, test } from "bun:test"
import {
  createDelegatePoll,
  mergeDelegateStatus,
  mergeIsEmpty,
  mergedAnchors,
  mergedRunRecords,
  mergedViews,
  type DelegateRunStatus,
} from "./delegateStatus"
import type { DelegatesResult } from "./api"
import type { LiveRunView, RunAnchor } from "./runs"
import type { RunRecord } from "./transcript"

const THREAD = "sess-1:sidekick:frontend"

function record(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: `${THREAD}#0`,
    threadId: THREAD,
    parentId: "main",
    title: "Sidekick (frontend)",
    status: "running",
    anchorIndex: 2,
    itemStart: 0,
    toolCount: 3,
    ...overrides,
  }
}

function row(overrides: Partial<DelegateRunStatus> = {}): DelegateRunStatus {
  return {
    kind: "sidekick",
    threadId: THREAD,
    title: "Sidekick (frontend)",
    status: "running",
    elapsedMs: 42_000,
    ...overrides,
  }
}

function index(records: RunRecord[]): Map<string, RunRecord> {
  return new Map(records.map((r) => [r.id, r]))
}

describe("matching a snapshot row to a run", () => {
  test("thread id matches, and the server's elapsed is what the card should show", () => {
    const runs = index([record()])
    const merge = mergeDelegateStatus({ runs, snapshot: [row({ elapsedMs: 90_000 })] })
    expect(merge.elapsedMs.get(`${THREAD}#0`)).toBe(90_000)
    expect(merge.settled.size).toBe(0)
    expect(mergeIsEmpty(merge)).toBe(false)
  })

  test("a run id match wins over the thread id one", () => {
    const runs = index([record()])
    const merge = mergeDelegateStatus({
      runs,
      snapshot: [
        row({ elapsedMs: 1_000 }),
        row({ runId: "run-7", threadId: "some:other:thread", elapsedMs: 77_000 }),
      ],
      serverRunIds: new Map([[`${THREAD}#0`, "run-7"]]),
    })
    expect(merge.elapsedMs.get(`${THREAD}#0`)).toBe(77_000)
  })

  test("RunRecord.id is NEVER a lookup key", () => {
    // `${threadId}#0` is an app id the server has never seen. A row whose
    // run_id happens to equal it must not match by accident.
    const runs = index([record()])
    const merge = mergeDelegateStatus({
      runs,
      snapshot: [row({ runId: `${THREAD}#0`, threadId: "unrelated:thread", elapsedMs: 5_000 })],
    })
    expect(merge.elapsedMs.size).toBe(0)
    expect(mergeIsEmpty(merge)).toBe(true)
  })

  test("nothing to match against is an empty merge", () => {
    expect(mergeIsEmpty(mergeDelegateStatus({ runs: index([record()]), snapshot: null }))).toBe(true)
    expect(mergeIsEmpty(mergeDelegateStatus({ runs: index([]), snapshot: [row()] }))).toBe(true)
    expect(mergeIsEmpty(mergeDelegateStatus({ runs: index([record()]), snapshot: [] }))).toBe(true)
  })

  test("two live runs on one thread id are ambiguous, so neither is touched", () => {
    const runs = index([record(), record({ id: `${THREAD}#1` })])
    const merge = mergeDelegateStatus({ runs, snapshot: [row({ status: "completed" })] })
    expect(mergeIsEmpty(merge)).toBe(true)
  })

  test("…unless a run id names one of them", () => {
    const runs = index([record(), record({ id: `${THREAD}#1` })])
    const merge = mergeDelegateStatus({
      runs,
      snapshot: [row({ runId: "run-9", status: "completed", elapsedMs: 3_000 })],
      serverRunIds: new Map([[`${THREAD}#1`, "run-9"]]),
    })
    expect(merge.settled.get(`${THREAD}#1`)).toBe("done")
    expect(merge.settled.has(`${THREAD}#0`)).toBe(false)
  })
})

describe("who wins on status", () => {
  test("the server settles a run the stream still shows running", () => {
    const runs = index([record()])
    expect(
      mergeDelegateStatus({ runs, snapshot: [row({ status: "completed" })] }).settled.get(
        `${THREAD}#0`,
      ),
    ).toBe("done")
    // `failed` has no RunRecord state of its own: the delegate's transcript
    // already carries whatever went wrong, so it parks as done.
    expect(
      mergeDelegateStatus({ runs, snapshot: [row({ status: "failed" })] }).settled.get(
        `${THREAD}#0`,
      ),
    ).toBe("done")
    expect(
      mergeDelegateStatus({ runs, snapshot: [row({ status: "cancelled" })] }).settled.get(
        `${THREAD}#0`,
      ),
    ).toBe("cancelled")
  })

  test("a settled stream run is final — a `running` row cannot revive it", () => {
    for (const status of ["done", "cancelled"] as const) {
      const runs = index([record({ status })])
      const merge = mergeDelegateStatus({ runs, snapshot: [row({ status: "running" })] })
      expect(merge.settled.size).toBe(0)
      // Elapsed still tracks the server, which is fine: only the STATUS is
      // owned by the stream.
      expect(merge.elapsedMs.get(`${THREAD}#0`)).toBe(42_000)
      expect(mergedRunRecords(runs, merge).get(`${THREAD}#0`)!.status).toBe(status)
    }
  })

  test("the stream's own cancellation is not overwritten by a `completed` row", () => {
    const runs = index([record({ status: "cancelled" })])
    const merge = mergeDelegateStatus({ runs, snapshot: [row({ status: "completed" })] })
    expect(mergedRunRecords(runs, merge).get(`${THREAD}#0`)!.status).toBe("cancelled")
  })
})

describe("applying the merge to the projection", () => {
  const merge = mergeDelegateStatus({
    runs: index([record()]),
    snapshot: [row({ status: "cancelled" })],
  })

  test("run records are COPIED, never mutated", () => {
    const original = record()
    const runs = index([original])
    const next = mergedRunRecords(runs, merge)
    expect(next.get(`${THREAD}#0`)!.status).toBe("cancelled")
    // The reduced transcript's own record is untouched.
    expect(original.status).toBe("running")
    expect(runs.get(`${THREAD}#0`)!.status).toBe("running")
  })

  test("a settled run stops streaming a live tail", () => {
    const view: LiveRunView = {
      runId: `${THREAD}#0`,
      threadId: THREAD,
      title: "Sidekick (frontend)",
      toolCount: 3,
      lines: [],
    }
    const views = new Map([[view.runId, view]])
    expect(mergedViews(views, merge).size).toBe(0)
    // …and the source map is left alone.
    expect(views.size).toBe(1)
  })

  test("its pill keeps the run: live list → parked list, same hue", () => {
    const anchors = new Map<number, RunAnchor>([
      [2, { liveRunId: `${THREAD}#0`, liveRunIds: [`${THREAD}#0`], parkedRunIds: [], accent: "#abc" }],
    ])
    const next = mergedAnchors(anchors, merge)
    expect(next.get(2)).toEqual({ liveRunIds: [], parkedRunIds: [`${THREAD}#0`], accent: "#abc" })
    expect(anchors.get(2)!.liveRunIds).toEqual([`${THREAD}#0`])
  })

  test("a pill with two live runs keeps the other one live", () => {
    const anchors = new Map<number, RunAnchor>([
      [
        2,
        {
          liveRunId: `${THREAD}#0`,
          liveRunIds: [`${THREAD}#0`, "other#0"],
          parkedRunIds: [],
          accent: "#abc",
        },
      ],
    ])
    const next = mergedAnchors(anchors, merge)
    expect(next.get(2)).toEqual({
      liveRunId: "other#0",
      liveRunIds: ["other#0"],
      parkedRunIds: [`${THREAD}#0`],
      accent: "#abc",
    })
  })

  test("an empty merge changes nothing at all (the unsupported-server case)", () => {
    const empty = mergeDelegateStatus({ runs: index([record()]), snapshot: null })
    const anchors = new Map<number, RunAnchor>([
      [2, { liveRunId: "a", liveRunIds: ["a"], parkedRunIds: [], accent: "#abc" }],
    ])
    expect(mergeIsEmpty(empty)).toBe(true)
    expect(mergedAnchors(anchors, empty).get(2)).toEqual(anchors.get(2)!)
  })
})

/* ---------------------------------------------------------------- the poll */

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

describe("createDelegatePoll", () => {
  test("commits each snapshot it gets", async () => {
    const snapshots: DelegateRunStatus[][] = []
    const poll = createDelegatePoll({
      fetchDelegates: async () => ({ status: "ok", runs: [row()] }),
      onSnapshot: (runs) => snapshots.push(runs),
    })
    await poll.tick("http://localhost:4620", "sess-1")
    await poll.tick("http://localhost:4620", "sess-1")
    expect(snapshots).toHaveLength(2)
  })

  test("never lets two requests overlap", async () => {
    const gate = deferred<DelegatesResult>()
    let calls = 0
    const poll = createDelegatePoll({
      fetchDelegates: () => {
        calls += 1
        return gate.promise
      },
      onSnapshot: () => {},
    })
    const first = poll.tick("http://localhost:4620", "sess-1")
    // The interval fires again while the server is still thinking: no request.
    await poll.tick("http://localhost:4620", "sess-1")
    expect(calls).toBe(1)
    expect(poll.inFlight).toBe(true)
    gate.resolve({ status: "ok", runs: [] })
    await first
    // Once it lands, the next tick goes out normally.
    await poll.tick("http://localhost:4620", "sess-1")
    expect(calls).toBe(2)
  })

  test("an unsupported answer stops the poll for good, and says so once", async () => {
    let calls = 0
    const unsupported: string[] = []
    const poll = createDelegatePoll({
      fetchDelegates: async () => {
        calls += 1
        return { status: "unsupported" }
      },
      onSnapshot: () => {},
      onUnsupported: (baseUrl) => unsupported.push(baseUrl),
    })
    await poll.tick("http://localhost:4620", "sess-1")
    await poll.tick("http://localhost:4620", "sess-1")
    await poll.tick("http://localhost:4620", "sess-1")
    expect(calls).toBe(1)
    expect(unsupported).toEqual(["http://localhost:4620"])
    expect(poll.stopped).toBe(true)
  })

  test("an error keeps the last snapshot and simply waits for the next tick", async () => {
    const snapshots: DelegateRunStatus[][] = []
    let next: DelegatesResult = { status: "ok", runs: [row()] }
    const poll = createDelegatePoll({
      fetchDelegates: async () => next,
      onSnapshot: (runs) => snapshots.push(runs),
    })
    await poll.tick("http://localhost:4620", "sess-1")
    next = { status: "error", message: "boom" }
    await poll.tick("http://localhost:4620", "sess-1")
    expect(snapshots).toHaveLength(1)
    expect(poll.stopped).toBe(false)
    next = { status: "ok", runs: [] }
    await poll.tick("http://localhost:4620", "sess-1")
    expect(snapshots).toHaveLength(2)
  })

  test("a response that lands after stop() commits nothing", async () => {
    const gate = deferred<DelegatesResult>()
    const snapshots: DelegateRunStatus[][] = []
    const poll = createDelegatePoll({
      fetchDelegates: () => gate.promise,
      onSnapshot: (runs) => snapshots.push(runs),
    })
    const inFlight = poll.tick("http://localhost:4620", "sess-1")
    poll.stop()
    gate.resolve({ status: "ok", runs: [row()] })
    await inFlight
    expect(snapshots).toHaveLength(0)
  })

  test("no server or no session is no request", async () => {
    let calls = 0
    const poll = createDelegatePoll({
      fetchDelegates: async () => {
        calls += 1
        return { status: "ok", runs: [] }
      },
      onSnapshot: () => {},
    })
    await poll.tick("", "sess-1")
    await poll.tick("http://localhost:4620", "")
    expect(calls).toBe(0)
  })
})
