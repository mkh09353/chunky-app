// Webview bridge for the product-factory ("zoo") store that lives in the Bun
// process. Mirrors lib/dirSearch.ts / lib/terminal.ts: RPC only (never a bun:*
// or node builtin import), every response validated before it is handed to the
// UI, and a clear `unavailable` answer in the plain-browser build so the
// Factory can render a "requires the desktop app" state instead of fake data.

import { getRpc, nativeRpcAvailable } from "./rpc"
import type {
  ZooArtifactMeta,
  ZooDecision,
  ZooEvidence,
  ZooIdea,
  ZooIdeaStatus,
  ZooIdeaType,
  ZooInsight,
  ZooItem,
  ZooItemStage,
  ZooPass,
  ZooSource,
} from "../../shared/zooTypes"

export type {
  ZooArtifactMeta,
  ZooBackfillState,
  ZooDecision,
  ZooEvidence,
  ZooIdea,
  ZooIdeaStatus,
  ZooIdeaType,
  ZooInsight,
  ZooItem,
  ZooItemStage,
  ZooPass,
  ZooSource,
} from "../../shared/zooTypes"

export const IDEA_TYPES: readonly ZooIdeaType[] = ["close", "investigate", "build", "needs-detail"]
export const ITEM_STAGES: readonly ZooItemStage[] = [
  "research",
  "decision",
  "building",
  "review",
  "shipped",
  "dropped",
]

export const ZOO_UNAVAILABLE = "The Factory requires the desktop app."

/** `unavailable` marks "no native bridge here", not "the call failed". */
export type ZooFailure = { ok: false; error: string; unavailable?: boolean }
export type ZooResult<T extends object> = ({ ok: true } & T) | ZooFailure

export type ZooStatus = {
  sources: ZooSource[]
  artifactCount: number
  insightCount: number
  ideaCount: number
  itemCount: number
  passes: ZooPass[]
}
export type ZooArtifactDetail = ZooArtifactMeta & { content: string }
export type ZooInsightInput = {
  title: string
  summary: string
  priority?: number
  evidence: ZooEvidence[]
}
export type ZooIdeaInput = {
  type: ZooIdeaType
  title: string
  rationale: string
  insightIds: string[]
}
export type ZooItemUpdate = {
  stage?: ZooItemStage
  addSessionId?: string
  addDecision?: { actor: ZooDecision["actor"]; note: string }
}

/** True only inside the Electrobun app. */
export function zooAvailable(): boolean {
  return nativeRpcAvailable()
}

// ---- validation -----------------------------------------------------------

