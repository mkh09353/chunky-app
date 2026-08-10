import { describe, expect, test } from "bun:test"
import type { AgentEvent, ListeningPort } from "@chunky/protocol"
import { initialState, isStreaming, isTreeIdle, mainItems, reduce, MAIN } from "./transcript"
import type { Item, TranscriptState } from "./transcript"
import { itemsToMessages, streamingMessageId } from "./mapTranscript"

function play(events: AgentEvent[], from: TranscriptState = initialState): TranscriptState {
  return events.reduce(reduce, from)
}

/** What the composer actually asks: App derives `streaming` from isStreaming,
 *  and ChatView shows the running shape when status is running OR a message id
 *  is streaming (App.tsx ~499/682, ChatView.tsx ~306). */
function composerRunning(state: TranscriptState): boolean {
  const streaming = isStreaming(state)
  const id = streamingMessageId(itemsToMessages(mainItems(state)), streaming)
  return state.status === "running" || id != null
}

const IDLE = (): AgentEvent => ({ type: "session.status", sessionId: "s", status: "idle" })
const RUNNING = (): AgentEvent => ({ type: "session.status", sessionId: "s", status: "running" })

describe("session tree status", () => {
  test("keeps a delegate run live when the root turn goes idle", () => {
    const running = reduce(
      reduce(
        reduce(initialState, { type: "session.status", sessionId: "session", status: "running" }),
        { type: "thread.spawn", threadId: "child", parentThreadId: null, title: "Child" },
      ),
      { type: "thread.status", threadId: "child", status: "running" },
    )
    const rootIdle = reduce(running, { type: "session.status", sessionId: "session", status: "idle" })

    expect(rootIdle.runs.find((run) => run.threadId === "child")?.status).toBe("running")
    expect(isTreeIdle(rootIdle)).toBe(false)

    const settled = reduce(rootIdle, { type: "thread.status", threadId: "child", status: "idle" })
    expect(settled.runs.find((run) => run.threadId === "child")?.status).toBe("done")
    expect(isTreeIdle(settled)).toBe(true)
  })
})

