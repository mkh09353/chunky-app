// One product-factory extraction pass: export the evidence bundle, have a real
// Chunky session dedupe/cluster it, then record the resulting insights.
//
// The model work runs through the ordinary server session API (lib/api.ts) —
// there is no dedicated endpoint for this — and only the minimal slice of the
// event stream is consumed: main-thread assistant text plus turn completion.
//
// The fenced-JSON parser and the session-prompt runner here are shared with
// lib/zooSynthesis.ts (ideas) — keep them generic.

import type { AgentEvent } from "@chunky/protocol"
import { createSession, loadConfig, openEventStream, sendMessage } from "./api"
import {
  zooExportForExtraction,
  zooFailPass,
  zooRecordInsights,
  type ZooInsightInput,
} from "./zoo"

/** Hard stop so a stalled turn cannot leave the pane spinning forever. */
export const DEFAULT_RUN_TIMEOUT_MS = 10 * 60_000

export type ExtractionPhase = "exporting" | "starting" | "thinking" | "recording"

export type ExtractionResult =
  | { ok: true; passId: string; insightCount: number }
  | { ok: false; error: string; passId?: string }

export type ParsedInsights =
  | { ok: true; insights: ZooInsightInput[] }
  | { ok: false; error: string }

/** Fenced block, optionally tagged ```json. Prose either side is expected. */
const FENCE = /```[ \t]*([a-zA-Z0-9_-]*)[ \t]*\r?\n([\s\S]*?)```/g

/** Last ```json block, else the last untagged fence. Null when there is none. */
export function pickFencedBlock(text: string): string | null {
  if (typeof text !== "string") return null
  let tagged: string | null = null
  let untagged: string | null = null
  FENCE.lastIndex = 0
  for (let match = FENCE.exec(text); match; match = FENCE.exec(text)) {
    const tag = (match[1] ?? "").toLowerCase()
    const body = match[2] ?? ""
    if (tag === "json") tagged = body
    else if (!tag) untagged = body
  }
  return tagged ?? untagged
}

export type FencedRows =
  | { ok: true; rows: Record<string, unknown>[] }
  | { ok: false; error: string }

/**
 * Shared shape check for every "reply with ONLY a fenced json array" prompt.
 *
 * A fence is REQUIRED — a bare JSON body is treated as a failed
 * instruction-follow so the pass is recorded as an error rather than guessed at.
 */
export function parseFencedRows(text: string): FencedRows {
  const block = pickFencedBlock(text)
  if (block === null) {
    return { ok: false, error: "The model reply contained no fenced JSON block." }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(block)
  } catch (err) {
    return {
      ok: false,
      error: `The fenced block was not valid JSON: ${err instanceof Error ? err.message : "parse error"}`,
    }
  }
  if (!Array.isArray(parsed)) {
    return { ok: false, error: "The fenced JSON block was not an array." }
  }
  const rows: Record<string, unknown>[] = []
  for (const entry of parsed) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      return { ok: false, error: "An entry in the fenced array was not an object." }
    }
    rows.push(entry as Record<string, unknown>)
  }
  return { ok: true, rows }
}

function clampPriority(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined
  return Math.min(5, Math.max(1, Math.round(value)))
}

/**
 * Parse the model's reply into insights.
 *
 * Strict on purpose: any malformed entry fails the whole pass, because a
 * half-understood evidence set is worse than none (contrast with the ideas
 * parser in lib/zooSynthesis.ts, which drops bad entries — see the note there).
 */
export function parseFencedInsights(text: string, opts: { allowEmpty?: boolean } = {}): ParsedInsights {
  const fenced = parseFencedRows(text)
  if (!fenced.ok) return fenced
  const insights: ZooInsightInput[] = []
  for (const row of fenced.rows) {
    const title = typeof row.title === "string" ? row.title.trim() : ""
    const summary = typeof row.summary === "string" ? row.summary.trim() : ""
    if (!title || !summary) {
      return { ok: false, error: "An insight entry was missing a title or summary." }
    }
    const evidence: ZooInsightInput["evidence"] = []
    if (row.evidence !== undefined) {
      if (!Array.isArray(row.evidence)) {
        return { ok: false, error: `Insight "${title}" had non-array evidence.` }
      }
      for (const raw of row.evidence) {
        if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
          return { ok: false, error: `Insight "${title}" had a malformed evidence entry.` }
        }
        const cite = raw as Record<string, unknown>
        const artifactId = typeof cite.artifactId === "string" ? cite.artifactId.trim() : ""
        const quote = typeof cite.quote === "string" ? cite.quote.trim() : ""
        if (!artifactId || !quote) {
          return { ok: false, error: `Insight "${title}" had an evidence entry without an artifact quote.` }
        }
        evidence.push({ artifactId, quote })
      }
    }
    const priority = clampPriority(row.priority)
    insights.push({ title, summary, ...(priority !== undefined ? { priority } : {}), evidence })
  }
  if (!insights.length && !opts.allowEmpty) {
    return { ok: false, error: "The model returned an empty insight array." }
  }
  return { ok: true, insights }
}

