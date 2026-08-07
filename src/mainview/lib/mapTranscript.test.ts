// How a turn's tool calls fold into activity groups. Run with:
//   bun test src/mainview/lib/mapTranscript.test.ts
import { describe, expect, test } from "bun:test"
import type { AgentEvent } from "@chunky/protocol"
import { MAIN, initialState, reduce } from "./transcript"
import type { TranscriptState } from "./transcript"
import { anchoredItemIndices, runAnchors } from "./runs"
import { applyRunAnchors, itemsToMessages, sessionToThread } from "./mapTranscript"
import { groupByWorktree, groupKeyOf } from "./sessionGroups"
import type { MessageBlock } from "./mock"

function play(events: AgentEvent[]): TranscriptState {
  return events.reduce(reduce, initialState)
}

/** Blocks of the (single) assistant message, mapped the way the app maps them. */
function assistantBlocks(state: TranscriptState): MessageBlock[] {
  const messages = itemsToMessages(
    state.threads[MAIN]!.items,
    undefined,
    anchoredItemIndices(state),
  )
  return messages.filter((m) => m.role === "assistant").flatMap((m) => m.blocks)
}

const bash = (id: string, command: string): AgentEvent[] => [
  { type: "tool.start", id, name: "mcp__chunky__bash", input: { command } },
  { type: "tool.end", id, ok: true, output: "done" },
]

const PROSE: AgentEvent[] = [
  { type: "message.start", role: "assistant" },
  { type: "message.delta", text: "Working." },
]

describe("tool grouping", () => {
  test("maps an image-only user message and its count through to the rendered message", () => {
    const state = play([{ type: "message.user", text: "", imageCount: 2 }])
    const messages = itemsToMessages(state.threads[MAIN]!.items)

    expect(messages).toEqual([
      {
        id: "ev-0",
        role: "user",
        imageCount: 2,
        blocks: [{ type: "text", content: "" }],
      },
    ])
  })

  test("consecutive bash calls fold into one activity group", () => {
    const state = play([
      { type: "message.user", text: "check the build" },
      ...PROSE,
      ...bash("t1", "bun test"),
      ...bash("t2", "bun run typecheck"),
      ...bash("t3", "git status"),
    ])
    const blocks = assistantBlocks(state)
    expect(blocks.map((b) => b.type)).toEqual(["text", "toolGroup"])
    const group = blocks[1]!
    expect(group.tools).toHaveLength(3)
    expect(group.tools!.map((t) => t.summary.detail)).toEqual([
      "bun test",
      "bun run typecheck",
      "git status",
    ])
    // The group stands where its first call did (item 2: user, assistant,
    // tool), so anchors still resolve against it.
    expect(group.srcIndex).toBe(2)
    expect(group.tool).toBeUndefined()
  })

  test("a lone call stays a plain tool block", () => {
    const state = play([{ type: "message.user", text: "read it" }, ...PROSE, ...bash("t1", "ls")])
    const blocks = assistantBlocks(state)
    expect(blocks.map((b) => b.type)).toEqual(["text", "tool"])
    expect(blocks[1]!.tool!.summary).toMatchObject({ label: "Ran", detail: "ls", mono: true })
  })

  test("a mixed run groups together and summarizes by family", () => {
    const state = play([
      ...PROSE,
      { type: "tool.start", id: "r1", name: "read", input: { path: "src/a.ts" } },
      { type: "tool.end", id: "r1", ok: true, output: "…" },
      ...bash("b1", "bun test"),
      { type: "tool.start", id: "g1", name: "ffgrep", input: { pattern: "useRunClock" } },
      { type: "tool.end", id: "g1", ok: true, output: "3 hits" },
    ])
    const blocks = assistantBlocks(state)
    expect(blocks.map((b) => b.type)).toEqual(["text", "toolGroup"])
    expect(blocks[1]!.tools!.map((t) => t.name)).toEqual(["read", "mcp__chunky__bash", "ffgrep"])
  })

  test("prose between calls breaks the run into two groups", () => {
    const state = play([
      ...PROSE,
      ...bash("t1", "a"),
      ...bash("t2", "b"),
      { type: "message.start", role: "assistant" },
      { type: "message.delta", text: "Now the second half." },
      ...bash("t3", "c"),
      ...bash("t4", "d"),
    ])
    expect(assistantBlocks(state).map((b) => b.type)).toEqual([
      "text",
      "toolGroup",
      "text",
      "toolGroup",
    ])
  })

  test("an anchored delegate pill interrupts the group and stays standalone", () => {
    const state = play([
      ...PROSE,
      ...bash("t1", "a"),
      ...bash("t2", "b"),
      { type: "tool.start", id: "d1", name: "sidekick", input: { seat: "frontend" } },
      {
        type: "thread.spawn",
        threadId: "sk:frontend",
        parentThreadId: MAIN,
        title: "Sidekick (frontend)",
      },
      { type: "thread.status", threadId: "sk:frontend", status: "idle" },
      ...bash("t3", "c"),
      ...bash("t4", "d"),
    ])
    const blocks = assistantBlocks(state)
    expect(blocks.map((b) => b.type)).toEqual(["text", "toolGroup", "tool", "toolGroup"])
    expect(blocks[2]!.tool!.name).toBe("sidekick")
    // The pill kept its own srcIndex, which is exactly what runAnchors keys on.
    expect(anchoredItemIndices(state).has(blocks[2]!.srcIndex!)).toBe(true)
  })

  test("the delegate pill keeps its own block and gets stamped with its run", () => {
    const state = play([
      ...PROSE,
      ...bash("t1", "a"),
      ...bash("t2", "b"),
      { type: "tool.start", id: "d1", name: "sidekick", input: { seat: "frontend" } },
      {
        type: "thread.spawn",
        threadId: "sk:frontend",
        parentThreadId: MAIN,
        title: "Sidekick (frontend)",
      },
      { type: "thread.status", threadId: "sk:frontend", status: "idle" },
    ])
    const messages = applyRunAnchors(
      itemsToMessages(state.threads[MAIN]!.items, undefined, anchoredItemIndices(state)),
      runAnchors(state),
    )
    const blocks = messages.flatMap((m) => m.blocks)
    // Prose, the folded commands, then the pill \u2014 one message, never split.
    expect(messages).toHaveLength(1)
    expect(blocks.map((b) => b.type)).toEqual(["text", "toolGroup", "tool"])
    expect(blocks[2]!.settledRunIds).toEqual(["sk:frontend#0"])
    expect(blocks[1]!.settledRunIds).toBeUndefined()
  })

  test("a delegate pill is left standalone even before its spawn arrives", () => {
    // `tool.start` lands one event before `thread.spawn`, so for one render the
    // pill is not anchored yet. Name-based exclusion keeps it out of the group
    // anyway, so the block cannot jump in and out of a fold.
    const state = play([...PROSE, ...bash("t1", "a"), ...bash("t2", "b"), {
      type: "tool.start",
      id: "d1",
      name: "spawn_thread",
      input: { title: "docs" },
    }])
    expect(anchoredItemIndices(state).size).toBe(0)
    expect(assistantBlocks(state).map((b) => b.type)).toEqual(["text", "toolGroup", "tool"])
  })

  test("a group whose last call is still running keeps that call visible", () => {
    const state = play([
      ...PROSE,
      ...bash("t1", "bun test"),
      { type: "tool.start", id: "t2", name: "mcp__chunky__bash", input: { command: "bun run build" } },
    ])
    const group = assistantBlocks(state).find((b) => b.type === "toolGroup")!
    expect(group.tools!.map((t) => t.done)).toEqual([true, false])
    const last = group.tools!.at(-1)!
    expect(last.summary.detail).toBe("bun run build")
    expect(last.ok).toBeUndefined()
  })

  test("the changed-files summary stays after the tools it describes", () => {
    const state = play([
      ...PROSE,
      {
        type: "tool.start",
        id: "e1",
        name: "edit",
        input: { path: "a.ts", edits: [{ oldText: "one", newText: "two" }] },
      },
      { type: "tool.end", id: "e1", ok: true, output: "applied" },
      ...bash("t1", "bun test"),
    ])
    expect(assistantBlocks(state).map((b) => b.type)).toEqual(["text", "toolGroup", "files"])
  })

  test("failures survive the fold so the group can flag them", () => {
    const state = play([
      ...PROSE,
      ...bash("t1", "bun test"),
      { type: "tool.start", id: "t2", name: "mcp__chunky__bash", input: { command: "bun run build" } },
      { type: "tool.end", id: "t2", ok: false, output: "exit 1" },
    ])
    const group = assistantBlocks(state).find((b) => b.type === "toolGroup")!
    expect(group.tools!.map((t) => t.ok)).toEqual([true, false])
  })
})

