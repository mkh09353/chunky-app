// Typed client + pure helpers for the server's auto-evals surface.
//
// Two halves, like the other server-API modules here:
//   - the wire calls, which reuse configApi's req()/reqText() so base URL and
//     auth resolution live in exactly one place (never fetch from a component);
//   - the pure formatting/parsing helpers the Evals view renders with, which
//     are testable without a DOM or a server.
//
// Every wire shape comes from @chunky/protocol — nothing is redefined here.
import { ROUTES } from "@chunky/protocol"
import type {
  EvalCandidateDetailResponse,
  EvalCandidateSummary,
  EvalCandidatesResponse,
  EvalBriefStruct,
  EvalPromoteBucket,
  EvalRatingJson,
  EvalReplayRequest,
  EvalReplayStartResponse,
  EvalReplaySummary,
  EvalReplaysResponse,
  EvalsMode,
  EvalsResponse,
  PromoteEvalCandidateRequest,
  SetEvalsRequest,
} from "@chunky/protocol"
import { HttpError, jsonInit, req, reqText } from "./configApi"

export type {
  EvalBriefStruct,
  EvalCandidateDetailResponse,
  EvalCandidateSummary,
  EvalCandidatesResponse,
  EvalPromoteBucket,
  EvalRatingJson,
  EvalReplayRequest,
  EvalReplayStartResponse,
  EvalReplayStatus,
  EvalReplaySummary,
  EvalReplaysResponse,
  EvalsMode,
  EvalsResponse,
} from "@chunky/protocol"
export { HttpError } from "./configApi"

/** The buckets the promote dialog offers. "none" promotes without a bucket. */
export const PROMOTE_BUCKETS = ["hard", "regression", "random", "none"] as const
export type PromoteBucketChoice = (typeof PROMOTE_BUCKETS)[number]

// ---- Wire calls ----------------------------------------------------------

/** Current recorder mode + on-disk stats. */
export async function getEvals(): Promise<EvalsResponse> {
  return req<EvalsResponse>(ROUTES.evals)
}

/** Switch the recorder on ("record") or off. Returns the new state. */
export async function setEvalsMode(mode: EvalsMode): Promise<EvalsResponse> {
  const body: SetEvalsRequest = { mode }
  return req<EvalsResponse>(ROUTES.evals, jsonInit("POST", body))
}

/** Candidates, newest-first (the server orders them). */
export async function listEvalCandidates(): Promise<EvalCandidateSummary[]> {
  const data = await req<EvalCandidatesResponse>(ROUTES.evalsCandidates)
  return data.candidates ?? []
}

export async function getEvalCandidate(id: string): Promise<EvalCandidateDetailResponse> {
  return req<EvalCandidateDetailResponse>(ROUTES.evalsCandidate(id))
}

/** The recorded worker transcript, as raw JSONL text. Can be large — only the
 *  open detail view should ask for it. */
export async function getEvalTranscript(id: string): Promise<string> {
  return reqText(ROUTES.evalsCandidateTranscript(id))
}

/** Promote into the eval suite. Throws HttpError 409 when already promoted. */
export async function promoteEvalCandidate(
  id: string,
  bucket?: EvalPromoteBucket,
): Promise<EvalCandidateDetailResponse> {
  const body: PromoteEvalCandidateRequest = bucket ? { bucket } : {}
  return req<EvalCandidateDetailResponse>(
    ROUTES.evalsCandidatePromote(id),
    jsonInit("POST", body),
  )
}

/** Prune a non-promoted candidate. The server refuses (409) a promoted one. */
export async function deleteEvalCandidate(id: string): Promise<void> {
  await req<unknown>(ROUTES.evalsCandidate(id), { method: "DELETE" })
}

/**
 * Kick off a replay of this candidate's brief. An empty selection re-runs the
 * model the candidate was recorded with (the server resolves the default).
 * Throws HttpError 409 when a replay for this candidate is already running.
 */
export async function startEvalReplay(
  id: string,
  selection?: EvalReplayRequest,
): Promise<EvalReplayStartResponse> {
  const body: EvalReplayRequest = {
    ...(selection?.provider ? { provider: selection.provider } : {}),
    ...(selection?.model ? { model: selection.model } : {}),
    ...(selection?.effort ? { effort: selection.effort } : {}),
  }
  return req<EvalReplayStartResponse>(ROUTES.evalsCandidateReplay(id), jsonInit("POST", body))
}

/** Replay runs for one candidate, newest-first (the server orders them). */
export async function listEvalReplays(id: string): Promise<EvalReplaySummary[]> {
  const data = await req<EvalReplaysResponse>(ROUTES.evalsCandidateReplays(id))
  return data.replays ?? []
}

/** True for the "already promoted" / "still promoted" conflict, which the UI
 *  reports as state rather than as a failure. */
export function isConflict(err: unknown): boolean {
  return err instanceof HttpError && err.status === 409
}

