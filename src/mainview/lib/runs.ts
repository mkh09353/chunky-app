// View model for delegated agent runs: what a card shows, and how a run is tied
// to the pill that spawned it (live beside it, then parked in the same place).
//
// Everything here is derived from the SSE-fed TranscriptState (lib/transcript)
// — no renderer fetches, and it degrades to empty arrays in demo/offline mode
// where there is no transcript at all.
import type { StopDelegateRequest } from "@chunky/protocol"
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
  want: (run: RunRecord) => boolean,
): Map<number, RunRecord[]> {
  const byItem = new Map<number, RunRecord[]>()
  for (const run of state.runs) {
    // anchorIndex was frozen against the parent's items when the run opened.
    if (!want(run) || run.parentId !== MAIN || run.anchorIndex < 0) continue
    const list = byItem.get(run.anchorIndex)
    if (list) list.push(run)
    else byItem.set(run.anchorIndex, [run])
  }
  return byItem
}

/** Settled runs grouped by the tool pill that spawned them.
 *
 *  A CANCELLED run parks exactly like a finished one: it keeps its anchor, its
 *  slice of the delegate transcript and its place in the reader's history —
 *  stopping a delegate must never make the work it did disappear. */
export function parkedRunsByItem(state: TranscriptState): Map<number, RunRecord[]> {
  return runsByItem(state, (run) => run.status !== "running")
}

/** Running runs keyed by the tool pill that spawned them. */
export function liveRunsByItem(state: TranscriptState): Map<number, RunRecord[]> {
  return runsByItem(state, (run) => run.status === "running")
}

/** Terminal label for a run: cancelled reads differently from done and from a
 *  failure — the work was stopped on purpose, nothing went wrong. */
