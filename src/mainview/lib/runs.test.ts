import { describe, expect, test } from "bun:test"
import type { AgentEvent } from "@chunky/protocol"
import { initialState, reduce, MAIN } from "./transcript"
import type { TranscriptState } from "./transcript"
import {
  activeWorkerRows,
  anchoredItemIndices,
  isRunCardLive,
  isSeat,
  runAccent,
  liveRunViews,
  LIVE_TAIL_MAX,
  parkedRunsByItem,
  runAnchors,
  runStatusLabel,
  runTail,
  seatOfThreadId,
  stopTargetOf,
  runSummary,
} from "./runs"
import { applyRunAnchors, itemsToMessages } from "./mapTranscript"

function play(events: AgentEvent[]): TranscriptState {
  return events.reduce(reduce, initialState)
}

/** A turn that delegates to a seat, then the seat finishes. */
const DELEGATING_TURN: AgentEvent[] = [
  { type: "message.user", text: "left-shift the map" },
  { type: "message.start", role: "assistant" },
  { type: "message.delta", text: "On it." },
  { type: "tool.start", id: "t1", name: "sidekick", input: { seat: "frontend" } },
  { type: "thread.spawn", threadId: "sk:frontend", parentThreadId: MAIN, title: "Sidekick (frontend)", model: "grok-4.5" },
  { type: "tool.start", id: "t2", name: "edit", input: { path: "MapShell.tsx" }, threadId: "sk:frontend" },
  { type: "tool.end", id: "t2", ok: true, output: "3 hunks applied", threadId: "sk:frontend" },
  { type: "message.start", role: "assistant", threadId: "sk:frontend" },
  { type: "message.delta", text: "Column pinned left.", threadId: "sk:frontend" },
]