function obj(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

const BACKFILL_STATES = new Set(["idle", "running", "done", "error"])
const PASS_STATES = new Set(["running", "done", "error"])
const SOURCE_KINDS = new Set<string>(["linear", "transcripts"])
const IDEA_TYPE_SET = new Set<string>(IDEA_TYPES)
const IDEA_STATUSES = new Set<string>(["proposed", "promoted", "dismissed"])
const ITEM_STAGE_SET = new Set<string>(ITEM_STAGES)

function parseSource(value: unknown): ZooSource | null {
  const row = obj(value)
  if (!row) return null
  const id = str(row.id)
  const label = str(row.label)
  const createdAt = num(row.createdAt)
  const backfill = obj(row.backfill)
  const kind = str(row.kind)
  if (!id || !label || createdAt === null || !kind || !SOURCE_KINDS.has(kind) || !backfill) return null
  const state = str(backfill.state)
  const fetched = num(backfill.fetched)
  if (!state || !BACKFILL_STATES.has(state) || fetched === null) return null
  const error = str(backfill.error)
  const completedAt = num(backfill.completedAt)
  return {
    id,
    kind: kind as ZooSource["kind"],
    label,
    createdAt,
    backfill: {
      state: state as ZooSource["backfill"]["state"],
      fetched,
      ...(error ? { error } : {}),
      ...(completedAt !== null ? { completedAt } : {}),
    },
  }
}

function parseArtifact(value: unknown): ZooArtifactMeta | null {
  const row = obj(value)
  if (!row) return null
  const id = str(row.id)
  const sourceId = str(row.sourceId)
  const kind = str(row.kind)
  const externalId = str(row.externalId)
  const title = str(row.title)
  const fetchedAt = num(row.fetchedAt)
  if (!id || !sourceId || !kind || !externalId || !title || fetchedAt === null) return null
  const url = str(row.url)
  return { id, sourceId, kind, externalId, title, ...(url ? { url } : {}), fetchedAt }
}

function parseEvidence(value: unknown): ZooEvidence | null {
  const row = obj(value)
  if (!row) return null
  const artifactId = str(row.artifactId)
  const quote = str(row.quote)
  return artifactId && quote ? { artifactId, quote } : null
}

function parseInsight(value: unknown): ZooInsight | null {
  const row = obj(value)
  if (!row) return null
  const id = str(row.id)
  const passId = str(row.passId)
  const title = str(row.title)
  const summary = str(row.summary)
  const createdAt = num(row.createdAt)
  if (!id || !passId || !title || !summary || createdAt === null) return null
  if (!Array.isArray(row.evidence)) return null
  const evidence: ZooEvidence[] = []
  for (const item of row.evidence) {
    const parsed = parseEvidence(item)
    if (!parsed) return null
    evidence.push(parsed)
  }
  const priority = num(row.priority)
  return {
    id,
    passId,
    title,
    summary,
    ...(priority !== null ? { priority } : {}),
    evidence,
    createdAt,
  }
}

function parsePass(value: unknown): ZooPass | null {
  const row = obj(value)
  if (!row) return null
  const id = str(row.id)
  const startedAt = num(row.startedAt)
  const status = str(row.status)
  if (!id || startedAt === null || !status || !PASS_STATES.has(status)) return null
  const note = str(row.note)
  return {
    id,
    startedAt,
    status: status as ZooPass["status"],
    ...(note ? { note } : {}),
  }
}

function parseIdea(value: unknown): ZooIdea | null {
  const row = obj(value)
  if (!row) return null
  const id = str(row.id)
  const type = str(row.type)
  const title = str(row.title)
  const rationale = str(row.rationale)
  const status = str(row.status)
  const createdAt = num(row.createdAt)
  if (!id || !type || !IDEA_TYPE_SET.has(type)) return null
  if (!title || !rationale || !status || !IDEA_STATUSES.has(status) || createdAt === null) return null
  if (!Array.isArray(row.insightIds)) return null
  const insightIds: string[] = []
  for (const item of row.insightIds) {
    const insightId = str(item)
    if (!insightId) return null
    insightIds.push(insightId)
  }
  const itemId = str(row.itemId)
  return {
    id,
    type: type as ZooIdeaType,
    title,
    rationale,
    status: status as ZooIdeaStatus,
    insightIds,
    createdAt,
    ...(itemId ? { itemId } : {}),
  }
}

function parseDecision(value: unknown): ZooDecision | null {
  const row = obj(value)
  if (!row) return null
  const at = num(row.at)
  const note = str(row.note)
  const actor = row.actor
  if (at === null || !note || (actor !== "user" && actor !== "agent")) return null
  return { at, actor, note }
}

function parseItem(value: unknown): ZooItem | null {
  const row = obj(value)
  if (!row) return null
  const id = str(row.id)
  const ideaId = str(row.ideaId)
  const title = str(row.title)
  const stage = str(row.stage)
  const createdAt = num(row.createdAt)
  const updatedAt = num(row.updatedAt)
  if (!id || !ideaId || !title || !stage || !ITEM_STAGE_SET.has(stage)) return null
  if (createdAt === null || updatedAt === null) return null
  if (!Array.isArray(row.sessionIds) || !Array.isArray(row.decisions)) return null
  const sessionIds: string[] = []
  for (const item of row.sessionIds) {
    const sessionId = str(item)
    if (!sessionId) return null
    sessionIds.push(sessionId)
  }
  const decisions: ZooDecision[] = []
  for (const item of row.decisions) {
    const decision = parseDecision(item)
    if (!decision) return null
    decisions.push(decision)
  }
  return {
    id,
    ideaId,
    title,
    stage: stage as ZooItemStage,
    sessionIds,
    decisions,
    createdAt,
    updatedAt,
  }
}

/** Collect a homogeneous list, rejecting the whole response on any bad entry. */
function parseList<T>(value: unknown, parse: (item: unknown) => T | null): T[] | null {
  if (!Array.isArray(value)) return null
  const out: T[] = []
  for (const item of value) {
    const parsed = parse(item)
    if (!parsed) return null
    out.push(parsed)
  }
  return out
}

function malformed(): ZooFailure {
  return { ok: false, error: "The Factory host returned a malformed response." }
}

/**
 * Unwrap the shared `{ ok: true, … } | { ok: false, error }` envelope. Returns
 * the failure to pass through, or null when the body is a usable success.
 */
function envelope(raw: unknown): { body: Record<string, unknown> | null; failure: ZooFailure | null } {
  const body = obj(raw)
  if (!body) return { body: null, failure: malformed() }
  if (body.ok === false) {
    const error = str(body.error)
    return { body: null, failure: { ok: false, error: error ?? "The Factory request failed." } }
  }
  if (body.ok !== true) return { body: null, failure: malformed() }
  return { body, failure: null }
}

// Exported for tests: each parser owns one RPC response shape.

export function parseStatusResponse(raw: unknown): ZooResult<ZooStatus> {
  const { body, failure } = envelope(raw)
  if (!body) return failure ?? malformed()
  const sources = parseList(body.sources, parseSource)
  const passes = parseList(body.passes, parsePass)
  const artifactCount = num(body.artifactCount)
  const insightCount = num(body.insightCount)
  const ideaCount = num(body.ideaCount)
  const itemCount = num(body.itemCount)
  if (!sources || !passes || artifactCount === null || insightCount === null) return malformed()
  if (ideaCount === null || itemCount === null) return malformed()
  return { ok: true, sources, artifactCount, insightCount, ideaCount, itemCount, passes }
}

export function parseSourceResponse(raw: unknown): ZooResult<{ source: ZooSource }> {
  const { body, failure } = envelope(raw)
  if (!body) return failure ?? malformed()
  const source = parseSource(body.source)
  return source ? { ok: true, source } : malformed()
}

export function parseOkResponse(raw: unknown): ZooResult<Record<never, never>> {
  const { body, failure } = envelope(raw)
  if (!body) return failure ?? malformed()
  return { ok: true }
}

export function parseArtifactsResponse(
  raw: unknown,
): ZooResult<{ artifacts: ZooArtifactMeta[]; total: number }> {
  const { body, failure } = envelope(raw)
  if (!body) return failure ?? malformed()
  const artifacts = parseList(body.artifacts, parseArtifact)
  const total = num(body.total)
  if (!artifacts || total === null) return malformed()
  return { ok: true, artifacts, total }
}

export function parseArtifactResponse(raw: unknown): ZooResult<{ artifact: ZooArtifactDetail }> {
  const { body, failure } = envelope(raw)
  if (!body) return failure ?? malformed()
  const meta = parseArtifact(body.artifact)
  const content = obj(body.artifact)?.content
  if (!meta || typeof content !== "string") return malformed()
  return { ok: true, artifact: { ...meta, content } }
}

export function parseExportResponse(raw: unknown): ZooResult<{ passId: string; bundle: string }> {
  const { body, failure } = envelope(raw)
  if (!body) return failure ?? malformed()
  const passId = str(body.passId)
  const bundle = body.bundle
  if (!passId || typeof bundle !== "string" || !bundle.trim()) return malformed()
  return { ok: true, passId, bundle }
}

export function parseRecordResponse(raw: unknown): ZooResult<{ insightCount: number }> {
  const { body, failure } = envelope(raw)
  if (!body) return failure ?? malformed()
  const insightCount = num(body.insightCount)
  return insightCount === null ? malformed() : { ok: true, insightCount }
}

export function parseInsightsResponse(raw: unknown): ZooResult<{ insights: ZooInsight[] }> {
  const { body, failure } = envelope(raw)
  if (!body) return failure ?? malformed()
  const insights = parseList(body.insights, parseInsight)
  return insights ? { ok: true, insights } : malformed()
}

export function parseRecordIdeasResponse(raw: unknown): ZooResult<{ ideaCount: number }> {
  const { body, failure } = envelope(raw)
  if (!body) return failure ?? malformed()
  const ideaCount = num(body.ideaCount)
  return ideaCount === null ? malformed() : { ok: true, ideaCount }
}

export function parseIdeasResponse(raw: unknown): ZooResult<{ ideas: ZooIdea[] }> {
  const { body, failure } = envelope(raw)
  if (!body) return failure ?? malformed()
  const ideas = parseList(body.ideas, parseIdea)
  return ideas ? { ok: true, ideas } : malformed()
}

export function parseIdeaResponse(raw: unknown): ZooResult<{ idea: ZooIdea }> {
  const { body, failure } = envelope(raw)
  if (!body) return failure ?? malformed()
  const idea = parseIdea(body.idea)
  return idea ? { ok: true, idea } : malformed()
}

export function parseItemsResponse(raw: unknown): ZooResult<{ items: ZooItem[] }> {
  const { body, failure } = envelope(raw)
  if (!body) return failure ?? malformed()
  const items = parseList(body.items, parseItem)
  return items ? { ok: true, items } : malformed()
}

export function parseItemResponse(raw: unknown): ZooResult<{ item: ZooItem }> {
  const { body, failure } = envelope(raw)
  if (!body) return failure ?? malformed()
  const item = parseItem(body.item)
  return item ? { ok: true, item } : malformed()
}

// ---- RPC ------------------------------------------------------------------

function unavailable(): ZooFailure {
  return { ok: false, error: ZOO_UNAVAILABLE, unavailable: true }
}

async function call<T extends object>(
  method: string,
  params: Record<string, unknown>,
  parse: (raw: unknown) => ZooResult<T>,
): Promise<ZooResult<T>> {
  if (!nativeRpcAvailable()) return unavailable()
  const rpc = await getRpc()
  const fn = rpc?.request?.[method]
  if (!fn) return unavailable()
  try {
    return parse(await fn(params))
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : `${method} failed.` }
  }
}