/** True when this server predates the evals routes entirely. */
export function isUnsupported(err: unknown): boolean {
  return err instanceof HttpError && (err.status === 404 || err.status === 501)
}

export function errorMessage(err: unknown): string {
  return (err as Error)?.message || "Something went wrong"
}

// ---- Formatting ----------------------------------------------------------

/** "1.2 GB" / "480 KB" / "0 B". */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B"
  const units = ["B", "KB", "MB", "GB", "TB"]
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  const rounded = value >= 100 || unit === 0 ? Math.round(value) : Math.round(value * 10) / 10
  return `${rounded} ${units[unit]}`
}

/** "312 candidates · 47 promoted · 1.2 GB" — the settings usage line. */
export function statsLine(stats: { candidates: number; promoted: number; bytes: number }): string {
  const n = (v: number) => (Number.isFinite(v) ? Math.max(0, Math.round(v)) : 0)
  return `${n(stats.candidates).toLocaleString()} candidate${n(stats.candidates) === 1 ? "" : "s"} · ${n(stats.promoted).toLocaleString()} promoted · ${formatBytes(stats.bytes)}`
}

/** "c 3/3 · x 2/3 · r 2/2 · +1" — the rating card's sub-score strip. */
export function subScoreLine(rating: EvalRatingJson): string {
  const parts = [
    `c ${num(rating.compliance)}/3`,
    `x ${num(rating.correctness)}/3`,
    `r ${num(rating.report)}/2`,
  ]
  if (num(rating.exceeded) > 0) parts.push(`+${num(rating.exceeded)}`)
  return parts.join(" · ")
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0
}

/** 1–10 → a coarse tone for the rating pill. */
export function ratingTone(rating: number | undefined): "success" | "warning" | "destructive" | "muted" {
  if (rating == null || !Number.isFinite(rating)) return "muted"
  if (rating >= 8) return "success"
  if (rating >= 6) return "warning"
  return "destructive"
}

/** "provider · model · effort", skipping the parts the record didn't have. */
export function modelLine(parts: { provider?: string; model?: string; effort?: string }): string {
  return [parts.provider, parts.model, parts.effort].filter((p) => !!p && p.trim()).join(" · ")
}

/** Absolute local timestamp for the metadata block. */
export function whenLabel(ms: number | undefined): string {
  if (!ms || !Number.isFinite(ms)) return "—"
  const d = new Date(ms)
  if (Number.isNaN(d.getTime())) return "—"
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })
}

/** The structured brief, as ordered sections for rendering. Empty when the
 *  candidate has no briefStruct — the view then shows briefComposed. */
export interface BriefSection {
  label: string
  /** Rendered as a bullet list when it has more than one entry. */
  values: string[]
}

export function briefSections(brief: EvalBriefStruct | undefined): BriefSection[] {
  if (!brief) return []
  const out: BriefSection[] = []
  if (brief.task?.trim()) out.push({ label: "Task", values: [brief.task.trim()] })
  const constraints = (brief.constraints ?? []).map((c) => String(c).trim()).filter(Boolean)
  if (constraints.length > 0) out.push({ label: "Constraints", values: constraints })
  if (brief.done_when?.trim()) out.push({ label: "Done when", values: [brief.done_when.trim()] })
  if (brief.pointers?.trim()) out.push({ label: "Pointers", values: [brief.pointers.trim()] })
  return out
}

/**
 * The promoted badge's text. The bucket is the server's own field, so a badge
 * survives a reload; a promotion the server recorded without one still reads
 * as a plain "promoted" rather than inventing a bucket.
 */
export function promotedBadgeLabel(
  promoted: boolean,
  bucket: EvalPromoteBucket | undefined,
): string | null {
  if (!promoted) return null
  return bucket ? `promoted · ${bucket}` : "promoted"
}

// ---- Replays -------------------------------------------------------------

/** True while at least one replay is still running — the poll's own on/off
 *  switch, so an idle detail view issues no requests. */
export function hasRunningReplay(replays: readonly EvalReplaySummary[]): boolean {
  return replays.some((replay) => replay.status === "running")
}

/** Status pill text. "done" splits on the run's own ok flag: a replay that
 *  finished with a failing report is not the same as one that crashed. */
export function replayStatusLabel(replay: EvalReplaySummary): string {
  if (replay.status === "running") return "running"
  if (replay.status === "error") return "error"
  return replay.ok === false ? "failed" : "ok"
}

export function replayStatusTone(
  replay: EvalReplaySummary,
): "success" | "warning" | "destructive" | "muted" {
  if (replay.status === "running") return "muted"
  if (replay.status === "error") return "destructive"
  return replay.ok === false ? "warning" : "success"
}