describe("run records", () => {
  test("a spawn opens a run anchored to the pill that caused it", () => {
    const state = play(DELEGATING_TURN)
    expect(state.runs).toHaveLength(1)
    const run = state.runs[0]!
    expect(run.threadId).toBe("sk:frontend")
    expect(run.status).toBe("running")
    // The sidekick tool item is index 2 (user, assistant, tool).
    const items = state.threads[MAIN]!.items
    expect(items[2]).toMatchObject({ kind: "tool", name: "sidekick" })
    // The anchor is frozen onto the pill itself when the run opens.
    expect(run.anchorIndex).toBe(2)
    expect([...runAnchors(state).keys()]).toEqual([2])
  })

  test("tool calls inside the delegate count toward its card", () => {
    expect(play(DELEGATING_TURN).runs[0]!.toolCount).toBe(1)
  })

  test("thread.status idle settles the run and records where it ended", () => {
    const state = play([
      ...DELEGATING_TURN,
      { type: "thread.status", threadId: "sk:frontend", status: "idle" },
    ])
    const run = state.runs[0]!
    expect(run.status).toBe("done")
    expect(run.itemEnd).toBe(state.threads["sk:frontend"]!.items.length)
    expect([...parkedRunsByItem(state).keys()]).toEqual([2])
  })

  test("a re-briefed seat opens a second run at its own pill", () => {
    const state = play([
      ...DELEGATING_TURN,
      { type: "thread.status", threadId: "sk:frontend", status: "idle" },
      { type: "tool.start", id: "t3", name: "sidekick", input: { seat: "frontend" } },
      { type: "thread.spawn", threadId: "sk:frontend", parentThreadId: MAIN, title: "Sidekick (frontend)" },
    ])
    expect(state.runs.map((r) => r.id)).toEqual(["sk:frontend#0", "sk:frontend#1"])
    // Two pills, two anchors — the second run does not steal the first's slot.
    const anchors = runAnchors(state)
    expect([...anchors.keys()].sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([2, 3])
    expect(state.runs[1]!.itemStart).toBe(state.runs[0]!.itemEnd!)
  })

  test("root idle does NOT close a delegate still running (detached child)", () => {
    const state = play([
      ...DELEGATING_TURN,
      { type: "session.status", sessionId: "s1", status: "idle" },
    ])
    // The delegate never reported idle, so its run stays live until it does.
    expect(state.runs[0]!.status).toBe("running")
    const settled = play([
      ...DELEGATING_TURN,
      { type: "session.status", sessionId: "s1", status: "idle" },
      { type: "thread.status", threadId: "sk:frontend", status: "idle" },
    ])
    expect(settled.runs[0]!.status).toBe("done")
  })

  test("seats and one-shot delegates both park beside their own pill", () => {
    const state = play([
      { type: "tool.start", id: "a", name: "sidekick", input: {} },
      { type: "thread.spawn", threadId: "root:sidekick:frontend", parentThreadId: null, title: "Sidekick (frontend)" },
      { type: "thread.status", threadId: "root:sidekick:frontend", status: "idle" },
      { type: "tool.start", id: "b", name: "spawn_thread", input: {} },
      { type: "thread.spawn", threadId: "child-1", parentThreadId: null, title: "docs sweep" },
      { type: "thread.status", threadId: "child-1", status: "idle" },
    ])
    expect(parkedRunsByItem(state).size).toBe(2)
    // The seat is still labelled as one (cards say "Sidekick", not "subagent").
    expect(isSeat(state.threads["root:sidekick:frontend"]!)).toBe(true)
    expect(isSeat(state.threads["child-1"]!)).toBe(false)
  })

  test("demo/offline state has no runs and no anchors", () => {
    expect(initialState.runs).toEqual([])
    expect(runAnchors(initialState).size).toBe(0)
  })
})

describe("delegation, seen from the transcript", () => {
  test("a session that never delegates anchors nothing", () => {
    const plain = play([
      { type: "message.user", text: "hello" },
      { type: "message.start", role: "assistant" },
      { type: "message.delta", text: "hi" },
      { type: "tool.start", id: "t1", name: "read", input: { path: "a.ts" } },
      { type: "tool.end", id: "t1", ok: true, output: "ok" },
    ])
    expect(plain.runs).toEqual([])
    expect(runAnchors(plain).size).toBe(0)
  })

  test("demo/offline (no transcript at all) is treated the same", () => {
    expect(runAnchors(initialState).size).toBe(0)
    expect(anchoredItemIndices(undefined).size).toBe(0)
  })

  test("a settled run stays anchored to its own pill", () => {
    const state = play([
      { type: "tool.start", id: "t1", name: "spawn_thread", input: { title: "docs" } },
      { type: "thread.spawn", threadId: "child-1", parentThreadId: null, title: "docs sweep" },
      { type: "thread.status", threadId: "child-1", status: "idle" },
    ])
    expect(state.runs).toHaveLength(1)
    expect(parkedRunsByItem(state).size).toBe(1)
  })
})

describe("card content", () => {
  test("the tail is the last lines of the delegate's own output", () => {
    const state = play(DELEGATING_TURN)
    const items = state.threads["sk:frontend"]!.items
    const tail = runTail(items, 0, 5)
    expect(tail.map((l) => l.text)).toEqual([
      "› edit MapShell.tsx",
      "  ✓ 3 hunks applied",
      "Column pinned left.",
    ])
    expect(tail.at(-1)!.tone).toBe("text")
  })

  test("the tail keeps only the newest lines", () => {
    const state = play(DELEGATING_TURN)
    const items = state.threads["sk:frontend"]!.items
    expect(runTail(items, 0, 2)).toHaveLength(2)
    expect(runTail(items, 0, 2)[1]!.text).toBe("Column pinned left.")
  })

  test("a condensed card summarizes with the delegate's last words", () => {
    const state = play(DELEGATING_TURN)
    expect(runSummary(state.threads["sk:frontend"]!.items)).toBe("Column pinned left.")
  })

})

describe("live delegate streams", () => {
  test("a running run exposes its own tail, title, model and tool count", () => {
    const views = liveRunViews(play(DELEGATING_TURN))
    expect([...views.keys()]).toEqual(["sk:frontend#0"])
    const view = views.get("sk:frontend#0")!
    expect(view.threadId).toBe("sk:frontend")
    expect(view.title).toBe("Sidekick (frontend)")
    expect(view.model).toBe("grok-4.5")
    expect(view.toolCount).toBe(1)
    expect(view.lines.map((l) => l.text)).toEqual([
      "› edit MapShell.tsx",
      "  ✓ 3 hunks applied",
      "Column pinned left.",
    ])
  })

  test("a settled run has no live view — the card goes back to normal", () => {
    const state = play([
      ...DELEGATING_TURN,
      { type: "thread.status", threadId: "sk:frontend", status: "idle" },
    ])
    expect(liveRunViews(state).size).toBe(0)
  })

  test("a spawned run with no output yet still gets a (waiting) view", () => {
    const state = play([
      { type: "tool.start", id: "t1", name: "spawn_thread", input: { title: "docs" } },
      { type: "thread.spawn", threadId: "child-1", parentThreadId: MAIN, title: "docs sweep" },
    ])
    const view = liveRunViews(state).get("child-1#0")!
    expect(view.lines).toEqual([])
    expect(view.title).toBe("docs sweep")
  })

  test("the tail is bounded however chatty the delegate gets", () => {
    const chatter: AgentEvent[] = []
    for (let i = 0; i < 40; i++) {
      chatter.push({ type: "message.start", role: "assistant", threadId: "sk:frontend" })
      chatter.push({ type: "message.delta", text: `line ${i}`, threadId: "sk:frontend" })
      chatter.push({ type: "message.end", threadId: "sk:frontend" })
    }
    const view = liveRunViews(play([...DELEGATING_TURN, ...chatter])).get("sk:frontend#0")!
    expect(view.lines).toHaveLength(LIVE_TAIL_MAX)
    expect(view.lines.at(-1)!.text).toBe("line 39")
  })

  test("concurrent delegates each stream their own run", () => {
    const state = play([
      { type: "tool.start", id: "t1", name: "sidekick", input: { seat: "frontend" } },
      { type: "thread.spawn", threadId: "sk:frontend", parentThreadId: MAIN, title: "Sidekick (frontend)" },
      { type: "tool.start", id: "t2", name: "sidekick", input: { seat: "backend" } },
      { type: "thread.spawn", threadId: "sk:backend", parentThreadId: MAIN, title: "Sidekick (backend)" },
      { type: "message.start", role: "assistant", threadId: "sk:frontend" },
      { type: "message.delta", text: "front half", threadId: "sk:frontend" },
      { type: "message.start", role: "assistant", threadId: "sk:backend" },
      { type: "message.delta", text: "back half", threadId: "sk:backend" },
    ])
    const views = liveRunViews(state)
    expect(views.get("sk:frontend#0")!.lines.at(-1)!.text).toBe("front half")
    expect(views.get("sk:backend#0")!.lines.at(-1)!.text).toBe("back half")
    // Each pill owns exactly its own run.
    const anchors = [...runAnchors(state).values()]
    expect(anchors.map((a) => a.liveRunIds)).toEqual([["sk:frontend#0"], ["sk:backend#0"]])
  })

  test("two delegates that land on the same pill both keep their stream", () => {
    // Both tool.starts arrive before either spawn: the anchor pill is the same
    // for both runs, so the card must carry two live sections, not one.
    const state = play([
      { type: "tool.start", id: "t1", name: "sidekick", input: { seat: "frontend" } },
      { type: "thread.spawn", threadId: "sk:frontend", parentThreadId: MAIN, title: "Sidekick (frontend)" },
      { type: "thread.spawn", threadId: "sk:backend", parentThreadId: MAIN, title: "Sidekick (backend)" },
    ])
    const anchor = [...runAnchors(state).values()][0]!
    expect(anchor.liveRunIds).toEqual(["sk:frontend#0", "sk:backend#0"])
    expect(anchor.liveRunId).toBe("sk:frontend#0")

    const messages = applyRunAnchors(
      itemsToMessages(state.threads[MAIN]!.items, undefined, anchoredItemIndices(state)),
      runAnchors(state),
    )
    const pill = messages.flatMap((m) => m.blocks).find((b) => b.runIds)!
    expect(pill.runIds).toEqual(["sk:frontend#0", "sk:backend#0"])
  })

  test("a session that never delegates has no live views (no-stream case)", () => {
    expect(liveRunViews(undefined).size).toBe(0)
    expect(liveRunViews(initialState).size).toBe(0)
  })
})

describe("run anchors on the pill", () => {
  const pillOf = (state: TranscriptState) => {
    const messages = applyRunAnchors(
      itemsToMessages(state.threads[MAIN]!.items, undefined, anchoredItemIndices(state)),
      runAnchors(state),
    )
    return messages.flatMap((m) => m.blocks).find((b) => b.runId || b.settledRunIds)
  }

  test("a settled run hangs off the pill that spawned it \u2014 no second home", () => {
    const state = play([
      ...DELEGATING_TURN,
      { type: "thread.status", threadId: "sk:frontend", status: "idle" },
    ])
    const pill = pillOf(state)!
    expect(pill.type).toBe("tool")
    expect(pill.tool!.name).toBe("sidekick")
    expect(pill.settledRunIds).toEqual(["sk:frontend#0"])
    // Settled: nothing is streaming into it any more.
    expect(pill.runIds).toBeUndefined()
    expect(pill.accent).toBeTruthy()
  })

  test("a running run marks its pill live, and has nothing settled yet", () => {
    const pill = pillOf(play(DELEGATING_TURN))!
    expect(pill.runId).toBe("sk:frontend#0")
    expect(pill.runIds).toEqual(["sk:frontend#0"])
    expect(pill.settledRunIds).toBeUndefined()
  })

  test("stamping never splits or reorders a message", () => {
    const state = play([
      ...DELEGATING_TURN,
      { type: "thread.status", threadId: "sk:frontend", status: "idle" },
    ])
    const messages = itemsToMessages(
      state.threads[MAIN]!.items,
      undefined,
      anchoredItemIndices(state),
    )
    const stamped = applyRunAnchors(messages, runAnchors(state))
    expect(stamped).toHaveLength(messages.length)
    expect(stamped.map((m) => m.id)).toEqual(messages.map((m) => m.id))
    expect(stamped.map((m) => m.blocks.length)).toEqual(messages.map((m) => m.blocks.length))
  })

  test("with no runs the messages come back untouched (demo mode)", () => {
    const messages = itemsToMessages([
      { kind: "user", text: "hi" },
      { kind: "assistant", text: "hello", streaming: false },
    ])
    expect(applyRunAnchors(messages, new Map())).toBe(messages)
  })
})

describe("active workers strip", () => {
  /** The strip's whole reason to exist: the root turn ended, the delegate did
   *  not. Same stream the pill renders, minus the lead's own liveness. */
  const ROOT_IDLE_WITH_WORKER: AgentEvent[] = [
    { type: "session.status", sessionId: "s", status: "running" },
    ...DELEGATING_TURN,
    { type: "message.end", reason: "complete" },
    { type: "session.status", sessionId: "s", status: "idle" },
  ]

  test("live runs + idle root → one row per run, with the pill's own tail", () => {
    const state = play(ROOT_IDLE_WITH_WORKER)
    const rows = activeWorkerRows(state, false)
    expect(rows).toHaveLength(1)
    const row = rows[0]!
    expect(row.runId).toBe("sk:frontend#0")
    expect(row.title).toBe("Sidekick (frontend)")
    expect(row.model).toBe("grok-4.5")
    expect(row.seat).toBe(true)
    expect(row.toolCount).toBe(1)
    expect(row.accent).toBe(runAccent(row.runId))
    // No second tail state: the row's line is the last line of the view the
    // pill's LiveRunSection renders.
    const view = liveRunViews(state).get(row.runId)!
    expect(row.lastLine).toEqual(view.lines[view.lines.length - 1]!)
  })

  test("hidden while the root turn is still running", () => {
    const state = play(ROOT_IDLE_WITH_WORKER)
    // Either signal is enough: App's `streaming`, or the reduced root status.
    expect(activeWorkerRows(state, true)).toHaveLength(0)
    const rootRunning = reduce(state, { type: "session.status", sessionId: "s", status: "running" })
    expect(activeWorkerRows(rootRunning, false)).toHaveLength(0)
  })

  test("hidden with no live runs — including one that settles after the lead is idle", () => {
    expect(activeWorkerRows(undefined, false)).toHaveLength(0)
    expect(activeWorkerRows(initialState, false)).toHaveLength(0)
    const settled = play([
      ...ROOT_IDLE_WITH_WORKER,
      { type: "thread.status", threadId: "sk:frontend", status: "idle" },
    ])
    expect(settled.runs[0]!.status).toBe("done")
    expect(activeWorkerRows(settled, false)).toHaveLength(0)
  })

  test("a one-shot spawn is not a seat", () => {
    const state = play([
      { type: "tool.start", id: "t1", name: "spawn_thread", input: { title: "Audit" } },
      { type: "thread.spawn", threadId: "spawn:1", parentThreadId: MAIN, title: "Audit deps" },
      { type: "session.status", sessionId: "s", status: "idle" },
    ])
    const rows = activeWorkerRows(state, false)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.seat).toBe(false)
    expect(rows[0]!.lastLine).toBeUndefined()
  })
})