export function zooStatus(): Promise<ZooResult<ZooStatus>> {
  return call("zooStatus", {}, parseStatusResponse)
}

export function zooConnectLinear(apiKey: string): Promise<ZooResult<{ source: ZooSource }>> {
  return call("zooConnectLinear", { apiKey }, parseSourceResponse)
}

export function zooConnectTranscripts(folder: string): Promise<ZooResult<{ source: ZooSource }>> {
  return call("zooConnectTranscripts", { folder }, parseSourceResponse)
}

export function zooStartBackfill(sourceId: string): Promise<ZooResult<Record<never, never>>> {
  return call("zooStartBackfill", { sourceId }, parseOkResponse)
}

export function zooListArtifacts(
  params: { sourceId?: string; limit?: number; offset?: number } = {},
): Promise<ZooResult<{ artifacts: ZooArtifactMeta[]; total: number }>> {
  return call("zooListArtifacts", { ...params }, parseArtifactsResponse)
}

export function zooGetArtifact(id: string): Promise<ZooResult<{ artifact: ZooArtifactDetail }>> {
  return call("zooGetArtifact", { id }, parseArtifactResponse)
}

export function zooExportForExtraction(
  maxChars?: number,
): Promise<ZooResult<{ passId: string; bundle: string }>> {
  return call(
    "zooExportForExtraction",
    maxChars === undefined ? {} : { maxChars },
    parseExportResponse,
  )
}

