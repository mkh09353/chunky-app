// View model for delegated agent runs: what a card shows, and how a run is tied
// to the pill that spawned it (live beside it, then parked in the same place).
//
// Everything here is derived from the SSE-fed TranscriptState (lib/transcript)
// — no renderer fetches, and it degrades to empty arrays in demo/offline mode
// where there is no transcript at all.
import type { Item, RunRecord, ThreadNode, TranscriptState } from "./transcript"
import { MAIN } from "./transcript"

/** Subtle, low-chroma hues. A run keeps one for its whole life, worn by both
 *  its tool pill (left edge) and its card (left edge). Deliberately few and
 *  muted — this is an identity cue, not a category colour. */
const RUN_ACCENTS = [
  "oklch(0.71 0.14 300)", // violet
  "oklch(0.73 0.10 218)", // blue
  "oklch(0.74 0.12 165)", // teal
  "oklch(0.76 0.11 85)", // amber
] as const

/** Stable per-run hue (same run → same colour across re-renders and replays). */
export function runAccent(runId: string): string {
  let hash = 0
  for (let i = 0; i < runId.length; i++) hash = (hash * 31 + runId.charCodeAt(i)) | 0
  return RUN_ACCENTS[Math.abs(hash) % RUN_ACCENTS.length]!
}

/** A persistent sidekick SEAT, as opposed to a one-shot delegate.
 *
 * The server gives seats a stable thread id (`${rootId}:sidekick[:seat]`) and
 * re-uses it for every brief, so a seat is an agent that outlives its runs;
 * subagents and workflow legs are one-shot. Cards label the two differently. */
export function isSeat(thread: ThreadNode): boolean {
  return thread.id.includes(":sidekick") || /^sidekick\b/i.test(thread.title)
}

function runsByItem(
  state: TranscriptState,
  status: RunRecord["status"],
): Map<number, RunRecord[]> {
  const byItem = new Map<number, RunRecord[]>()
  for (const run of state.runs) {
    // anchorIndex was frozen against the parent's items when the run opened.
    if (run.status !== status || run.parentId !== MAIN || run.anchorIndex < 0) continue
    const list = byItem.get(run.anchorIndex)
    if (list) list.push(run)
    else byItem.set(run.anchorIndex, [run])
  }
  return byItem
}

/** Settled runs grouped by the tool pill that spawned them. */
export function parkedRunsByItem(state: TranscriptState): Map<number, RunRecord[]> {
  return runsByItem(state, "done")
}

/** Running runs keyed by the tool pill that spawned them. */
export function liveRunsByItem(state: TranscriptState): Map<number, RunRecord[]> {
  return runsByItem(state, "running")
}

/** What a single tool pill in the main transcript owns. */
export interface RunAnchor {
  /** The run still in flight from this pill that owns its hue and hover link.
   *  (First of `liveRunIds`; kept separate because the link is 1:1.) */
  liveRunId?: string
  /** Every run still in flight from this pill. Normally one, but a turn that
   *  fires two delegate calls back-to-back can land both on the same pill —
   *  each still streams its own tail inside the card. */
  liveRunIds: string[]
  /** Runs from this pill that have finished: their transcript hangs off the
   *  pill's expanded body. */
  parkedRunIds: string[]
  /** Shared hue for the pill's left edge and its cards'. */
  accent: string
}

/** Tool-item index → the runs it spawned. This is what lets a pill own its
 *  delegates: live tails while they run, full transcripts once they settle. */
export function runAnchors(state: TranscriptState): Map<number, RunAnchor> {
  const anchors = new Map<number, RunAnchor>()
  const add = (at: number, run: RunRecord) => {
    const cur = anchors.get(at) ?? { liveRunIds: [], parkedRunIds: [], accent: runAccent(run.id) }
    if (run.status === "running") {
      cur.liveRunIds.push(run.id)
      cur.liveRunId ??= run.id
    } else cur.parkedRunIds.push(run.id)
    anchors.set(at, cur)
  }
  for (const [at, runs] of liveRunsByItem(state)) for (const run of runs) add(at, run)
  for (const [at, runs] of parkedRunsByItem(state)) for (const run of runs) add(at, run)
  // A live run owns the hue when a pill has both (re-briefed seat).
  for (const [at, anchor] of anchors) {
    const owner = anchor.liveRunId ?? anchor.parkedRunIds[0]
    if (owner) anchors.set(at, { ...anchor, accent: runAccent(owner) })
  }
  return anchors
}

/** Main-transcript item indices that own a delegated run.
 *
 *  Cheaper than `runAnchors` (no hue/link bookkeeping) and used by the mapper,
 *  which only needs to know which tool pills must stay standalone blocks. */
export function anchoredItemIndices(state: TranscriptState | undefined): ReadonlySet<number> {
  const anchored = new Set<number>()
  for (const run of state?.runs ?? []) {
    if (run.parentId === MAIN && run.anchorIndex >= 0) anchored.add(run.anchorIndex)
  }
  return anchored
}