describe("collapse exemption for still-running cards", () => {
  test("a card for a run still in flight is exempt; a settled one is not", () => {
    const live = play(DELEGATING_TURN)
    const run = live.runs[0]!
    expect(isRunCardLive(live, run.threadId, run)).toBe(true)

    const settled = reduce(live, {
      type: "thread.status",
      threadId: "sk:frontend",
      status: "idle",
    })
    expect(isRunCardLive(settled, "sk:frontend", settled.runs[0]!)).toBe(false)
  })

  test("the run wins over the thread: a re-briefed seat cannot re-open an old pass", () => {
    const rebriefed = play([
      ...DELEGATING_TURN,
      { type: "thread.status", threadId: "sk:frontend", status: "idle" },
      { type: "thread.status", threadId: "sk:frontend", status: "running" },
    ])
    const [first, second] = rebriefed.runs
    expect(first!.status).toBe("done")
    expect(second!.status).toBe("running")
    // The card showing the FIRST pass folds normally…
    expect(isRunCardLive(rebriefed, "sk:frontend", first)).toBe(false)
    // …while the seat itself, and the pass in flight, stay expanded.
    expect(isRunCardLive(rebriefed, "sk:frontend", second)).toBe(true)
    expect(isRunCardLive(rebriefed, "sk:frontend")).toBe(true)
  })

  test("a thread-only card follows its thread, and unknown state never exempts", () => {
    const live = play(DELEGATING_TURN)
    expect(isRunCardLive(live, "sk:frontend")).toBe(true)
    expect(isRunCardLive(live, "nobody")).toBe(false)
    expect(isRunCardLive(undefined, "sk:frontend")).toBe(false)
  })
})