export function zooRecordInsights(
  passId: string,
  insights: ZooInsightInput[],
): Promise<ZooResult<{ insightCount: number }>> {
  return call("zooRecordInsights", { passId, insights }, parseRecordResponse)
}

export function zooFailPass(passId: string, error: string): Promise<ZooResult<Record<never, never>>> {
  return call("zooFailPass", { passId, error }, parseOkResponse)
}

export function zooListInsights(): Promise<ZooResult<{ insights: ZooInsight[] }>> {
  return call("zooListInsights", {}, parseInsightsResponse)
}

export function zooExportInsightsForSynthesis(
  maxChars?: number,
): Promise<ZooResult<{ passId: string; bundle: string }>> {
  return call(
    "zooExportInsightsForSynthesis",
    maxChars === undefined ? {} : { maxChars },
    parseExportResponse,
  )
}

export function zooRecordIdeas(
  passId: string,
  ideas: ZooIdeaInput[],
): Promise<ZooResult<{ ideaCount: number }>> {
  return call("zooRecordIdeas", { passId, ideas }, parseRecordIdeasResponse)
}

export function zooListIdeas(): Promise<ZooResult<{ ideas: ZooIdea[] }>> {
  return call("zooListIdeas", {}, parseIdeasResponse)
}

export function zooSetIdeaStatus(
  ideaId: string,
  status: ZooIdeaStatus,
): Promise<ZooResult<{ idea: ZooIdea }>> {
  return call("zooSetIdeaStatus", { ideaId, status }, parseIdeaResponse)
}

export function zooCreateItem(ideaId: string): Promise<ZooResult<{ item: ZooItem }>> {
  return call("zooCreateItem", { ideaId }, parseItemResponse)
}

export function zooUpdateItem(
  itemId: string,
  update: ZooItemUpdate,
): Promise<ZooResult<{ item: ZooItem }>> {
  return call("zooUpdateItem", { itemId, ...update }, parseItemResponse)
}

export function zooListItems(): Promise<ZooResult<{ items: ZooItem[] }>> {
  return call("zooListItems", {}, parseItemsResponse)
}