/** Runs by id, for turning anchor ids back into records. */
export function runsById(state: TranscriptState): Map<string, RunRecord> {
  return new Map(state.runs.map((run) => [run.id, run]))
}

/** How many tail lines a live tool-card section keeps in hand. The card shows
 *  the last few collapsed and the rest when expanded — never the whole run, so
 *  a chatty delegate cannot grow the transcript row without bound. */
export const LIVE_TAIL_MAX = 14

/** A delegated run still in flight, as its spawning tool card renders it.
 *
 *  Pure projection of the SSE-fed transcript: no fetches, no timers (elapsed is
 *  clocked separately in useRunClock), so it replays deterministically. */
export interface LiveRunView {
  runId: string
  threadId: string
  /** The delegate's own thread title ("Sidekick (frontend)"). */
  title: string
  model?: string
  toolCount: number
  /** Newest-last tail lines; the card slices what it shows. */
  lines: TailLine[]
}

/** Running runs keyed by run id — what a tool card looks its stream up in.
 *
 *  A run with no thread items yet still gets a view (empty `lines`), so the
 *  card can say "waiting for output…" instead of flickering in late. */
export function liveRunViews(state: TranscriptState | undefined): Map<string, LiveRunView> {
  const views = new Map<string, LiveRunView>()
  if (!state) return views
  for (const run of state.runs) {
    if (run.status !== "running") continue
    const node = state.threads[run.threadId]
    const model = node?.model ?? run.model
    const lines = runLines(node?.items ?? [], run.itemStart)
    views.set(run.id, {
      runId: run.id,
      threadId: run.threadId,
      title: node?.title || run.title,
      ...(model ? { model } : {}),
      toolCount: run.toolCount,
      lines: lines.slice(Math.max(0, lines.length - LIVE_TAIL_MAX)),
    })
  }
  return views
}

export type TailTone = "cmd" | "ok" | "fail" | "text" | "dim"
export interface TailLine {
  text: string
  tone: TailTone
}

const LINE_MAX = 160

function clip(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length > LINE_MAX ? `${flat.slice(0, LINE_MAX - 1)}…` : flat
}

function argPreview(input: unknown): string {
  if (input == null) return ""
  if (typeof input === "string") return clip(input)
  try {
    const obj = input as Record<string, unknown>
    // Prefer the fields that actually say what the call is doing.
    for (const key of ["path", "file", "command", "pattern", "task", "title", "query"]) {
      const v = obj?.[key]
      if (typeof v === "string" && v.trim()) return clip(v)
    }
    return clip(JSON.stringify(input))
  } catch {
    return ""
  }
}

/** Flatten a run's items into terminal-ish lines for the live tail. */
export function runLines(items: Item[], from = 0, to?: number): TailLine[] {
  const lines: TailLine[] = []
  for (const it of items.slice(from, to)) {
    switch (it.kind) {
      case "tool": {
        const arg = argPreview(it.input)
        lines.push({ text: `› ${it.name}${arg ? ` ${arg}` : ""}`, tone: "cmd" })
        if (it.done) {
          const head = (it.output ?? "").split("\n").find((l) => l.trim())
          if (it.ok === false) lines.push({ text: `  ✗ ${clip(head ?? "failed")}`, tone: "fail" })
          else if (head) lines.push({ text: `  ✓ ${clip(head)}`, tone: "ok" })
        } else if (it.progress) {
          const tail = it.progress.split("\n").filter((l) => l.trim()).at(-1)
          if (tail) lines.push({ text: `  ${clip(tail)}`, tone: "dim" })
        }
        break
      }
      case "assistant":
        for (const line of it.text.split("\n")) {
          if (line.trim()) lines.push({ text: clip(line), tone: "text" })
        }
        break
      case "error":
        lines.push({ text: `✗ ${clip(it.text)}`, tone: "fail" })
        break
      case "workflow-phase":
        lines.push({ text: `▸ ${clip(it.title)}`, tone: "cmd" })
        break
      case "workflow-log":
        lines.push({ text: clip(it.message), tone: "dim" })
        break
      default:
        break
    }
  }
  return lines
}

/** Last `max` lines — the tail a running card shows. */

export function runTail(items: Item[], from = 0, max = 5): TailLine[] {
  const lines = runLines(items, from)
  return lines.slice(Math.max(0, lines.length - max))
}

/** One-line gist for a condensed card: the delegate's last words, else its last
 *  tool result, else a placeholder. */
export function runSummary(items: Item[], from = 0, to?: number): string {
  const slice = items.slice(from, to)
  for (let i = slice.length - 1; i >= 0; i--) {
    const it = slice[i]!
    if (it.kind === "assistant" && it.text.trim()) {
      const line = it.text
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .at(-1)
      if (line) return clip(line)
    }
  }
  const lines = runLines(slice)
  return lines.length ? lines[lines.length - 1]!.text : "No output captured."
}

export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  if (total < 60) return `${total}s`
  const m = Math.floor(total / 60)
  const s = total % 60
  if (m < 60) return `${m}m ${String(s).padStart(2, "0")}s`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`
}
