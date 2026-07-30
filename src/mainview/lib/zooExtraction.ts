// One product-factory extraction pass: export the evidence bundle, have a real
// Chunky session dedupe/cluster it, then record the resulting insights.
//
// The model work runs through the ordinary server session API (lib/api.ts) —
// there is no dedicated endpoint for this — and only the minimal slice of the
// event stream is consumed: main-thread assistant text plus turn completion.

import type { AgentEvent } from "@chunky/protocol"
import { createSession, loadConfig, openEventStream, sendMessage } from "./api"
import {
  zooExportForExtraction,
  zooFailPass,
  zooRecordInsights,
  type ZooInsightInput,
} from "./zoo"

/** Hard stop so a stalled turn cannot leave the pane spinning forever. */
const RUN_TIMEOUT_MS = 10 * 60_000

export type ExtractionPhase = "exporting" | "starting" | "thinking" | "recording"

export type ExtractionResult =
  | { ok: true; passId: string; insightCount: number }
  | { ok: false; error: string; passId?: string }

export type ParsedInsights =
  | { ok: true; insights: ZooInsightInput[] }
  | { ok: false; error: string }

/** Fenced block, optionally tagged ```json. Prose either side is expected. */
const FENCE = /```[ \t]*([a-zA-Z0-9_-]*)[ \t]*\r?\n([\s\S]*?)```/g

function pickFencedBlock(text: string): string | null {
  let tagged: string | null = null
  let untagged: string | null = null
  FENCE.lastIndex = 0
  for (let match = FENCE.exec(text); match; match = FENCE.exec(text)) {
    const tag = (match[1] ?? "").toLowerCase()
    const body = match[2] ?? ""
    if (tag === "json") tagged = body
    else if (!tag) untagged = body
  }
  // Prefer the last ```json block; fall back to the last untagged fence.
  return tagged ?? untagged
}

function clampPriority(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined
  return Math.min(5, Math.max(1, Math.round(value)))
}

/**
 * Parse the model's reply into insights. The reply is REQUIRED to carry a
 * fenced block — a bare JSON body is treated as a failed instruction-follow so
 * the pass is recorded as an error rather than silently guessed at.
 */
export function parseFencedInsights(text: string): ParsedInsights {
  const block = typeof text === "string" ? pickFencedBlock(text) : null
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
    return { ok: false, error: "The fenced JSON block was not an array of insights." }
  }
  const insights: ZooInsightInput[] = []
  for (const item of parsed) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      return { ok: false, error: "An insight entry was not an object." }
    }
    const row = item as Record<string, unknown>
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
  if (!insights.length) {
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
 * Read the main thread's final assistant text for one turn.
 *
 * `message.end` (no threadId) is the completion signal; `session.status: idle`
 * is the fallback for turns that end without one. Sub-agent threads carry a
 * threadId and are ignored.
 */
function awaitAssistantText(
  baseUrl: string,
  sessionId: string,
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

    timer = setTimeout(() => fail(new Error("The extraction run timed out.")), RUN_TIMEOUT_MS) as unknown as number

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

function message(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback
}

/**
 * Run a full extraction pass. Any failure after the pass exists is reported to
 * the store via zooFailPass so the pane and the durable record agree.
 */
export async function runExtraction(
  opts: { baseUrl?: string | null; maxChars?: number; onPhase?: (phase: ExtractionPhase) => void } = {},
): Promise<ExtractionResult> {
  const phase = (next: ExtractionPhase) => opts.onPhase?.(next)

  phase("exporting")
  const exported = await zooExportForExtraction(opts.maxChars)
  if (!exported.ok) return { ok: false, error: exported.error }
  const { passId, bundle } = exported

  const failPass = async (error: string): Promise<ExtractionResult> => {
    await zooFailPass(passId, error)
    return { ok: false, error, passId }
  }

  phase("starting")
  let baseUrl = opts.baseUrl ?? null
  if (!baseUrl) {
    try {
      baseUrl = (await loadConfig()).baseUrl
    } catch (err) {
      return failPass(message(err, "Could not resolve the Chunky server."))
    }
  }
  if (!baseUrl) return failPass("No Chunky server is available for extraction.")

  let sessionId: string
  try {
    sessionId = (await createSession(baseUrl)).sessionId
  } catch (err) {
    return failPass(message(err, "Could not create an extraction session."))
  }

  let opened = false
  const stream = awaitAssistantText(baseUrl, sessionId, () => {
    opened = true
  })

  let reply: string
  try {
    // Wait for the stream to accept before sending, so no delta is missed.
    for (let i = 0; i < 100 && !opened; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    await sendMessage(baseUrl, sessionId, buildExtractionPrompt(bundle))
    phase("thinking")
    reply = await stream.promise
  } catch (err) {
    stream.cancel()
    return failPass(message(err, "The extraction run failed."))
  }

  const parsed = parseFencedInsights(reply)
  if (!parsed.ok) return failPass(parsed.error)

  phase("recording")
  const recorded = await zooRecordInsights(passId, parsed.insights)
  if (!recorded.ok) return failPass(recorded.error)
  return { ok: true, passId, insightCount: recorded.insightCount }
}