export function buildExtractionPrompt(bundle: string): string {
  return [
    "You are triaging raw product signals collected from connected sources.",
    "Each artifact below is delimited and carries an artifactId.",
    "",
    "Deduplicate and cluster these signals into distinct product insights. Merge",
    "restatements of the same underlying need, and keep every insight grounded in",
    "verbatim quotes from the artifacts.",
    "",
    "Reply with ONLY a fenced ```json block containing an array of objects:",
    '{ "title": string, "summary": string, "priority": 1-5 (1 = highest),',
    '  "evidence": [{ "artifactId": string, "quote": string }] }',
    "No prose before or after the block. Do not invent artifactIds.",
    "",
    "--- ARTIFACTS ---",
    bundle,
  ].join("\n")
}

/**
 * The competitor-watch framing of the SAME pass.
 *
 * The artifacts are repository activity, so the insight worth recording is not
 * "they released 1.2" but "they shipped X, here is the link, and here is
 * whether it applies to us". One prompt swap — everything after it (fence
 * parsing, evidence checks, recording) is the shared path.
 */
export function buildCompetitorPrompt(bundle: string): string {
  return [
    "You are reading what COMPARABLE open-source products shipped recently, to",
    "decide whether any of it should change our plans. Each artifact below is one",
    "repository's activity in one window, and carries an artifactId.",
    "",
    "Record one insight per distinct thing they shipped that a product owner",
    "should know about. Skip housekeeping: dependency bumps, CI, refactors, typo",
    "fixes, release chores.",
    "",
    'Title: "<owner/repo> shipped <the thing>".',
    "Summary: what it actually does, the link to read more, and — explicitly —",
    "whether it plausibly applies to our product and why or why not.",
    "Priority 1 means we should react soon; 5 means it is context only.",
    "",
    "Reply with ONLY a fenced ```json block containing an array of objects:",
    '{ "title": string, "summary": string, "priority": 1-5 (1 = highest),',
    '  "evidence": [{ "artifactId": string, "quote": string }] }',
    "Quote the artifact verbatim as evidence. Do not invent artifactIds.",
    "If nothing in the window is worth a product decision, reply with [].",
    "",
    "--- COMPETITOR ACTIVITY ---",
    bundle,
  ].join("\n")
}

/**
 * Read the main thread's final assistant text for one turn.
 *
 * `message.end` (no threadId) is the completion signal; `session.status: idle`
 * is the fallback for turns that end without one. Sub-agent threads carry a
 * threadId and are ignored.
 */
function awaitAssistantText(
  baseUrl: string,
  sessionId: string,
  timeoutMs: number,
  onOpen: () => void,
): { promise: Promise<string>; cancel: () => void } {
  const controller = new AbortController()
  let settled = false
  let timer = 0

  const promise = new Promise<string>((resolve, reject) => {
    let text = ""
    const finish = (value: string) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve(value)
      controller.abort()
    }
    const fail = (error: Error) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      reject(error)
      controller.abort()
    }

    timer = setTimeout(() => fail(new Error("The run timed out.")), timeoutMs) as unknown as number

    const onEvent = (ev: AgentEvent) => {
      if (ev.type === "message.start") {
        if (!ev.threadId) text = ""
        return
      }
      if (ev.type === "message.delta") {
        if (!ev.threadId) text += ev.text
        return
      }
      if (ev.type === "message.end") {
        if (!ev.threadId) finish(text)
        return
      }
      if (ev.type === "session.status" && ev.status === "idle" && text.trim()) finish(text)
    }

    void openEventStream(baseUrl, sessionId, onEvent, controller.signal, onOpen)
      .then(() => {
        // Stream closed by the server; whatever we accumulated is all there is.
        if (!settled) {
          if (text.trim()) finish(text)
          else fail(new Error("The session stream closed before the model replied."))
        }
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return
        fail(err instanceof Error ? err : new Error("The session event stream failed."))
      })
  })

  return {
    promise,
    cancel: () => {
      if (timer) clearTimeout(timer)
      controller.abort()
    },
  }
}

