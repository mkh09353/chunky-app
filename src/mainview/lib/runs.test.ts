import { describe, expect, test } from "bun:test"
import type { AgentEvent } from "@chunky/protocol"
import { initialState, reduce, MAIN } from "./transcript"
import type { TranscriptState } from "./transcript"
import {
  anchoredItemIndices,
  isSeat,
  liveRunViews,
  LIVE_TAIL_MAX,
  parkedRunsByItem,
  runAnchors,
  runTail,
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