// ---- session rows -> sidebar threads ---------------------------------------

describe("sessionToThread carries git identity without redefining `branch`", () => {
  const base = {
    sessionId: "s1",
    title: "Thread",
    createdAt: 0,
    lastActivity: Date.now(),
    workspace: "/repos/widget",
  }

  test("an OLDER SERVER row yields neither grouping key, so the sidebar stays flat", () => {
    const thread = sessionToThread({ ...base })
    // `branch` remains the workspace basename the sidebar SEARCH matches on.
    expect(thread.branch).toBe("widget")
    // The grouping fields must be absent, not undefined-valued: absence is the
    // signal lib/sessionGroups reads as "render flat".
    expect("gitBranch" in thread).toBe(false)
    expect("worktreePath" in thread).toBe(false)
    expect(groupKeyOf(thread)).toBeNull()
  })

  test("a main-checkout row carries the real branch but no worktree path", () => {
    const thread = sessionToThread({ ...base, branch: "main" })
    expect(thread.branch).toBe("widget")
    expect(thread.gitBranch).toBe("main")
    expect("worktreePath" in thread).toBe(false)
    expect(groupKeyOf(thread)).toBe("br:main")
  })

  test("a linked-worktree row carries both, and groups by the worktree", () => {
    const thread = sessionToThread({
      ...base,
      workspace: "/state/worktrees/widget-fix",
      branch: "chunky/fix",
      worktree: { path: "/state/worktrees/widget-fix", isLinked: true },
    })
    // Still the folder basename — unchanged meaning, still what search uses.
    expect(thread.branch).toBe("widget-fix")
    expect(thread.gitBranch).toBe("chunky/fix")
    expect(thread.worktreePath).toBe("/state/worktrees/widget-fix")
    expect(groupKeyOf(thread)).toBe("wt:/state/worktrees/widget-fix")
  })

  test("a repo with a main row and a worktree row groups into two", () => {
    const rows = [
      sessionToThread({ ...base, sessionId: "a", branch: "main" }),
      sessionToThread({
        ...base,
        sessionId: "b",
        workspace: "/state/worktrees/widget-fix",
        branch: "chunky/fix",
        worktree: { path: "/state/worktrees/widget-fix", isLinked: true },
      }),
    ]
    const groups = groupByWorktree(rows)!
    expect(groups.map((g) => g.label)).toEqual(["main", "chunky/fix"])
    expect(groups.map((g) => g.linked)).toEqual([false, true])
  })
})