export function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback
}

export type SessionPromptResult =
  | { ok: true; sessionId: string; text: string }
  | { ok: false; error: string }

/**
 * One prompt, one fresh session, one reply. `repoId` binds the session to a
 * workspace so the agent can explore that codebase (triage); omit it for pure
 * reasoning passes.
 */
export async function runSessionPrompt(opts: {
  prompt: string
  baseUrl?: string | null
  repoId?: string | null
  timeoutMs?: number
  onSession?: (sessionId: string) => void
}): Promise<SessionPromptResult> {
  let baseUrl = opts.baseUrl ?? null
  if (!baseUrl) {
    try {
      baseUrl = (await loadConfig()).baseUrl
    } catch (err) {
      return { ok: false, error: errorMessage(err, "Could not resolve the Chunky server.") }
    }
  }
  if (!baseUrl) return { ok: false, error: "No Chunky server is available." }

  let sessionId: string
  try {
    sessionId = (await createSession(baseUrl, opts.repoId ?? null)).sessionId
  } catch (err) {
    return { ok: false, error: errorMessage(err, "Could not create a session.") }
  }
  opts.onSession?.(sessionId)

  let opened = false
  const stream = awaitAssistantText(
    baseUrl,
    sessionId,
    opts.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS,
    () => {
      opened = true
    },
  )
  try {
    // Wait for the stream to accept before sending, so no delta is missed.
    for (let i = 0; i < 100 && !opened; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    await sendMessage(baseUrl, sessionId, opts.prompt)
    return { ok: true, sessionId, text: await stream.promise }
  } catch (err) {
    stream.cancel()
    return { ok: false, error: errorMessage(err, "The run failed.") }
  }
}

/**
 * Run a full extraction pass. Any failure after the pass exists is reported to
 * the store via zooFailPass so the pane and the durable record agree.
 */
export async function runExtraction(
  opts: {
    baseUrl?: string | null
    maxChars?: number
    areaId?: string | null
    /** Narrow the pass to one source (a competitor watch reads only itself). */
    sourceId?: string | null
    /** Only artifacts fetched after this moment — the watch's last pass. */
    sinceFetchedAt?: number | null
    /** Which framing to read the artifacts with. */
    focus?: "general" | "competitor"
    onPhase?: (phase: ExtractionPhase) => void
  } = {},
): Promise<ExtractionResult> {
  const phase = (next: ExtractionPhase) => opts.onPhase?.(next)

  phase("exporting")
  const competitor = opts.focus === "competitor"
  const exported = await zooExportForExtraction(opts.maxChars, opts.areaId, {
    ...(opts.sourceId ? { sourceId: opts.sourceId } : {}),
    ...(typeof opts.sinceFetchedAt === "number" ? { sinceFetchedAt: opts.sinceFetchedAt } : {}),
  })
  if (!exported.ok) return { ok: false, error: exported.error }
  const { passId, bundle } = exported
  // Nothing new to read: close the pass cleanly instead of asking a model to
  // summarize an empty bundle.
  if (!bundle.trim()) {
    const empty = await zooRecordInsights(passId, [], opts.areaId)
    return empty.ok
      ? { ok: true, passId, insightCount: 0 }
      : { ok: false, error: empty.error, passId }
  }

  const failPass = async (error: string): Promise<ExtractionResult> => {
    await zooFailPass(passId, error)
    return { ok: false, error, passId }
  }

  phase("starting")
  const reply = await runSessionPrompt({
    prompt: competitor ? buildCompetitorPrompt(bundle) : buildExtractionPrompt(bundle),
    baseUrl: opts.baseUrl ?? null,
    // The session exists, so the wait for the model starts here.
    onSession: () => phase("thinking"),
  })
  if (!reply.ok) return failPass(reply.error)

  const parsed = parseFencedInsights(reply.text, { allowEmpty: competitor })
  if (!parsed.ok) return failPass(parsed.error)

  phase("recording")
  const recorded = await zooRecordInsights(passId, parsed.insights, opts.areaId)
  if (!recorded.ok) return failPass(recorded.error)
  return { ok: true, passId, insightCount: recorded.insightCount }
}
