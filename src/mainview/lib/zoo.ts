// Webview bridge for the product-factory ("zoo") store that lives in the Bun
// process. Mirrors lib/dirSearch.ts / lib/terminal.ts: RPC only (never a bun:*
// or node builtin import), every response validated before it is handed to the
// UI, and a clear `unavailable` answer in the plain-browser build so the
// Factory can render a "requires the desktop app" state instead of fake data.

import { getRpc, nativeRpcAvailable } from "./rpc"
import type {
  ZooArea,
  ZooAreaKind,
  ZooRepoWatch,
  ZooWatchResult,
  ZooXWatch,
  ZooXWatchResult,
  ZooArtifactMeta,
  ZooDecision,
  ZooEvidence,
  ZooIdea,
  ZooIdeaDecision,
  ZooJamSession,
  ZooIdeaStatus,
  ZooIdeaType,
  ZooInsight,
  ZooItem,
  ZooItemStage,
  ZooPass,
  ZooSource,
} from "../../shared/zooTypes"

export type {
  ZooArea,
  ZooAreaKind,
  ZooRepoWatch,
  ZooSourceKind,
  ZooWatchResult,
  ZooWatchStatus,
  ZooXWatch,
  ZooXWatchResult,
  ZooArtifactMeta,
  ZooBackfillState,
  ZooDecision,
  ZooEvidence,
  ZooIdea,
  ZooIdeaDecision,
  ZooJamSession,
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
const SOURCE_KINDS = new Set<string>(["linear", "transcripts", "repo-watch", "x-watch"])
const IDEA_TYPE_SET = new Set<string>(IDEA_TYPES)
const WATCH_STATUSES = new Set<string>(["ok", "skipped", "error"])
const IDEA_STATUSES = new Set<string>(["proposed", "promoted", "dismissed"])
const ITEM_STAGE_SET = new Set<string>(ITEM_STAGES)

/** areaId is optional everywhere: a row without one is "unassigned", which is
 *  normal for anything stored before areas existed — never a parse failure. */
function areaOf(row: Record<string, unknown>): { areaId?: string } {
  const areaId = str(row.areaId)
  return areaId ? { areaId } : {}
}

function parseArea(value: unknown): ZooArea | null {
  const row = obj(value)
  if (!row) return null
  const id = str(row.id)
  const name = str(row.name)
  const createdAt = num(row.createdAt)
  if (!id || !name || createdAt === null) return null
  if (row.repoPaths !== undefined && !Array.isArray(row.repoPaths)) return null
  const repoPaths: string[] = []
  for (const entry of Array.isArray(row.repoPaths) ? row.repoPaths : []) {
    const path = str(entry)
    if (!path) return null
    repoPaths.push(path)
  }
  return { id, name, ...(repoPaths.length ? { repoPaths } : {}), createdAt }
}

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
    ...areaOf(row),
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
  if (row.sourceLabels !== undefined && !Array.isArray(row.sourceLabels)) return null
  const sourceLabels: string[] = []
  for (const entry of Array.isArray(row.sourceLabels) ? row.sourceLabels : []) {
    const label = str(entry)
    if (!label) return null
    sourceLabels.push(label)
  }
  const priority = num(row.priority)
  return {
    id,
    passId,
    title,
    summary,
    ...(priority !== null ? { priority } : {}),
    evidence,
    ...(sourceLabels.length ? { sourceLabels } : {}),
    ...areaOf(row),
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
  const jamSessions = parseList(row.jamSessions ?? [], parseJamSession)
  const decisions = parseList(row.decisions ?? [], parseIdeaDecision)
  if (!jamSessions || !decisions) return null
  return {
    id,
    type: type as ZooIdeaType,
    title,
    rationale,
    status: status as ZooIdeaStatus,
    insightIds,
    jamSessions,
    decisions,
    ...areaOf(row),
    createdAt,
    ...(itemId ? { itemId } : {}),
  }
}

function parseJamSession(value: unknown): ZooJamSession | null {
  const row = obj(value); if (!row) return null
  const sessionId = str(row.sessionId); const createdAt = num(row.createdAt); const outcomeAt = num(row.outcomeAt)
  if (!sessionId || createdAt === null || (row.outcomeAt !== undefined && outcomeAt === null)) return null
  return { sessionId, createdAt, ...(outcomeAt !== null ? { outcomeAt } : {}) }
}

function parseIdeaDecision(value: unknown): ZooIdeaDecision | null {
  const row = obj(value); if (!row) return null
  const at = num(row.at); const note = str(row.note); const actor = row.actor; const sessionId = str(row.sessionId)
  if (at === null || !note || (actor !== "user" && actor !== "agent")) return null
  return { at, actor, note, ...(sessionId ? { sessionId } : {}) }
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
  const jamSessions = parseList(row.jamSessions ?? [], parseJamSession)
  if (!jamSessions) return null
  return {
    id,
    ideaId,
    title,
    stage: stage as ZooItemStage,
    sessionIds,
    jamSessions,
    decisions,
    ...areaOf(row),
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

function parseWatch(value: unknown): ZooRepoWatch | null {
  const row = obj(value)
  if (!row) return null
  const id = str(row.id)
  const sourceId = str(row.sourceId)
  const owner = str(row.owner)
  const name = str(row.name)
  const label = str(row.label)
  const createdAt = num(row.createdAt)
  if (!id || !sourceId || !owner || !name || !label || createdAt === null) return null
  const status = str(row.lastStatus)
  if (row.lastStatus !== undefined && (!status || !WATCH_STATUSES.has(status))) return null
  const areaId = str(row.areaId)
  const lastCheckAt = num(row.lastCheckAt)
  const lastArtifactAt = num(row.lastArtifactAt)
  const lastExtractAt = num(row.lastExtractAt)
  const lastNote = str(row.lastNote)
  return {
    id,
    sourceId,
    owner,
    name,
    label,
    ...(areaId ? { areaId } : {}),
    ...(lastCheckAt !== null ? { lastCheckAt } : {}),
    ...(status ? { lastStatus: status as ZooRepoWatch["lastStatus"] } : {}),
    ...(lastNote ? { lastNote } : {}),
    ...(lastArtifactAt !== null ? { lastArtifactAt } : {}),
    ...(lastExtractAt !== null ? { lastExtractAt } : {}),
    createdAt,
  }
}

function parseWatchResult(value: unknown): ZooWatchResult | null {
  const row = obj(value)
  if (!row) return null
  const watchId = str(row.watchId)
  const label = str(row.label)
  const status = str(row.status)
  const added = num(row.added)
  if (!watchId || !label || !status || !WATCH_STATUSES.has(status) || added === null) return null
  const note = str(row.note)
  return { watchId, label, status: status as ZooWatchResult["status"], added, ...(note ? { note } : {}) }
}

function parseXWatch(value: unknown): ZooXWatch | null {
  const row = obj(value); if (!row) return null
  const id = str(row.id); const sourceId = str(row.sourceId); const handle = str(row.handle); const label = str(row.label); const createdAt = num(row.createdAt)
  if (!id || !sourceId || !handle || !label || createdAt === null) return null
  const status = str(row.lastStatus); if (row.lastStatus !== undefined && (!status || !WATCH_STATUSES.has(status))) return null
  const optional = (key: string) => num(row[key])
  return { id, sourceId, handle, label, ...areaOf(row), ...(optional("lastSuccessAt") !== null ? { lastSuccessAt: optional("lastSuccessAt")! } : {}), ...(optional("lastAttemptAt") !== null ? { lastAttemptAt: optional("lastAttemptAt")! } : {}), ...(status ? { lastStatus: status as ZooXWatch["lastStatus"] } : {}), ...(str(row.lastNote) ? { lastNote: str(row.lastNote)! } : {}), ...(optional("lastArtifactAt") !== null ? { lastArtifactAt: optional("lastArtifactAt")! } : {}), ...(optional("lastExtractAt") !== null ? { lastExtractAt: optional("lastExtractAt")! } : {}), createdAt }
}

function parseXWatchResult(value: unknown): ZooXWatchResult | null {
  const row = obj(value); if (!row) return null
  const watchId = str(row.watchId); const label = str(row.label); const status = str(row.status); const added = num(row.added)
  if (!watchId || !label || (status !== "ok" && status !== "error") || added === null) return null
  return { watchId, label, status, added, ...(str(row.note) ? { note: str(row.note)! } : {}) }
}

export function parseXWatchesResponse(raw: unknown): ZooResult<{ watches: ZooXWatch[]; intervalMinutes: number; lastSuccessAt: number | null }> {
  const { body, failure } = envelope(raw); if (!body) return failure ?? malformed()
  const watches = parseList(body.watches, parseXWatch); const intervalMinutes = num(body.intervalMinutes); if (!watches || intervalMinutes === null) return malformed()
  return { ok: true, watches, intervalMinutes, lastSuccessAt: num(body.lastSuccessAt) }
}
export function parseXWatchResponse(raw: unknown): ZooResult<{ watch: ZooXWatch }> { const { body, failure } = envelope(raw); if (!body) return failure ?? malformed(); const watch = parseXWatch(body.watch); return watch ? { ok: true, watch } : malformed() }
export function parseXWatchCheckResponse(raw: unknown): ZooResult<{ results: ZooXWatchResult[]; checkedAt: number; succeeded: boolean }> { const { body, failure } = envelope(raw); if (!body) return failure ?? malformed(); const results = parseList(body.results, parseXWatchResult); const checkedAt = num(body.checkedAt); if (!results || checkedAt === null || typeof body.succeeded !== "boolean") return malformed(); return { ok: true, results, checkedAt, succeeded: body.succeeded } }
export function parseXWatchScheduleResponse(raw: unknown): ZooResult<{ intervalMinutes: number }> { const { body, failure } = envelope(raw); if (!body) return failure ?? malformed(); const intervalMinutes = num(body.intervalMinutes); return intervalMinutes === null ? malformed() : { ok: true, intervalMinutes } }
export function parseXWatchStateResponse(raw: unknown): ZooResult<{ intervalMinutes: number; lastSuccessAt: number | null; watchCount: number }> { const { body, failure } = envelope(raw); if (!body) return failure ?? malformed(); const intervalMinutes = num(body.intervalMinutes); const watchCount = num(body.watchCount); if (intervalMinutes === null || watchCount === null) return malformed(); return { ok: true, intervalMinutes, lastSuccessAt: num(body.lastSuccessAt), watchCount } }

export function parseWatchesResponse(
  raw: unknown,
): ZooResult<{ watches: ZooRepoWatch[]; hour: number; lastRunAt: number | null }> {
  const { body, failure } = envelope(raw)
  if (!body) return failure ?? malformed()
  const watches = parseList(body.watches, parseWatch)
  const hour = num(body.hour)
  if (!watches || hour === null) return malformed()
  const lastRunAt = num(body.lastRunAt)
  return { ok: true, watches, hour, lastRunAt }
}

export function parseWatchResponse(raw: unknown): ZooResult<{ watch: ZooRepoWatch }> {
  const { body, failure } = envelope(raw)
  if (!body) return failure ?? malformed()
  const watch = parseWatch(body.watch)
  return watch ? { ok: true, watch } : malformed()
}

export function parseWatchCheckResponse(
  raw: unknown,
): ZooResult<{ results: ZooWatchResult[]; checkedAt: number }> {
  const { body, failure } = envelope(raw)
  if (!body) return failure ?? malformed()
  const results = parseList(body.results, parseWatchResult)
  const checkedAt = num(body.checkedAt)
  if (!results || checkedAt === null) return malformed()
  return { ok: true, results, checkedAt }
}

export function parseWatchScheduleResponse(raw: unknown): ZooResult<{ hour: number }> {
  const { body, failure } = envelope(raw)
  if (!body) return failure ?? malformed()
  const hour = num(body.hour)
  return hour === null ? malformed() : { ok: true, hour }
}

export function parseAreasResponse(raw: unknown): ZooResult<{ areas: ZooArea[] }> {
  const { body, failure } = envelope(raw)
  if (!body) return failure ?? malformed()
  const areas = parseList(body.areas, parseArea)
  return areas ? { ok: true, areas } : malformed()
}

export function parseAreaResponse(raw: unknown): ZooResult<{ area: ZooArea }> {
  const { body, failure } = envelope(raw)
  if (!body) return failure ?? malformed()
  const area = parseArea(body.area)
  return area ? { ok: true, area } : malformed()
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
  // A source/time-scoped watch export can legitimately have no new artifacts;
  // runExtraction closes that pass by recording zero insights.
  if (!passId || typeof bundle !== "string") return malformed()
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

export function zooListAreas(): Promise<ZooResult<{ areas: ZooArea[] }>> {
  return call("zooListAreas", {}, parseAreasResponse)
}

export function zooCreateArea(
  name: string,
  repoPaths: string[] = [],
): Promise<ZooResult<{ area: ZooArea }>> {
  return call("zooCreateArea", { name, repoPaths }, parseAreaResponse)
}

export function zooUpdateArea(
  areaId: string,
  update: { name?: string; repoPaths?: string[] },
): Promise<ZooResult<{ area: ZooArea }>> {
  return call("zooUpdateArea", { areaId, ...update }, parseAreaResponse)
}

/** Deleting an area unassigns its rows; board data is never removed with it. */
export function zooDeleteArea(areaId: string): Promise<ZooResult<Record<never, never>>> {
  return call("zooDeleteArea", { areaId }, parseOkResponse)
}

/** Move one row to an area, or to no area at all (`null` = unassigned). */
export function zooAssignArea(
  kind: ZooAreaKind,
  id: string,
  areaId: string | null,
): Promise<ZooResult<Record<never, never>>> {
  return call("zooAssignArea", { kind, id, areaId }, parseOkResponse)
}

// ---- competitor watch -----------------------------------------------------
// Every GitHub call happens in the Bun process; these are only the RPC edges.

export function zooListRepoWatches(): Promise<
  ZooResult<{ watches: ZooRepoWatch[]; hour: number; lastRunAt: number | null }>
> {
  return call("zooListRepoWatches", {}, parseWatchesResponse)
}

/** `repo` is "owner/name" or a GitHub URL; the Bun side is the validator. */
export function zooAddRepoWatch(
  repo: string,
  areaId?: string | null,
): Promise<ZooResult<{ watch: ZooRepoWatch }>> {
  return call("zooAddRepoWatch", { repo, ...(areaId ? { areaId } : {}) }, parseWatchResponse)
}

export function zooRemoveRepoWatch(watchId: string): Promise<ZooResult<Record<never, never>>> {
  return call("zooRemoveRepoWatch", { watchId }, parseOkResponse)
}

export function zooSetWatchSchedule(hour: number): Promise<ZooResult<{ hour: number }>> {
  return call("zooSetWatchSchedule", { hour }, parseWatchScheduleResponse)
}

/** Check one watch, or every watch when no id is given. */
export function zooCheckRepoWatches(
  watchId?: string | null,
): Promise<ZooResult<{ results: ZooWatchResult[]; checkedAt: number }>> {
  return call("zooCheckRepoWatches", watchId ? { watchId } : {}, parseWatchCheckResponse)
}

/** Records that the extraction pass has read this watch's new artifacts. */
export function zooMarkWatchExtracted(watchId: string): Promise<ZooResult<Record<never, never>>> {
  return call("zooMarkWatchExtracted", { watchId }, parseOkResponse)
}

export function zooListXWatches() { return call("zooListXWatches", {}, parseXWatchesResponse) }
export function zooAddXWatch(handle: string, areaId?: string | null) { return call("zooAddXWatch", { handle, ...(areaId ? { areaId } : {}) }, parseXWatchResponse) }
export function zooRemoveXWatch(watchId: string) { return call("zooRemoveXWatch", { watchId }, parseOkResponse) }
export function zooSetXWatchSchedule(intervalMinutes: number) { return call("zooSetXWatchSchedule", { intervalMinutes }, parseXWatchScheduleResponse) }
export function zooCheckXWatches(watchId?: string | null) { return call("zooCheckXWatches", watchId ? { watchId } : {}, parseXWatchCheckResponse) }
export function zooMarkXWatchExtracted(watchId: string) { return call("zooMarkXWatchExtracted", { watchId }, parseOkResponse) }
export function zooXWatchState() { return call("zooXWatchState", {}, parseXWatchStateResponse) }

export function zooConnectLinear(
  apiKey: string,
  areaId?: string | null,
): Promise<ZooResult<{ source: ZooSource }>> {
  return call("zooConnectLinear", { apiKey, ...(areaId ? { areaId } : {}) }, parseSourceResponse)
}

export function zooConnectTranscripts(
  folder: string,
  areaId?: string | null,
): Promise<ZooResult<{ source: ZooSource }>> {
  return call("zooConnectTranscripts", { folder, ...(areaId ? { areaId } : {}) }, parseSourceResponse)
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
  areaId?: string | null,
  /** Narrow the bundle to one source and/or to artifacts newer than a moment. */
  scope: { sourceId?: string; sinceFetchedAt?: number } = {},
): Promise<ZooResult<{ passId: string; bundle: string }>> {
  return call(
    "zooExportForExtraction",
    {
      ...(maxChars === undefined ? {} : { maxChars }),
      ...(areaId ? { areaId } : {}),
      ...(scope.sourceId ? { sourceId: scope.sourceId } : {}),
      ...(typeof scope.sinceFetchedAt === "number" ? { sinceFetchedAt: scope.sinceFetchedAt } : {}),
    },
    parseExportResponse,
  )
}

export function zooRecordInsights(
  passId: string,
  insights: ZooInsightInput[],
  areaId?: string | null,
): Promise<ZooResult<{ insightCount: number }>> {
  return call("zooRecordInsights", { passId, insights, ...(areaId ? { areaId } : {}) }, parseRecordResponse)
}

export function zooFailPass(passId: string, error: string): Promise<ZooResult<Record<never, never>>> {
  return call("zooFailPass", { passId, error }, parseOkResponse)
}

export function zooListInsights(): Promise<ZooResult<{ insights: ZooInsight[] }>> {
  return call("zooListInsights", {}, parseInsightsResponse)
}

export function zooExportInsightsForSynthesis(
  maxChars?: number,
  areaId?: string | null,
): Promise<ZooResult<{ passId: string; bundle: string }>> {
  return call(
    "zooExportInsightsForSynthesis",
    { ...(maxChars === undefined ? {} : { maxChars }), ...(areaId ? { areaId } : {}) },
    parseExportResponse,
  )
}

export function zooRecordIdeas(
  passId: string,
  ideas: ZooIdeaInput[],
  areaId?: string | null,
): Promise<ZooResult<{ ideaCount: number }>> {
  return call("zooRecordIdeas", { passId, ideas, ...(areaId ? { areaId } : {}) }, parseRecordIdeasResponse)
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

export function zooRecordJamSession(target: "idea" | "item", targetId: string, sessionId: string): Promise<ZooResult<{ target: "idea" | "item"; idea?: ZooIdea; item?: ZooItem }>> {
  return call("zooRecordJamSession", { target, targetId, sessionId }, (raw) => {
    const { body, failure } = envelope(raw); if (!body) return failure ?? malformed()
    if (body.target !== "idea" && body.target !== "item") return malformed()
    const idea = body.idea === undefined ? null : parseIdea(body.idea); const item = body.item === undefined ? null : parseItem(body.item)
    if ((body.target === "idea" && !idea) || (body.target === "item" && !item)) return malformed()
    return { ok: true, target: body.target, ...(idea ? { idea } : {}), ...(item ? { item } : {}) }
  })
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