/** "12s" / "4m 03s" / "1h 12m" — how long a run took, or has been going. */
export function durationLabel(startedAt: number, endedAt: number): string {
  const ms = endedAt - startedAt
  if (!Number.isFinite(ms) || ms < 0) return "—"
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`
}

/** The timing line under a replay row: elapsed for a live run, total for a
 *  finished one. `now` is passed in so the row can tick without a clock here. */
export function replayTimingLabel(replay: EvalReplaySummary, now: number): string {
  if (replay.status === "running") return `running for ${durationLabel(replay.startedAt, now)}`
  if (replay.completedAt == null) return "finished"
  return `took ${durationLabel(replay.startedAt, replay.completedAt)}`
}

/** "provider/model" for a model picker, from whatever the candidate recorded. */
export function modelKey(provider: string | undefined, model: string | undefined): string {
  return provider && model ? `${provider}/${model}` : ""
}

/** One-line summary for a list row: never empty, never enormous. */
export function taskLine(task: string | undefined, max = 160): string {
  const text = (task ?? "").replace(/\s+/g, " ").trim()
  if (!text) return "Untitled brief"
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

// ---- Transcript parsing --------------------------------------------------

export type TranscriptKind =
  | "user"
  | "assistant"
  | "tool"
  | "tool-result"
  | "event"
  | "raw"

/** One rendered row of the transcript list. */
export interface TranscriptEntry {
  /** Stable key: the store sequence when known, otherwise the row index. */
  key: string
  seq: number | null
  kind: TranscriptKind
  /** Short left-hand label ("assistant", "tool bash", "raw line"). */
  label: string
  /** Compact preview, already single-line-ish. */
  preview: string
  /** Full text, shown when the row is expanded. */
  detail: string
  /** Tool results carry their ok flag. */
  ok?: boolean
}

const PREVIEW_MAX = 200

function preview(text: string, max = PREVIEW_MAX): string {
  const flat = text.replace(/\s+/g, " ").trim()
  if (!flat) return ""
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

function asString(value: unknown): string {
  if (typeof value === "string") return value
  if (value === undefined) return ""
  try {
    return JSON.stringify(value, null, 2) ?? ""
  } catch {
    return String(value)
  }
}

/**
 * Parse the recorded JSONL into display rows.
 *
 * Each line is `{ seq, json }` where `json` is a serialized AgentEvent; a line
 * that doesn't parse (truncated write, a future shape) degrades to a "raw" row
 * rather than blanking the transcript. Consecutive assistant deltas and tool
 * progress chunks are coalesced, so a long run reads as a handful of rows
 * instead of thousands.
 */
export function parseTranscript(text: string): TranscriptEntry[] {
  const out: TranscriptEntry[] = []
  const lines = text.split("\n")
  let index = 0
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    index += 1
    const key = `l${index}`
    let seq: number | null = null
    let event: Record<string, unknown> | null = null
    try {
      const outer = JSON.parse(trimmed) as Record<string, unknown>
      if (typeof outer?.seq === "number") seq = outer.seq
      if (typeof outer?.json === "string") {
        event = JSON.parse(outer.json) as Record<string, unknown>
      } else if (outer && typeof outer === "object" && typeof outer.type === "string") {
        event = outer
      }
    } catch {
      event = null
    }
    if (!event || typeof event.type !== "string") {
      out.push({
        key,
        seq,
        kind: "raw",
        label: "raw line",
        preview: preview(trimmed),
        detail: trimmed,
      })
      continue
    }
    const entry = entryFor(key, seq, event)
    if (!entry) continue
    const last = out[out.length - 1]
    // Coalesce a stream of deltas/progress chunks into the row before it.
    if (
      last &&
      ((entry.kind === "assistant" && last.kind === "assistant" && entry.label === last.label) ||
        (entry.kind === "tool-result" &&
          last.kind === "tool-result" &&
          entry.label === last.label &&
          entry.ok === undefined &&
          last.ok === undefined))
    ) {
      last.detail += entry.detail
      last.preview = preview(last.detail)
      continue
    }
    out.push(entry)
  }
  return out
}

function entryFor(
  key: string,
  seq: number | null,
  event: Record<string, unknown>,
): TranscriptEntry | null {
  const type = String(event.type)
  const row = (
    kind: TranscriptKind,
    label: string,
    detail: string,
    ok?: boolean,
  ): TranscriptEntry => ({ key, seq, kind, label, preview: preview(detail), detail, ok })

  switch (type) {
    case "message.user":
      return row("user", "user", asString(event.text))
    case "message.interjection":
      return row("user", "interjection", asString(event.text))
    case "message.start":
      return null
    case "message.delta":
      return row("assistant", "assistant", asString(event.text))
    case "message.end": {
      const reason = asString(event.reason)
      return reason ? row("event", "message end", reason) : null
    }
    case "tool.start": {
      const name = asString(event.name) || "tool"
      return row("tool", `tool ${name}`, asString(event.input))
    }
    case "tool.progress":
      return row("tool-result", "tool output", asString(event.chunk))
    case "tool.end": {
      const ok = event.ok !== false
      return row("tool-result", ok ? "tool ok" : "tool failed", asString(event.output), ok)
    }
    default: {
      const detail = asString(event)
      return row("event", type, detail)
    }
  }
}