describe("cancelled runs keep their place", () => {
  const CANCELLED = play([
    ...DELEGATING_TURN,
    { type: "thread.status", threadId: "sk:frontend", status: "cancelled" },
  ])

  test("a cancelled run parks on its pill exactly like a finished one", () => {
    const run = CANCELLED.runs[0]!
    expect(run.status).toBe("cancelled")
    expect(parkedRunsByItem(CANCELLED).get(2)).toEqual([run])
    const anchor = runAnchors(CANCELLED).get(2)!
    expect(anchor.parkedRunIds).toEqual([run.id])
    expect(anchor.liveRunIds).toEqual([])
    // Still an anchored pill: the mapper must keep it a standalone block.
    expect([...anchoredItemIndices(CANCELLED)]).toEqual([2])
  })

  test("it stops streaming and stops counting as an active worker", () => {
    expect(liveRunViews(CANCELLED).size).toBe(0)
    expect(activeWorkerRows(CANCELLED, false)).toEqual([])
    expect(isRunCardLive(CANCELLED, "sk:frontend", CANCELLED.runs[0]!)).toBe(false)
  })

  test("its label is distinct from both done and running", () => {
    expect(runStatusLabel({ status: "cancelled" })).toBe("Cancelled")
    expect(runStatusLabel({ status: "done" })).toBe("Done")
    expect(runStatusLabel({ status: "running" })).toBe("Running")
  })
})

