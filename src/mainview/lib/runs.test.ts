import { describe, expect, test } from "bun:test"
import type { AgentEvent } from "@chunky/protocol"
import { initialState, reduce, MAIN } from "./transcript"
import type { TranscriptState } from "./transcript"
import {
  hasLiveAgents,
  hasRuns,
  idleThreads,
  parkedRunsByItem,
  runAnchors,
  runTail,
  runSummary,
  seatName,
} from "./runs"
import { buildTranscriptRows, itemsToMessages } from "./mapTranscript"

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

  test("a settled session sweeps runs whose idle frame never arrived", () => {
    const state = play([
      ...DELEGATING_TURN,
      { type: "session.status", sessionId: "s1", status: "idle" },
    ])
    expect(state.runs[0]!.status).toBe("done")
  })

  test("only sidekick seats idle in the rail; one-shot delegates just settle", () => {
    const state = play([
      { type: "tool.start", id: "a", name: "sidekick", input: {} },
      { type: "thread.spawn", threadId: "root:sidekick:frontend", parentThreadId: null, title: "Sidekick (frontend)" },
      { type: "thread.status", threadId: "root:sidekick:frontend", status: "idle" },
      { type: "tool.start", id: "b", name: "spawn_thread", input: {} },
      { type: "thread.spawn", threadId: "child-1", parentThreadId: null, title: "docs sweep" },
      { type: "thread.status", threadId: "child-1", status: "idle" },
    ])
    // Both runs park in the gutter …
    expect(parkedRunsByItem(state).size).toBe(2)
    // … but only the persistent seat lingers as an idle agent.
    expect(idleThreads(state).map((t) => t.id)).toEqual(["root:sidekick:frontend"])
  })

  test("demo/offline state has no runs and no anchors", () => {
    expect(initialState.runs).toEqual([])
    expect(runAnchors(initialState).size).toBe(0)
  })
})

describe("gutter + rail switches", () => {
  test("a session that never delegates has no gutter and no rail", () => {
    const plain = play([
      { type: "message.user", text: "hello" },
      { type: "message.start", role: "assistant" },
      { type: "message.delta", text: "hi" },
      { type: "tool.start", id: "t1", name: "read", input: { path: "a.ts" } },
      { type: "tool.end", id: "t1", ok: true, output: "ok" },
    ])
    expect(hasRuns(plain)).toBe(false)
    expect(hasLiveAgents(plain)).toBe(false)
    expect(runAnchors(plain).size).toBe(0)
  })

  test("demo/offline (no transcript at all) is treated the same", () => {
    expect(hasRuns(undefined)).toBe(false)
    expect(hasLiveAgents(undefined)).toBe(false)
    expect(hasRuns(initialState)).toBe(false)
  })

  test("one delegation switches the gutter on, and the rail with it", () => {
    const state = play(DELEGATING_TURN)
    expect(hasRuns(state)).toBe(true)
    expect(hasLiveAgents(state)).toBe(true)
  })

  test("once every run has settled the gutter stays, but the rail goes away", () => {
    // A one-shot subagent: its card parks in the gutter, and nothing is left
    // to show in the rail (no seat to sit idle).
    const state = play([
      { type: "tool.start", id: "t1", name: "spawn_thread", input: { title: "docs" } },
      { type: "thread.spawn", threadId: "child-1", parentThreadId: null, title: "docs sweep" },
      { type: "thread.status", threadId: "child-1", status: "idle" },
    ])
    expect(hasRuns(state)).toBe(true)
    expect(hasLiveAgents(state)).toBe(false)
    expect(parkedRunsByItem(state).size).toBe(1)
  })

  test("a settled seat keeps the rail alive as an idle agent", () => {
    const state = play([
      { type: "tool.start", id: "t1", name: "sidekick", input: { seat: "frontend" } },
      { type: "thread.spawn", threadId: "root:sidekick:frontend", parentThreadId: null, title: "Sidekick (frontend)" },
      { type: "thread.status", threadId: "root:sidekick:frontend", status: "idle" },
    ])
    expect(hasLiveAgents(state)).toBe(true)
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

  test("seat names come off the thread title", () => {
    expect(seatName("Sidekick (frontend)")).toBe("frontend")
    expect(seatName("docs sweep")).toBe("docs sweep")
  })
})

describe("transcript rows", () => {
  test("an assistant message splits at the pill that spawned a run", () => {
    const state = play([
      ...DELEGATING_TURN,
      { type: "thread.status", threadId: "sk:frontend", status: "idle" },
    ])
    const messages = itemsToMessages(state.threads[MAIN]!.items)
    const rows = buildTranscriptRows(messages, runAnchors(state))

    // user row, assistant prose row, then the pill row carrying the card.
    const pillRow = rows.find((r) => r.parkedRunIds.length > 0)
    expect(pillRow).toBeDefined()
    expect(pillRow!.parkedRunIds).toEqual(["sk:frontend#0"])
    expect(pillRow!.blocks[0]!.type).toBe("tool")
    expect(pillRow!.blocks[0]!.accent).toBeTruthy()
    expect(pillRow!.continuation).toBe(true)
    // Exactly one row owns the run: no duplicate cards down the transcript.
    expect(rows.filter((r) => r.parkedRunIds.length > 0)).toHaveLength(1)
  })

  test("a running run marks its pill for the wire, and parks nothing", () => {
    const state = play(DELEGATING_TURN)
    const messages = itemsToMessages(state.threads[MAIN]!.items)
    const rows = buildTranscriptRows(messages, runAnchors(state))
    const pillRow = rows.find((r) => r.blocks.some((b) => b.runId))
    expect(pillRow!.blocks[0]!.runId).toBe("sk:frontend#0")
    expect(pillRow!.parkedRunIds).toEqual([])
  })

  test("only the last slice of a message shows the caret and actions", () => {
    const state = play(DELEGATING_TURN)
    const messages = itemsToMessages(state.threads[MAIN]!.items)
    const rows = buildTranscriptRows(messages, runAnchors(state))
    const slices = rows.filter((r) => r.message.role === "assistant")
    expect(slices.length).toBeGreaterThan(1)
    expect(slices.filter((r) => r.lastSegment)).toHaveLength(1)
    expect(slices.at(-1)!.lastSegment).toBe(true)
  })

  test("with no runs, rows are just the messages (demo mode)", () => {
    const messages = itemsToMessages([
      { kind: "user", text: "hi" },
      { kind: "assistant", text: "hello", streaming: false },
    ])
    const rows = buildTranscriptRows(messages, new Map())
    expect(rows).toHaveLength(messages.length)
    expect(rows.every((r) => !r.continuation && r.lastSegment)).toBe(true)
  })
})
