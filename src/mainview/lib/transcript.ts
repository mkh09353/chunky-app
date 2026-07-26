// Reduce AgentEvents into a thread tree the chat UI can render.
// Ported from the reference app — tolerate unknown / nested / legacy variants.
import type {
  AgentEvent,
  GoalStatus,
  MessageEndReason,
  QueueEntry,
  TodoSnapshot,
  UsageDelta,
} from "@chunky/protocol"

export const MAIN = "main"

export type Item =
  | { kind: "user"; text: string; from?: string; interjection?: boolean }
  | { kind: "assistant"; text: string; streaming: boolean; endReason?: MessageEndReason }
  | { kind: "reasoning"; text: string; streaming: boolean }
  | {
      kind: "tool"
      id: string
      name: string
      input: unknown
      done: boolean
      ok?: boolean
      output?: string
      progress?: string
    }
  | { kind: "error"; text: string }
  | {
      kind: "cache-warning"
      reason: "idle" | "model-switch"
      idleMs?: number
      approxTokens: number
      fromModel?: string
      toModel?: string
    }
  | { kind: "goal"; status: GoalStatus | "cleared"; message: string }
  | { kind: "notice"; text: string }
  | { kind: "workflow-phase"; title: string }
  | { kind: "workflow-log"; message: string }
  | { kind: "usage"; summary: string }
  | { kind: "unknown"; type: string }

export interface ThreadNode {
  id: string
  parentId: string | null
  title: string
  status: "idle" | "running"
  model?: string
  anchorIndex?: number
  items: Item[]
}

export interface TranscriptState {
  threads: Record<string, ThreadNode>
  order: string[]
  status: "idle" | "running"
  queue: { entries: QueueEntry[]; running: boolean }
  /** Live plan/checklist for this session (todos.update). */
  todos: TodoSnapshot[]
  /** Background tasks / monitors currently running (background.changed). */
  background: { tasks: number; monitors: number }
  /** Latest provider usage snapshot (usage.update); null until first turn. */
  usage: UsageDelta | null
  /** How many times older context was summarized (context.compacted). */
  compacted: number
}

export const initialState: TranscriptState = {
  threads: {
    [MAIN]: { id: MAIN, parentId: null, title: "main", status: "idle", items: [] },
  },
  order: [MAIN],
  status: "idle",
  queue: { entries: [], running: false },
  todos: [],
  background: { tasks: 0, monitors: 0 },
  usage: null,
  compacted: 0,
}

const PROGRESS_MAX_BYTES = 64 * 1024

function appendProgress(prev: string | undefined, chunk: string): string {
  const next = (prev ?? "") + chunk
  return next.length > PROGRESS_MAX_BYTES ? next.slice(next.length - PROGRESS_MAX_BYTES) : next
}

function reduceItems(items: Item[], ev: AgentEvent): Item[] {
  switch (ev.type) {
    case "message.user":
      return [...items, { kind: "user", text: ev.text, ...(ev.from ? { from: ev.from } : {}) }]

    case "message.start":
      return [...items, { kind: "assistant", text: "", streaming: true }]

    case "message.delta": {
      const next = [...items]
      for (let i = next.length - 1; i >= 0; i--) {
        const it = next[i]!
        if (it.kind === "assistant" && it.streaming) {
          next[i] = { ...it, text: it.text + ev.text }
          return next
        }
      }
      return [...next, { kind: "assistant", text: ev.text, streaming: true }]
    }

    case "message.end": {
      const next = [...items]
      for (let i = next.length - 1; i >= 0; i--) {
        const it = next[i]!
        if (it.kind === "assistant" && it.streaming) {
          next[i] = { ...it, streaming: false, ...(ev.reason ? { endReason: ev.reason } : {}) }
          break
        }
      }
      return next
    }

    case "reasoning.start":
      return [...items, { kind: "reasoning", text: "", streaming: true }]

    case "reasoning.delta": {
      const next = [...items]
      for (let i = next.length - 1; i >= 0; i--) {
        const it = next[i]!
        if (it.kind === "reasoning" && it.streaming) {
          next[i] = { ...it, text: it.text + ev.text }
          return next
        }
      }
      return [...next, { kind: "reasoning", text: ev.text, streaming: true }]
    }

    case "reasoning.end": {
      const next = [...items]
      for (let i = next.length - 1; i >= 0; i--) {
        const it = next[i]!
        if (it.kind === "reasoning" && it.streaming) {
          next[i] = { ...it, streaming: false }
          break
        }
      }
      return next
    }

    case "tool.start": {
      const closed = items.map((it) =>
        it.kind === "assistant" && it.streaming ? { ...it, streaming: false } : it,
      )
      return [
        ...closed,
        { kind: "tool", id: ev.id, name: ev.name, input: ev.input, done: false },
      ]
    }

    case "tool.progress":
      return items.map((it) =>
        it.kind === "tool" && it.id === ev.id && !it.done
          ? { ...it, progress: appendProgress(it.progress, ev.chunk) }
          : it,
      )

    case "tool.end":
      return items.map((it) =>
        it.kind === "tool" && it.id === ev.id
          ? { ...it, done: true, ok: ev.ok, output: ev.output, progress: undefined }
          : it,
      )

    case "error":
      return [...items, { kind: "error", text: ev.message }]

    default:
      return items
  }
}

function updateThreadItems(
  state: TranscriptState,
  threadId: string,
  fn: (items: Item[]) => Item[],
): TranscriptState {
  const thread = state.threads[threadId] ?? {
    id: threadId,
    parentId: MAIN,
    title: threadId,
    status: "running" as const,
    items: [],
  }
  const order = state.threads[threadId] ? state.order : [...state.order, threadId]
  return {
    ...state,
    order,
    threads: { ...state.threads, [threadId]: { ...thread, items: fn(thread.items) } },
  }
}