export function runStatusLabel(run: Pick<RunRecord, "status">): "Running" | "Done" | "Cancelled" {
  if (run.status === "running") return "Running"
  return run.status === "cancelled" ? "Cancelled" : "Done"
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

/**
 * Is this card's work STILL IN FLIGHT?
 *
 * The fold-at-turn-end rule (ChatView's `collapseSignal`) exists so a finished
 * turn tidies itself away. But a detached sidekick or spawn legitimately
 * outlives the lead's turn, and folding it up at the exact moment the reader
 * decided to keep watching it is the opposite of helpful. So an expanded card
 * whose own run — or, for a seat card standing in for a whole thread, any run on
 * that thread — is still running is exempt from the collapse; it folds normally
 * on the next signal once it has settled.
 *
 * `run` wins when it is given: a card renders ONE pass of a persistent seat, and
 * a seat re-briefed after this pass settled must not keep this card open.
 */
export function isRunCardLive(
  state: TranscriptState | undefined,
  threadId: string,
  run?: RunRecord,
): boolean {
  if (run) return run.status === "running"
  if (!state) return false
  if (state.threads[threadId]?.status === "running") return true
  return state.runs.some((r) => r.threadId === threadId && r.status === "running")
}

// ---- Stopping a delegate --------------------------------------------------
//
// The server cancels a delegate by RUN ID (a detached-spawn record id) or by
// SIDEKICK SEAT (POST ROUTES.stopDelegate, StopDelegateRequest). Neither is
// carried by any AgentEvent, so the App can only offer Stop where the target is
// derivable from what the transcript already holds:
//
//   · a SYNC sidekick runs on the server's STABLE seat thread id
//     (`${sessionId}:sidekick` or `${sessionId}:sidekick:${seat}`), so the seat
//     is read straight off the thread id;
//   · a DETACHED delegate prints its run id in the spawning tool's own output,
//     in one of the server's two wordings — `... launched: <uuid>.` from
//     spawn_thread, `... Run id: <uuid>.` from an explicit or steer detach — so
//     that pill, and only that pill, can name it.
//
// A DETACHED SIDEKICK needs neither trick: detaching does not move the worker
// off its stable seat thread (the server's detached-spawn record carries a
// bookkeeping `${sessionId}:sidekick:${uuid}` id that is never emitted as a
// thread), so it is targeted by seat exactly like a synchronous brief, and the
// server reconciles the live dog with its detached record.
//
// Anything else — nested children, sync spawn_thread children, workflow legs —
// is NOT targetable, and the button is hidden rather than guessed at.
//
// A sync brief's pill has no output until its call returns (by which time the
// run is settled and unstoppable), so the run-id route can only ever fire on a
// pill whose delegate really is detached.

const UUID_SOURCE = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
const UUID = new RegExp(`^${UUID_SOURCE}$`, "i")

/** The run id a detached delegate prints into its own tool output, in either of
 *  the server's two wordings (`launched: <uuid>` from spawn_thread,
 *  `Run id: <uuid>` from explicit/steer detach). */
const DETACHED_RUN_ID = new RegExp(`\\b(?:launched|run id):\\s*(${UUID_SOURCE})\\b`, "i")

/** Seat named by a STABLE sidekick thread id, or null when this thread id is
 *  not one. A `:sidekick:<uuid>` segment is refused defensively: that shape is
 *  the server's detached-record bookkeeping id, and while it is never emitted
 *  as a thread today, a uuid is not a seat the server would match. */
export function seatOfThreadId(threadId: string): string | null {
  const at = threadId.lastIndexOf(":sidekick")
  if (at < 0) return null
  const rest = threadId.slice(at + ":sidekick".length)
  if (rest === "") return "default"
  if (!rest.startsWith(":")) return null
  const seat = rest.slice(1)
  if (!seat || seat.includes(":") || UUID.test(seat)) return null
  return seat
}

/** What the pill knows about the tool call that spawned a run. */
export interface StopAnchorContext {
  /** The spawning tool call's output, once it has one (detached ids live here). */
  toolOutput?: string
  /** How many runs from this pill are still in flight. A pill with two live
   *  runs cannot say WHICH of them the single launched id in its output names,
   *  so that route is refused. */
  liveRunCount?: number
}

/**
 * The stop request for a run, or null when it cannot be targeted.
 *
 * Only a RUNNING run is stoppable: a settled one (done or already cancelled)
 * has nothing to cancel, and offering the button would only produce an
 * "already finished" round-trip.
 */
export function stopTargetOf(
  run: Pick<RunRecord, "status" | "threadId">,
  anchor: StopAnchorContext = {},
): StopDelegateRequest | null {
  if (run.status !== "running") return null
  const launched =
    (anchor.liveRunCount ?? 1) === 1 ? DETACHED_RUN_ID.exec(anchor.toolOutput ?? "")?.[1] : undefined
  if (launched) return { runId: launched }
  const seat = seatOfThreadId(run.threadId)
  // The default seat is addressed by omitting `seat` (see StopDelegateRequest).
  if (seat === "default") return {}
  if (seat) return { seat }
  return null
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

/** Is this live run a persistent sidekick SEAT rather than a one-shot delegate?
 *
 *  Same rule as `isSeat`, expressed against the view a card/strip actually
 *  holds (a `LiveRunView`, not the thread node) so the pill and the ambient
 *  strip cannot drift apart on which glyph a run gets. */
export function isSeatRun(view: LiveRunView): boolean {
  return view.threadId.includes(":sidekick") || /^sidekick\b/i.test(view.title)
}

/** One row of the ambient "active workers" strip: everything it paints, and
 *  nothing it has to go looking for.
 *
 *  Derived from `liveRunViews`, so the strip and the tool pill's own live
 *  section read the SAME tail state — there is no second stream to keep in
 *  sync. */
export interface ActiveWorkerRow {
  runId: string
  threadId: string
  title: string
  model?: string
  toolCount: number
  /** Sidekick seat (bot) vs one-shot delegate (sparkles). */
  seat: boolean
  /** The run's hue, shared with its pill and its card. */
  accent: string
  /** Newest tail line, or undefined while the run has printed nothing. */
  lastLine?: TailLine
}

/**
 * The strip's whole rule: show a row per live run, but ONLY while the root is
 * idle.
 *
 * While the lead's own turn is running the transcript is already visibly
 * working and every live run streams inside the pill that spawned it — a second
 * ambient list would just be noise. The moment the root goes idle with delegates
 * still in flight (a detached spawn or sidekick outliving the turn) the chat
 * column has nothing left saying so, and that is exactly what this fills.
 *
 * Reactive by construction: rows come straight from `state.runs`, so a run that
 * settles after the lead is idle (`thread.status: idle` → `closeRun`) drops out
 * on the next projection, and an empty result hides the strip.
 */
export function activeWorkerRows(
  state: TranscriptState | undefined,
  /** Is the ROOT turn still running? (App's `streaming`.) */
  streaming: boolean,
): ActiveWorkerRow[] {
  if (!state || streaming || state.status === "running") return []
  const rows: ActiveWorkerRow[] = []
  // Spawn order: the map is built from `state.runs`, which is append-only.
  for (const view of liveRunViews(state).values()) {
    const last = view.lines[view.lines.length - 1]
    rows.push({
      runId: view.runId,
      threadId: view.threadId,
      title: view.title,
      ...(view.model ? { model: view.model } : {}),
      toolCount: view.toolCount,
      seat: isSeatRun(view),
      accent: runAccent(view.runId),
      ...(last ? { lastLine: last } : {}),
    })
  }
  return rows
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
          // A call stopped with its thread reads neutrally: no red cross, no
          // "failed", because nothing went wrong — it was called off.
          if (it.cancelled) lines.push({ text: `  ⊘ ${clip(head ?? "cancelled")}`, tone: "dim" })
          else if (it.ok === false) lines.push({ text: `  ✗ ${clip(head ?? "failed")}`, tone: "fail" })
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
