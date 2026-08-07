// Map transcript Item[] → the polished Message[] shape the UI already renders.
import type {
  ChangedFiles,
  FileDiff,
  Message,
  MessageBlock,
  Project,
  Thread,
  ThreadStatus,
  ToolBlockData,
} from "./mock"
import type { SessionSummary } from "./api"
import { extractDiff, prettyJson, truncateText } from "./toolDiff"
import { describeTool, isGroupableTool } from "./toolSummary"
import { relativeTime, threadLabel, workspaceMark, workspaceName } from "./format"
import type { Item, ThreadNode, TranscriptState } from "./transcript"
import { isStreaming, mainItems } from "./transcript"
import { pendingMessages, type PendingSend } from "./pendingSends"
import type { RunAnchor } from "./runs"
import { anchoredItemIndices } from "./runs"

/** Item indices that own a delegate run — nothing anchored may be folded away. */
const NO_ANCHORS: ReadonlySet<number> = new Set<number>()

/**
 * Fold each run of consecutive plain tool blocks into ONE `toolGroup` block, so
 * a turn that fired six commands reads as one activity line instead of six
 * full-width cards.
 *
 * Two calls are only consecutive if nothing else came between them: any prose,
 * thinking, diff summary or delegate pill closes the run. Blocks that anchor a
 * delegated run (or whose tool spawns one by name) are NEVER folded — they keep
 * their own block, which is what carries the run's identity and its detail.
 *
 * A lone call stays a plain `tool` block: a group of one would add a click for
 * nothing.
 */
function groupToolBlocks(blocks: MessageBlock[], anchored: ReadonlySet<number>): MessageBlock[] {
  const out: MessageBlock[] = []
  let run: MessageBlock[] = []

  const flushRun = () => {
    if (run.length === 0) return
    if (run.length === 1) {
      out.push(run[0]!)
    } else {
      const first = run[0]!
      out.push({
        type: "toolGroup",
        content: "",
        tools: run.map((block) => block.tool!),
        // The group stands where its first call did, so a run anchor or a
        // gutter card that looks up srcIndex still lands in the right row.
        ...(first.srcIndex != null ? { srcIndex: first.srcIndex } : {}),
      })
    }
    run = []
  }

  for (const block of blocks) {
    const groupable =
      block.type === "tool" &&
      !!block.tool &&
      isGroupableTool(block.tool.name) &&
      !(block.srcIndex != null && anchored.has(block.srcIndex))
    if (groupable) {
      run.push(block)
      continue
    }
    flushRun()
    out.push(block)
  }
  flushRun()
  return out
}

/** Merge per-file diffs of one turn into a changed-files summary, or null. */
function aggregateChangedFiles(diffs: FileDiff[]): ChangedFiles | null {
  if (diffs.length === 0) return null
  const byPath = new Map<string, { added: number; removed: number }>()
  for (const d of diffs) {
    const key = d.path ?? "(edited)"
    const cur = byPath.get(key) ?? { added: 0, removed: 0 }
    cur.added += d.added
    cur.removed += d.removed
    byPath.set(key, cur)
  }
  const files = [...byPath.entries()].map(([path, v]) => ({
    path,
    added: v.added,
    removed: v.removed,
  }))
  const added = files.reduce((s, f) => s + f.added, 0)
  const removed = files.reduce((s, f) => s + f.removed, 0)
  return { total: files.length, added, removed, files }
}