export function reduce(state: TranscriptState, ev: AgentEvent): TranscriptState {
  // Tolerate non-protocol / legacy frames without crashing.
  if (!ev || typeof ev !== "object" || typeof (ev as { type?: unknown }).type !== "string") {
    return state
  }

  switch (ev.type) {
    case "session.status": {
      const main = state.threads[MAIN]!
      return {
        ...state,
        status: ev.status,
        threads: { ...state.threads, [MAIN]: { ...main, status: ev.status } },
      }
    }

    case "session.rewound":
      // Reattachment/replay is an orchestration concern; keep the reducer pure.
      return state

    case "background.changed":
      return { ...state, background: { tasks: ev.tasks, monitors: ev.monitors } }

    case "todos.update":
      // Live plan/checklist snapshot for the Todos panel.
      return { ...state, todos: ev.todos }

    case "context.compacted":
      // Older model context replaced by a summary: drop an inline notice where
      // it happened AND bump the counter the chat surface shows as a chip.
      return updateThreadItems({ ...state, compacted: state.compacted + 1 }, MAIN, (items) => [
        ...items,
        {
          kind: "notice",
          text: "Earlier context was compacted into a summary. The full transcript remains available.",
        },
      ])

    case "cache.warning": {
      const threadId = ev.threadId || MAIN
      return updateThreadItems(state, threadId, (items) => [
        ...items,
        {
          kind: "cache-warning",
          reason: ev.reason,
          approxTokens: ev.approxTokens,
          ...(ev.idleMs != null ? { idleMs: ev.idleMs } : {}),
          ...(ev.fromModel ? { fromModel: ev.fromModel } : {}),
          ...(ev.toModel ? { toModel: ev.toModel } : {}),
        },
      ])
    }

    case "goal.update": {
      return updateThreadItems(state, MAIN, (items) => [
        ...items,
        {
          kind: "goal",
          status: ev.goal?.status ?? "cleared",
          message: ev.message ?? "Goal updated.",
        },
      ])
    }

    case "queue.changed":
      return { ...state, queue: { entries: ev.entries, running: ev.running } }

    case "message.interjection": {
      if (ev.injected) return state
      return updateThreadItems(state, MAIN, (items) => [
        ...items,
        { kind: "user", text: ev.text, interjection: true },
      ])
    }

    case "thread.spawn": {
      const parentId = ev.parentThreadId ?? MAIN
      const existing = state.threads[ev.threadId]
      const node: ThreadNode = {
        id: ev.threadId,
        parentId,
        title: ev.title,
        status: "running",
        model: ev.model ?? existing?.model,
        anchorIndex: existing?.anchorIndex ?? state.threads[parentId]?.items.length ?? 0,
        items: existing?.items ?? [],
      }
      return {
        ...state,
        order: existing ? state.order : [...state.order, ev.threadId],
        threads: { ...state.threads, [ev.threadId]: node },
      }
    }

    case "thread.status": {
      const existing = state.threads[ev.threadId]
      const node: ThreadNode = existing
        ? { ...existing, status: ev.status, title: ev.title ?? existing.title }
        : {
            id: ev.threadId,
            parentId: MAIN,
            title: ev.title ?? ev.threadId,
            status: ev.status,
            items: [],
          }
      return {
        ...state,
        order: existing ? state.order : [...state.order, ev.threadId],
        threads: { ...state.threads, [ev.threadId]: node },
      }
    }

    case "workflow.phase": {
      const threadId = ev.threadId || MAIN
      return updateThreadItems(state, threadId, (items) => [
        ...items,
        { kind: "workflow-phase", title: ev.title },
      ])
    }

    case "workflow.log": {
      const threadId = ev.threadId || MAIN
      return updateThreadItems(state, threadId, (items) => [
        ...items,
        { kind: "workflow-log", message: ev.message },
      ])
    }

    case "usage.update": {
      const u = ev.usage
      const parts = [
        u.inputTokens ? `${u.inputTokens} in` : null,
        u.outputTokens ? `${u.outputTokens} out` : null,
        u.cacheReadTokens ? `${u.cacheReadTokens} cache-read` : null,
      ].filter(Boolean)
      const summary = parts.length ? parts.join(" · ") : "usage"
      const threadId = ev.threadId || MAIN
      // Keep the LAST usage snapshot on state for the context-window meter.
      return updateThreadItems({ ...state, usage: ev.usage }, threadId, (items) => [
        ...items,
        { kind: "usage", summary },
      ])
    }

    case "message.user":
    case "message.start":
    case "message.delta":
    case "message.end":
    case "reasoning.start":
    case "reasoning.delta":
    case "reasoning.end":
    case "tool.start":
    case "tool.progress":
    case "tool.end":
    case "error": {
      const threadId = ("threadId" in ev && ev.threadId) || MAIN
      return updateThreadItems(state, threadId, (items) => reduceItems(items, ev))
    }

    default: {
      // Unknown / future variants — swallow rather than crash.
      return state
    }
  }
}

export function mainItems(state: TranscriptState): Item[] {
  return state.threads[MAIN]?.items ?? []
}

export function hasTranscript(state: TranscriptState): boolean {
  return (state.threads[MAIN]?.items.length ?? 0) > 0 || state.order.length > 1
}

/** True when any assistant/reasoning/tool item is still open. */
export function isStreaming(state: TranscriptState): boolean {
  if (state.status === "running") return true
  for (const id of state.order) {
    const items = state.threads[id]?.items ?? []
    for (const it of items) {
      if (it.kind === "assistant" && it.streaming) return true
      if (it.kind === "reasoning" && it.streaming) return true
      if (it.kind === "tool" && !it.done) return true
    }
  }
  return false
}