describe("idle is authoritative for the composer", () => {
  test("a turn that never sends message.end still settles at idle", () => {
    // Legal stream: an aborted/steered turn ends without message.end.
    const state = play([
      { type: "message.user", text: "go" },
      RUNNING(),
      { type: "message.start", role: "assistant" },
      { type: "message.delta", text: "Working on" },
      IDLE(),
    ])

    const assistant = mainItems(state).find((it) => it.kind === "assistant") as Extract<
      Item,
      { kind: "assistant" }
    >
    expect(assistant.streaming).toBe(false)
    expect(assistant.endReason).toBe("interrupted")
    expect(assistant.text).toBe("Working on")
    expect(isStreaming(state)).toBe(false)
    expect(composerRunning(state)).toBe(false)
  })

  test("a steer-aborted turn closes the tool it left in flight", () => {
    // Shape taken verbatim from a stopped turn in the server event log:
    // tool.start → error "⏹ Interrupted." → session.status idle, no tool.end.
    const state = play([
      { type: "message.user", text: "run the dev server" },
      RUNNING(),
      { type: "tool.start", id: "t1", name: "bash", input: { command: "pnpm dev" } },
      { type: "tool.progress", id: "t1", chunk: "vite listening\n" },
      { type: "error", message: "⏹ Interrupted." },
      IDLE(),
    ])

    const tool = mainItems(state).find((it) => it.kind === "tool") as Extract<
      Item,
      { kind: "tool" }
    >
    expect(tool.done).toBe(true)
    // Never reported a result: not a green check.
    expect(tool.ok).toBe(false)
    // Whatever it printed before the stop survives as output.
    expect(tool.output).toContain("vite listening")
    expect(tool.progress).toBeUndefined()
    expect(isStreaming(state)).toBe(false)
    expect(composerRunning(state)).toBe(false)
  })

  test("the next turn still runs normally after a settled abort", () => {
    const aborted = play([
      RUNNING(),
      { type: "tool.start", id: "t1", name: "bash", input: {} },
      IDLE(),
    ])
    const next = play([RUNNING(), { type: "message.start", role: "assistant" }], aborted)
    expect(isStreaming(next)).toBe(true)
    expect(composerRunning(next)).toBe(true)
    expect(isStreaming(play([{ type: "message.end", reason: "complete" }, IDLE()], next))).toBe(
      false,
    )
  })

  test("idle clears streaming even when an end event was dropped mid-stream", () => {
    // Backstop for an SSE gap: message.end / tool.end simply never arrive.
    const gap = play([
      RUNNING(),
      { type: "reasoning.start" },
      { type: "reasoning.delta", text: "hmm" },
      { type: "tool.start", id: "t9", name: "read", input: { path: "a.ts" } },
      { type: "message.start", role: "assistant" },
      { type: "message.delta", text: "half a sen" },
    ])
    expect(isStreaming(gap)).toBe(true)

    const idle = reduce(gap, IDLE())
    expect(isStreaming(idle)).toBe(false)
    expect(composerRunning(idle)).toBe(false)
    expect(
      mainItems(idle).every(
        (it) =>
          !(it.kind === "assistant" && it.streaming) &&
          !(it.kind === "reasoning" && it.streaming) &&
          !(it.kind === "tool" && !it.done),
      ),
    ).toBe(true)
  })

  test("a child thread's leftovers never keep the root composer running", () => {
    const state = play([
      RUNNING(),
      { type: "tool.start", id: "t1", name: "sidekick", input: { seat: "frontend" } },
      { type: "thread.spawn", threadId: "sk:frontend", parentThreadId: MAIN, title: "Sidekick" },
      { type: "tool.start", id: "c1", name: "bash", input: {}, threadId: "sk:frontend" },
      { type: "message.start", role: "assistant", threadId: "sk:frontend" },
      { type: "message.delta", text: "editing", threadId: "sk:frontend" },
      { type: "thread.status", threadId: "sk:frontend", status: "idle" },
      { type: "tool.end", id: "t1", ok: true, output: "done" },
      IDLE(),
    ])

    // A thread that reports idle carries no open items either.
    const child = state.threads["sk:frontend"]!.items
    expect(child.some((it) => it.kind === "tool" && !it.done)).toBe(false)
    expect(child.some((it) => it.kind === "assistant" && it.streaming)).toBe(false)
    expect(isStreaming(state)).toBe(false)
    expect(composerRunning(state)).toBe(false)
  })

  test("a detached child that outlives the root turn keeps its live items", () => {
    // Guards the deliberate behaviour above: root idle must not fake-settle a
    // child that is genuinely still running.
    const state = play([
      RUNNING(),
      { type: "thread.spawn", threadId: "child", parentThreadId: MAIN, title: "Detached" },
      { type: "thread.status", threadId: "child", status: "running" },
      { type: "message.start", role: "assistant", threadId: "child" },
      { type: "message.delta", text: "still going", threadId: "child" },
      IDLE(),
    ])

    expect(state.threads["child"]!.items.some((it) => it.kind === "assistant" && it.streaming)).toBe(
      true,
    )
    expect(state.runs.find((r) => r.threadId === "child")?.status).toBe("running")
    expect(isTreeIdle(state)).toBe(false)
    // …but the root session is idle, so the composer is usable again.
    expect(isStreaming(state)).toBe(false)
    expect(composerRunning(state)).toBe(false)
  })
})

describe("ports.changed snapshots", () => {
  const PORT = (port: number, taskId = "t1"): ListeningPort => ({
    port,
    address: "127.0.0.1",
    pid: 100 + port,
    command: "bun run dev",
    taskId,
    url: `http://localhost:${port}`,
  })
  const PORTS = (ports: ListeningPort[], sessionId = "s"): AgentEvent =>
    ({ type: "ports.changed", sessionId, ports })

  test("starts empty so older servers that never emit the event are fine", () => {
    expect(initialState.ports).toEqual([])
    expect(play([RUNNING(), IDLE()]).ports).toEqual([])
  })

  test("replaces the whole array — the snapshot is authoritative", () => {
    const first = play([PORTS([PORT(5173), PORT(4620, "t2")])])
    expect(first.ports.map((p) => p.port)).toEqual([5173, 4620])

    // A later snapshot omitting 5173 must not leave it behind.
    const second = play([PORTS([PORT(4620, "t2")])], first)
    expect(second.ports.map((p) => p.port)).toEqual([4620])
    expect(second.ports[0]!.url).toBe("http://localhost:4620")
  })

  test("an empty snapshot clears the ports", () => {
    const state = play([PORTS([]) ], play([PORTS([PORT(5173)])]))
    expect(state.ports).toEqual([])
  })

  test("leaves the rest of the projection untouched", () => {
    const before = play([RUNNING(), { type: "message.user", text: "hi" }])
    const after = play([PORTS([PORT(3000)])], before)
    expect(after.threads).toBe(before.threads)
    expect(after.status).toBe("running")
    expect(mainItems(after)).toEqual(mainItems(before))
  })

  test("a malformed frame cannot crash or corrupt the array", () => {
    const state = play([{ type: "ports.changed", sessionId: "s" } as unknown as AgentEvent],
      play([PORTS([PORT(5173)])]))
    expect(state.ports).toEqual([])
  })
})
