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

/** One delegated *run* (a sidekick brief, a spawned subagent, a workflow leg).
 *
 * A seat's thread is persistent — it goes running → idle → running as briefs
 * arrive — so the thread alone cannot say "which run parks where". A RunRecord
 * pins each pass to the parent-transcript position it was spawned from, which
 * is what lets a settled run park in the gutter beside its own tool pill
 * instead of at the bottom of the transcript. */
export interface RunRecord {
  /** `${threadId}#${nth}` — stable across replays of the same event stream. */
  id: string
  threadId: string
  parentId: string
  title: string
  model?: string
  status: "running" | "done"
  /** Index of the PARENT thread's tool item that spawned this run: the pill the
   *  gutter card aligns to. Frozen when the run opens — resolving it later would
   *  let a newer pill steal an older run's slot. -1 when no pill was open. */
  anchorIndex: number
  /** Slice of the child thread's items produced by this run. */
  itemStart: number
  itemEnd?: number
  /** Tool calls observed inside the run (the card's "N tools"). */
  toolCount: number
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
  /** Delegated runs in spawn order — drives the transcript's agent cards. */
  runs: RunRecord[]
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
  runs: [],
}

/** The tool pill a delegate hangs off: the last tool item in the parent when the
 *  run opened (`thread.spawn` lands just after its `tool.start`). */
function anchorPill(items: Item[]): number {
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i]?.kind === "tool") return i
  }
  return -1
}

/** Index of the still-open run for a thread, or -1. */
function openRunIndex(runs: RunRecord[], threadId: string): number {
  for (let i = runs.length - 1; i >= 0; i--) {
    const run = runs[i]!
    if (run.threadId === threadId && run.status === "running") return i
  }
  return -1
}

/** Open a run for `threadId` unless one is already open. */
function openRun(
  state: TranscriptState,
  threadId: string,
  parentId: string,
  title: string,
  model: string | undefined,
): RunRecord[] {
  if (openRunIndex(state.runs, threadId) >= 0) return state.runs
  const nth = state.runs.filter((r) => r.threadId === threadId).length
  return [
    ...state.runs,
    {
      id: `${threadId}#${nth}`,
      threadId,
      parentId,
      title,
      ...(model ? { model } : {}),
      status: "running" as const,
      anchorIndex: anchorPill(state.threads[parentId]?.items ?? []),
      itemStart: state.threads[threadId]?.items.length ?? 0,
      toolCount: 0,
    },
  ]
}

/** Settle the open run for `threadId`, recording where its output ended. */
function closeRun(state: TranscriptState, threadId: string): RunRecord[] {
  const at = openRunIndex(state.runs, threadId)
  if (at < 0) return state.runs
  const runs = [...state.runs]
  runs[at] = {
    ...runs[at]!,
    status: "done",
    itemEnd: state.threads[threadId]?.items.length ?? runs[at]!.itemStart,
  }
  return runs
}

/** Close every still-open item in a settled thread.
 *
 *  A turn does NOT always close what it opened: an interrupt/steer ends the
 *  turn with `error: ⏹ Interrupted.` + `session.status: idle` and never sends
 *  the `tool.end` / `message.end` for whatever was in flight (see any stopped
 *  turn in the server's event log). Without this, that tool item stays
 *  `done: false` forever, which keeps `isStreaming` true and the composer stuck
 *  in its running shape long after the session went idle.
 *
 *  Partial `progress` is promoted to `output` so the interrupted call still
 *  shows what it managed to print. */
function settleItems(items: Item[]): Item[] {
  let touched = false
  const next = items.map((it): Item => {
    if (it.kind === "assistant" && it.streaming) {
      touched = true
      return { ...it, streaming: false, endReason: it.endReason ?? "interrupted" }
    }
    if (it.kind === "reasoning" && it.streaming) {
      touched = true
      return { ...it, streaming: false }
    }
    if (it.kind === "tool" && !it.done) {
      touched = true
      const output = it.output ?? it.progress
      // `ok: false` rather than a green check: the call never reported a
      // result, so claiming success would be a lie.
      return {
        ...it,
        done: true,
        ok: false,
        ...(output ? { output } : {}),
        progress: undefined,
      }
    }
    return it
  })
  return touched ? next : items
}

/** Settle open items in MAIN and in every thread that is not itself running.
 *
 *  Threads still marked `running` are left alone on purpose: a detached child
 *  legitimately outlives the root turn (see the "keeps a delegate run live"
 *  case in transcript.test.ts), and its own `thread.status: idle` settles it. */
function settleSettledThreads(state: TranscriptState): TranscriptState {
  let changed = false
  const threads: Record<string, ThreadNode> = { ...state.threads }
  for (const id of state.order) {
    const thread = threads[id]
    if (!thread) continue
    if (id !== MAIN && thread.status === "running") continue
    const items = settleItems(thread.items)
    if (items !== thread.items) {
      threads[id] = { ...thread, items }
      changed = true
    }
  }
  return changed ? { ...state, threads } : state
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
      const next: TranscriptState = {
        ...state,
        status: ev.status,
        threads: { ...state.threads, [MAIN]: { ...main, status: ev.status } },
      }
      // Idle is authoritative: an idle session has nothing in flight, so any
      // item an interrupted/aborted turn left open is closed here.
      return ev.status === "idle" ? settleSettledThreads(next) : next
    }

    case "session.rewound":
      // Reattachment/replay is an orchestration concern; keep the reducer pure.
      return state

    case "app.open_url":
      // A live-only request for the browser pane, intercepted before it gets
      // here (see App's attachSession). Explicitly inert so it can never turn
      // into a rendered transcript item, whatever `default` does later.
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
        runs: openRun(state, ev.threadId, parentId, ev.title, node.model),
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
      // Same authority rule one level down: a thread that reports idle cannot
      // still have a streaming message or an unfinished tool.
      const settled = ev.status === "idle" ? { ...node, items: settleItems(node.items) } : node
      return {
        ...state,
        order: existing ? state.order : [...state.order, ev.threadId],
        threads: { ...state.threads, [ev.threadId]: settled },
        runs:
          ev.status === "running"
            ? openRun(state, ev.threadId, node.parentId ?? MAIN, node.title, node.model)
            : closeRun(state, ev.threadId),
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
      // Tool calls inside a delegate count toward its card's "N tools".
      const runs =
        ev.type === "tool.start" && threadId !== MAIN
          ? (() => {
              const at = openRunIndex(state.runs, threadId)
              if (at < 0) return state.runs
              const next = [...state.runs]
              next[at] = { ...next[at]!, toolCount: next[at]!.toolCount + 1 }
              return next
            })()
          : state.runs
      return updateThreadItems({ ...state, runs }, threadId, (items) => reduceItems(items, ev))
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

/** Background tasks/monitors intentionally do not keep a session tree busy. */
export function isTreeIdle(state: TranscriptState): boolean {
  return state.status === "idle" && Object.values(state.threads).every(
    (thread) => thread.id === MAIN || thread.status === "idle",
  )
}

/** True when any assistant/reasoning/tool item is still open.
 *
 *  `session.status: idle` short-circuits this to false — idle is authoritative,
 *  so nothing can still be streaming in an idle session. That is the backstop
 *  for an end event that never arrives (aborted/steered turn, an SSE gap, a
 *  child thread whose items never closed): the composer follows the server's
 *  status, never a leftover item flag. Session-tree busyness — a detached child
 *  outliving the root turn — is `isTreeIdle`, not this. */
export function isStreaming(state: TranscriptState): boolean {
  if (state.status === "running") return true
  if (state.status === "idle") return false
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