/** Fold sequential items into UI messages: per-tool cards + a thinking block. */
export function itemsToMessages(
  items: Item[],
  modelName?: string,
  /** Item indices carrying a delegated run: those pills stay standalone. */
  anchored: ReadonlySet<number> = NO_ANCHORS,
): Message[] {
  const messages: Message[] = []
  let seq = 0
  const nextId = () => `ev-${seq++}`

  // Pending assistant blocks (text/code/worked) before we flush a message.
  let asstBlocks: MessageBlock[] = []
  let asstStreaming = false
  let turnDiffs: FileDiff[] = []
  let lastToolIndex = -1

  const flushAssistant = () => {
    if (asstBlocks.length === 0) {
      asstStreaming = false
      turnDiffs = []
      lastToolIndex = -1
      return
    }
    const blocks = [...asstBlocks]
    // Aggregate this turn's file edits into a changed-files summary, placed at
    // the end of the tool group (right after the last tool card).
    const files = aggregateChangedFiles(turnDiffs)
    if (files) {
      const at = lastToolIndex >= 0 ? lastToolIndex + 1 : blocks.length
      blocks.splice(at, 0, { type: "files", content: "", files })
    }
    messages.push({
      id: nextId(),
      role: "assistant",
      model: modelName,
      // Grouping runs LAST, on the finished block list, so the changed-files
      // summary keeps its place after the tools it describes.
      blocks: groupToolBlocks(blocks, anchored),
    })
    asstBlocks = []
    asstStreaming = false
    turnDiffs = []
    lastToolIndex = -1
  }

  for (const [srcIndex, it] of items.entries()) {
    const before = asstBlocks.length
    switch (it.kind) {
      case "user": {
        flushAssistant()
        messages.push({
          id: nextId(),
          role: "user",
          ...(it.imageCount ? { imageCount: it.imageCount } : {}),
          blocks: [{ type: "text", content: it.from ? `${it.text}\n\n— from ${it.from}` : it.text }],
        })
        break
      }
      case "assistant": {
        if (it.text) {
          // Split fenced code out of streamed markdown for the existing CodeBlock UI.
          const parts = splitTextAndCode(it.text)
          asstBlocks.push(...parts)
        } else if (it.streaming && asstBlocks.length === 0) {
          asstBlocks.push({ type: "text", content: "" })
        }
        asstStreaming = it.streaming
        if (!it.streaming) {
          // Keep accumulating until a user turn or end — tools may follow.
        }
        break
      }
      case "reasoning": {
        if (it.text.trim()) {
          asstBlocks.push({
            type: "thinking",
            content: it.streaming ? "Thinking…" : "Thought process",
            steps: it.text.split("\n").filter(Boolean).slice(0, 80),
          })
        }
        break
      }
      case "tool": {
        const diff = extractDiff(it.name, it.input, it.output)
        const tool: ToolBlockData = {
          id: it.id,
          name: it.name,
          summary: describeTool(it.name, it.input),
          inputJson: prettyJson(it.input),
          done: it.done,
          diff,
          ...(it.ok !== undefined ? { ok: it.ok } : {}),
          ...(it.output ? { output: truncateText(it.output) } : {}),
          ...(it.progress ? { progress: truncateText(it.progress) } : {}),
        }
        asstBlocks.push({ type: "tool", content: "", tool })
        lastToolIndex = asstBlocks.length - 1
        if (diff && it.done) turnDiffs.push(diff)
        break
      }
      case "error": {
        flushAssistant()
        messages.push({
          id: nextId(),
          role: "assistant",
          model: modelName,
          blocks: [{ type: "text", content: `**Error:** ${it.text}` }],
        })
        break
      }
      case "goal":
      case "notice":
      case "workflow-phase":
      case "workflow-log":
      case "cache-warning":
      case "usage": {
        const text =
          it.kind === "goal"
            ? `🎯 ${it.message}`
            : it.kind === "notice"
              ? it.text
              : it.kind === "workflow-phase"
                ? `▸ ${it.title}`
                : it.kind === "workflow-log"
                  ? it.message
                  : it.kind === "cache-warning"
                    ? `Cache cold (${it.reason}) · ~${it.approxTokens} tokens`
                    : `Usage · ${it.summary}`
        // Attach as a small assistant notice rather than a full bubble pair.
        asstBlocks.push({ type: "text", content: `*${text}*` })
        break
      }
      default:
        break
    }
    // Stamp every block this item produced with its source index — that is what
    // lets a delegated run park beside the exact pill that spawned it.
    for (let i = Math.min(before, asstBlocks.length); i < asstBlocks.length; i++) {
      asstBlocks[i] = { ...asstBlocks[i]!, srcIndex }
    }
  }

  // Always flush remaining assistant content (including mid-stream).
  if (asstBlocks.length > 0 || asstStreaming) {
    flushAssistant()
  }

  return messages
}

/**
 * Tie each delegate-spawning tool block to the runs it opened.
 *
 * A run belongs INSIDE the pill that started it: while it is in flight the pill
 * streams its tail, and once it settles its whole transcript is one expansion
 * away. So this only stamps identity onto the block — it never restructures the
 * message. (It used to split a message into slices so a card could ride level
 * with its pill out in a right-hand gutter; that gutter is gone.)
 */
export function applyRunAnchors(
  messages: Message[],
  anchors: Map<number, RunAnchor>,
): Message[] {
  if (anchors.size === 0) return messages
  return messages.map((message) => {
    if (message.role !== "assistant") return message
    let touched = false
    const blocks = message.blocks.map((block) => {
      const anchor = block.srcIndex != null ? anchors.get(block.srcIndex) : undefined
      if (!anchor) return block
      touched = true
      return {
        ...block,
        ...(anchor.liveRunId ? { runId: anchor.liveRunId } : {}),
        ...(anchor.liveRunIds.length ? { runIds: anchor.liveRunIds } : {}),
        ...(anchor.parkedRunIds.length ? { settledRunIds: anchor.parkedRunIds } : {}),
        accent: anchor.accent,
      }
    })
    return touched ? { ...message, blocks } : message
  })
}