describe("stop targets", () => {
  const RUNNING_ON = (threadId: string) => ({ status: "running" as const, threadId })

  test("a sync sidekick is targeted by its stable seat", () => {
    expect(stopTargetOf(RUNNING_ON("sess-1:sidekick:frontend"))).toEqual({ seat: "frontend" })
    // The default seat is addressed by omitting `seat` entirely.
    expect(stopTargetOf(RUNNING_ON("sess-1:sidekick"))).toEqual({})
    expect(seatOfThreadId("sess-1:sidekick")).toBe("default")
    expect(seatOfThreadId("sess-1:sidekick:backend")).toBe("backend")
  })

  test("a detached spawn is targeted by the run id it printed into its pill", () => {
    const output = 'Detached child "Recon" launched: 3f1c2a44-9b1e-4c77-8a55-1f2e3d4c5b6a. It runs concurrently.'
    expect(stopTargetOf(RUNNING_ON("child-3f1c2a44"), { toolOutput: output, liveRunCount: 1 })).toEqual({
      runId: "3f1c2a44-9b1e-4c77-8a55-1f2e3d4c5b6a",
    })
  })

  test("nothing is offered when the target cannot be derived", () => {
    // A plain spawned child: no seat, no launched id.
    expect(stopTargetOf(RUNNING_ON("child-abc"))).toBeNull()
    // A DETACHED sidekick wears `:sidekick:<uuid>`; that uuid is not a seat.
    expect(stopTargetOf(RUNNING_ON("sess-1:sidekick:3f1c2a44-9b1e-4c77-8a55-1f2e3d4c5b6a"))).toBeNull()
    expect(seatOfThreadId("sess-1:sidekick:3f1c2a44-9b1e-4c77-8a55-1f2e3d4c5b6a")).toBeNull()
    // Two live runs on one pill: the single launched id cannot name one of them.
    const output = "Detached child launched: 3f1c2a44-9b1e-4c77-8a55-1f2e3d4c5b6a."
    expect(stopTargetOf(RUNNING_ON("child-abc"), { toolOutput: output, liveRunCount: 2 })).toBeNull()
  })

  test("a settled run is never stoppable, however it settled", () => {
    expect(stopTargetOf({ status: "done", threadId: "sess-1:sidekick:frontend" })).toBeNull()
    expect(stopTargetOf({ status: "cancelled", threadId: "sess-1:sidekick:frontend" })).toBeNull()
  })
})

