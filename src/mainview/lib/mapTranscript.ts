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
import { relativeTime, threadLabel, workspaceMark, workspaceName } from "./format"
import type { Item, ThreadNode, TranscriptState } from "./transcript"
import { isStreaming, mainItems } from "./transcript"
import type { RunAnchor } from "./runs"

function toolInputPreview(input: unknown): string {
  if (input == null) return ""
  if (typeof input === "string") return input.slice(0, 200)
  try {
    return JSON.stringify(input).slice(0, 200)
  } catch {
    return String(input).slice(0, 200)
  }
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
export function itemsToMessages(items: Item[], modelName?: string): Message[] {
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
    messages.push({ id: nextId(), role: "assistant", model: modelName, blocks })
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
          inputPreview: toolInputPreview(it.input),
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

/** One rendered transcript row: a message, or a *slice* of an assistant message
 *  that starts at a run-spawning tool pill so the gutter card can sit level with
 *  it. Splitting is structural — driven by the run anchors, not by offsets. */
export interface TranscriptRow {
  id: string
  message: Message
  blocks: MessageBlock[]
  /** Later slices of the same message: no avatar/header, indented instead. */
  continuation: boolean
  /** Only the final slice shows the streaming caret and hover actions. */
  lastSegment: boolean
  /** Settled runs that park in this row's gutter. */
  parkedRunIds: string[]
}

export function buildTranscriptRows(
  messages: Message[],
  anchors: Map<number, RunAnchor>,
): TranscriptRow[] {
  const rows: TranscriptRow[] = []
  for (const message of messages) {
    if (message.role !== "assistant" || anchors.size === 0) {
      rows.push({
        id: message.id,
        message,
        blocks: message.blocks,
        continuation: false,
        lastSegment: true,
        parkedRunIds: [],
      })
      continue
    }

    let blocks: MessageBlock[] = []
    let parkedRunIds: string[] = []
    let seg = 0
    const flush = () => {
      if (blocks.length === 0) return
      rows.push({
        id: `${message.id}:${seg}`,
        message,
        blocks,
        continuation: seg > 0,
        lastSegment: false,
        parkedRunIds,
      })
      seg++
      blocks = []
      parkedRunIds = []
    }

    for (const block of message.blocks) {
      const anchor = block.srcIndex != null ? anchors.get(block.srcIndex) : undefined
      if (anchor) {
        // The pill starts its own row, so its card can ride level with it.
        flush()
        blocks.push({
          ...block,
          ...(anchor.liveRunId ? { runId: anchor.liveRunId } : {}),
          accent: anchor.accent,
        })
        parkedRunIds = anchor.parkedRunIds
        continue
      }
      blocks.push(block)
    }
    flush()
    const last = rows[rows.length - 1]
    if (last && last.message === message) last.lastSegment = true
  }
  return rows
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
  liveStatus: "idle" | "running" | undefined,
  attached: boolean,
): ThreadStatus {
  if (liveStatus === "running" || (attached && liveStatus === undefined && s.attached)) {
    return { kind: "working", label: "" }
  }
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
    liveStatus?: "idle" | "running"
    modelName?: string
    isActive?: boolean
  } = {},
): Thread {
  const status = threadStatusFromSession(s, opts.isActive ? opts.liveStatus : undefined, !!s.attached)
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
): Thread {
  const messages = itemsToMessages(mainItems(transcript), modelName)
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