/** Child nodes are deliberately kept separate from main messages so the view can
 * render their recursive cards without making reducer state into presentation state. */
export function childThreads(state: TranscriptState, parentId: string): ThreadNode[] {
  return state.order
    .map((id) => state.threads[id])
    .filter((thread): thread is ThreadNode => !!thread && thread.parentId === parentId)
}

/** Extract fenced code blocks so Message.tsx can use CodeBlock. */
function splitTextAndCode(text: string): MessageBlock[] {
  const blocks: MessageBlock[] = []
  const re = /```([\w+-]*)\n?([\s\S]*?)```/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) {
      const chunk = text.slice(last, m.index)
      if (chunk.trim()) blocks.push({ type: "text", content: chunk })
    }
    blocks.push({ type: "code", lang: m[1] || undefined, content: (m[2] ?? "").replace(/\n$/, "") })
    last = m.index + m[0].length
  }
  const tail = text.slice(last)
  if (tail || blocks.length === 0) {
    blocks.push({ type: "text", content: tail })
  }
  return blocks
}

export function projectFromWorkspace(workspace: string): Project {
  const name = workspaceName(workspace)
  return {
    id: `ws:${workspace}`,
    name,
    path: workspace,
    owner: "local",
    mark: workspaceMark(workspace),
  }
}

export function threadStatusFromSession(
  s: SessionSummary,
  liveBusy: boolean | undefined,
  attached: boolean,
  unread = false,
): ThreadStatus {
  // The attached transcript knows the whole thread tree. Other sessions use
  // the server's aggregate `busy` flag, falling back for older servers.
  if (liveBusy === true || (liveBusy === undefined && (s.busy ?? s.running))) {
    return { kind: "working", label: "" }
  }
  void attached

  // A run finished while this thread wasn't being viewed: show Done until read.
  if (unread) return { kind: "done", unread: true }
  // Active (not settled) if recently touched or currently attached.
  const age = Date.now() - s.lastActivity
  if (age < 30 * 60_000 || s.attached) {
    return { kind: "idle", ago: relativeTime(s.lastActivity) }
  }
  return { kind: "done" }
}

export function sessionToThread(
  s: SessionSummary,
  opts: {
    messages?: Message[]
    liveBusy?: boolean
    modelName?: string
    isActive?: boolean
    unread?: boolean
  } = {},
): Thread {
  const status = threadStatusFromSession(s, opts.isActive ? opts.liveBusy : undefined, !!s.attached, opts.unread)
  return {
    id: s.sessionId,
    projectId: `ws:${s.workspace}`,
    title: threadLabel(s.title),
    updated: relativeTime(s.lastActivity),
    preview: threadLabel(s.title),
    status,
    branch: workspaceName(s.workspace),
    messages: opts.messages ?? [],
  }
}

export function buildActiveThread(
  session: SessionSummary | undefined,
  transcript: TranscriptState,
  modelName?: string,
  /** Optimistic rows for sends the server has not echoed yet. They are appended
   *  here, at the presentation seam, and never enter the reduced transcript. */
  pending: readonly PendingSend[] = [],
): Thread {
  const messages = [
    ...itemsToMessages(mainItems(transcript), modelName, anchoredItemIndices(transcript)),
    ...pendingMessages(pending),
  ]
  if (!session) {
    return {
      id: "none",
      projectId: "ws:",
      title: "No session",
      updated: "now",
      preview: "",
      status: { kind: "idle", ago: "now" },
      branch: "—",
      messages,
    }
  }
  const streaming = isStreaming(transcript)
  return {
    id: session.sessionId,
    projectId: `ws:${session.workspace}`,
    title: threadLabel(session.title),
    updated: relativeTime(session.lastActivity),
    preview: messages.find((m) => m.role === "user")?.blocks[0]?.content?.slice(0, 80) ?? "",
    status: streaming
      ? { kind: "working", label: "" }
      : { kind: "idle", ago: relativeTime(session.lastActivity) },
    branch: workspaceName(session.workspace),
    messages,
  }
}

/** Stable id of the currently streaming assistant message (last one if any). */
export function streamingMessageId(messages: Message[], streaming: boolean): string | null {
  if (!streaming) return null
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!
    if (m.role === "assistant") return m.id
  }
  return null
}