describe("a cancelled delegate reads as cancelled, not failed", () => {
  const MID_TOOL = play([
    { type: "tool.start", id: "t1", name: "sidekick", input: { seat: "frontend" } },
    { type: "thread.spawn", threadId: "sk:frontend", parentThreadId: MAIN, title: "Sidekick (frontend)" },
    { type: "tool.start", id: "t2", name: "bash", input: { command: "bun test" }, threadId: "sk:frontend" },
    { type: "thread.status", threadId: "sk:frontend", status: "cancelled" },
  ])
  const items = () => MID_TOOL.threads["sk:frontend"]!.items

  test("its tail says cancelled in the dim tone — never ✗ / fail", () => {
    const tail = runTail(items(), 0)
    const last = tail[tail.length - 1]!
    expect(last.tone).toBe("dim")
    expect(last.text).toContain("cancelled")
    expect(tail.some((line) => line.tone === "fail")).toBe(false)
    expect(tail.some((line) => line.text.includes("✗"))).toBe(false)
  })

  test("the one-line gist a parked card shows says cancelled too", () => {
    const gist = runSummary(items(), 0)
    expect(gist).toContain("cancelled")
    expect(gist).not.toContain("failed")
  })

  test("a genuine failure inside the delegate still reads as a failure", () => {
    const failed = play([
      { type: "tool.start", id: "t1", name: "sidekick", input: { seat: "frontend" } },
      { type: "thread.spawn", threadId: "sk:frontend", parentThreadId: MAIN, title: "Sidekick (frontend)" },
      { type: "tool.start", id: "t2", name: "bash", input: { command: "bun test" }, threadId: "sk:frontend" },
      { type: "tool.end", id: "t2", ok: false, output: "error: 3 tests failed", threadId: "sk:frontend" },
      { type: "thread.status", threadId: "sk:frontend", status: "cancelled" },
    ])
    const tail = runTail(failed.threads["sk:frontend"]!.items, 0)
    expect(tail.some((line) => line.tone === "fail" && line.text.includes("✗"))).toBe(true)
  })
})

describe("detached run ids, in both of the server's wordings", () => {
  const RUNNING_ON = (threadId: string) => ({ status: "running" as const, threadId })
  const ID = "3f1c2a44-9b1e-4c77-8a55-1f2e3d4c5b6a"

  test("spawn_thread's `launched:` form", () => {
    expect(
      stopTargetOf(RUNNING_ON("child-x"), {
        toolOutput: `Detached child "Recon" launched: ${ID}. It runs concurrently.`,
      }),
    ).toEqual({ runId: ID })
  })

  test("explicit / steer detach's `Run id:` form", () => {
    expect(
      stopTargetOf(RUNNING_ON("wf-x"), {
        toolOutput: `Workflow detached by steer; the worker continues and its report will arrive as a wake/reminder. Run id: ${ID}.`,
      }),
    ).toEqual({ runId: ID })
  })

  test("a DETACHED sidekick is still targeted by its stable seat", () => {
    // Detaching does not move the worker off its seat thread, so the seat
    // route (which the server reconciles with the detached record) applies —
    // and it wins nothing from the bookkeeping id in the pill's text.
    expect(
      stopTargetOf(RUNNING_ON("sess-1:sidekick:frontend"), {
        toolOutput: `Sidekick (frontend) detached; the worker continues. Run id: ${ID}.`,
      }),
    ).toEqual({ runId: ID })
    expect(stopTargetOf(RUNNING_ON("sess-1:sidekick:frontend"))).toEqual({ seat: "frontend" })
  })

  test("prose that merely mentions a run id does not become a target", () => {
    expect(stopTargetOf(RUNNING_ON("child-x"), { toolOutput: `see run ${ID}` })).toBeNull()
  })
})
