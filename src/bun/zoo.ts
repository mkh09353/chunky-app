// Product-factory persistence and connectors. This module performs only
// deterministic fetch/store work; model synthesis is performed outside Zoo.
import { createHash, randomUUID } from "node:crypto"
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs"
import { basename, dirname, join, relative, resolve } from "node:path"
import { Database } from "bun:sqlite"
import { stateDir } from "./connectionManager"
import type { ZooArtifactMeta, ZooDecision, ZooEvidence, ZooIdea, ZooIdeaStatus, ZooIdeaType, ZooInsight, ZooItem, ZooItemStage, ZooPass, ZooSource } from "../shared/zooTypes"

const LINEAR_URL = "https://api.linear.app/graphql"
const DEFAULT_EXPORT_CHARS = 150_000
const MAX_EXPORT_CHARS = 1_000_000
const MAX_TRANSCRIPT_BYTES = 1_000_000
const MAX_TRANSCRIPT_FILES = 2_000
const IDEA_TYPES = new Set<ZooIdeaType>(["close", "investigate", "build", "needs-detail"])
const IDEA_STATUSES = new Set<ZooIdeaStatus>(["proposed", "promoted", "dismissed"])
const ITEM_STAGES = new Set<ZooItemStage>(["research", "decision", "building", "review", "shipped", "dropped"])

type Row = Record<string, unknown>
type Result<T extends object> = ({ ok: true } & T) | { ok: false; error: string }
type ZooDependencies = { dbPath?: string; fetch?: typeof fetch }
type LinearIssue = { identifier: string; title: string; url?: string | null }

function object(value: unknown): Record<string, unknown> | null { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null }
function emptyObject(value: unknown): boolean { const body = object(value); return body !== null && Object.keys(body).length === 0 }
function text(value: unknown, max = 20_000): string | null { return typeof value === "string" && value.trim() && value.length <= max && !value.includes("\0") ? value.trim() : null }
function number(value: unknown, fallback: number, cap: number): number { const n = typeof value === "number" ? value : Number(value); return Number.isFinite(n) ? Math.max(0, Math.min(Math.floor(n), cap)) : fallback }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : "Unexpected zoo error" }
function hash(value: string): string { return createHash("sha256").update(value).digest("hex") }

export function createZooManager(deps: ZooDependencies = {}) {
  const dbPath = deps.dbPath || join(stateDir(process.env), "zoo.db")
  const request = deps.fetch || fetch
  let db: Database | undefined
  const activeBackfills = new Set<string>()

  const database = () => {
    if (db) return db
    mkdirSync(dirname(dbPath), { recursive: true })
    db = new Database(dbPath)
    db.run("PRAGMA journal_mode = WAL"); db.run("PRAGMA foreign_keys = ON")
    // api_key is unused for transcripts; folder is unused for Linear. They are
    // nullable additions that keep existing zoo.db installations compatible.
    db.run("CREATE TABLE IF NOT EXISTS sources (id TEXT PRIMARY KEY, kind TEXT NOT NULL, label TEXT NOT NULL, api_key TEXT NOT NULL, created_at INTEGER NOT NULL, backfill_state TEXT NOT NULL, backfill_fetched INTEGER NOT NULL DEFAULT 0, backfill_error TEXT, backfill_completed_at INTEGER)")
    try { db.run("ALTER TABLE sources ADD COLUMN folder TEXT") } catch {}
    db.run("CREATE UNIQUE INDEX IF NOT EXISTS sources_transcript_folder ON sources(folder) WHERE kind = 'transcripts'")
    db.run("CREATE TABLE IF NOT EXISTS artifacts (id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES sources(id), kind TEXT NOT NULL, external_id TEXT NOT NULL, title TEXT NOT NULL, url TEXT, content TEXT NOT NULL, content_hash TEXT NOT NULL, fetched_at INTEGER NOT NULL, UNIQUE(source_id, external_id, content_hash))")
    db.run("CREATE INDEX IF NOT EXISTS artifacts_latest ON artifacts(source_id, external_id, fetched_at DESC)")
    db.run("CREATE TABLE IF NOT EXISTS passes (id TEXT PRIMARY KEY, started_at INTEGER NOT NULL, status TEXT NOT NULL, note TEXT)")
    db.run("CREATE TABLE IF NOT EXISTS insights (id TEXT PRIMARY KEY, pass_id TEXT NOT NULL REFERENCES passes(id), title TEXT NOT NULL, summary TEXT NOT NULL, priority INTEGER, created_at INTEGER NOT NULL)")
    db.run("CREATE TABLE IF NOT EXISTS evidence (insight_id TEXT NOT NULL REFERENCES insights(id), artifact_id TEXT NOT NULL REFERENCES artifacts(id), quote TEXT NOT NULL, PRIMARY KEY(insight_id, artifact_id, quote))")
    db.run("CREATE TABLE IF NOT EXISTS ideas (id TEXT PRIMARY KEY, pass_id TEXT REFERENCES passes(id), type TEXT NOT NULL, title TEXT NOT NULL, rationale TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL, item_id TEXT, dismiss_reason TEXT)")
    try { db.run("ALTER TABLE ideas ADD COLUMN dismiss_reason TEXT") } catch {}
    // SQLite cannot drop NOT NULL in place. Rebuild databases made by the
    // original schema so agent-created ideas can have no processing pass.
    const passColumn = db.query("PRAGMA table_info(ideas)").all().find((column: any) => column.name === "pass_id") as { notnull?: number } | undefined
    if (passColumn?.notnull) {
      db.run("PRAGMA foreign_keys = OFF")
      try {
        db.run("CREATE TABLE ideas_migrated (id TEXT PRIMARY KEY, pass_id TEXT REFERENCES passes(id), type TEXT NOT NULL, title TEXT NOT NULL, rationale TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL, item_id TEXT, dismiss_reason TEXT)")
        db.run("INSERT INTO ideas_migrated (id, pass_id, type, title, rationale, status, created_at, item_id, dismiss_reason) SELECT id, pass_id, type, title, rationale, status, created_at, item_id, dismiss_reason FROM ideas")
        db.run("DROP TABLE ideas"); db.run("ALTER TABLE ideas_migrated RENAME TO ideas")
      } finally { db.run("PRAGMA foreign_keys = ON") }
    }
    db.run("CREATE TABLE IF NOT EXISTS idea_insights (idea_id TEXT NOT NULL REFERENCES ideas(id), insight_id TEXT NOT NULL REFERENCES insights(id), PRIMARY KEY(idea_id, insight_id))")
    db.run("CREATE TABLE IF NOT EXISTS items (id TEXT PRIMARY KEY, idea_id TEXT NOT NULL UNIQUE REFERENCES ideas(id), title TEXT NOT NULL, stage TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)")
    db.run("CREATE TABLE IF NOT EXISTS item_sessions (item_id TEXT NOT NULL REFERENCES items(id), session_id TEXT NOT NULL, PRIMARY KEY(item_id, session_id))")
    db.run("CREATE TABLE IF NOT EXISTS item_decisions (id TEXT PRIMARY KEY, item_id TEXT NOT NULL REFERENCES items(id), at INTEGER NOT NULL, actor TEXT NOT NULL, note TEXT NOT NULL)")
    return db
  }
  const rows = (sql: string, ...args: unknown[]): Row[] => database().query(sql).all(...args) as Row[]
  const one = (sql: string, ...args: unknown[]): Row | undefined => database().query(sql).get(...args) as Row | undefined
  const run = (sql: string, ...args: unknown[]) => database().query(sql).run(...args)
  const sourceFrom = (row: Row): ZooSource => ({ id: String(row.id), kind: row.kind === "transcripts" ? "transcripts" : "linear", label: String(row.label), createdAt: Number(row.created_at), backfill: { state: row.backfill_state as ZooSource["backfill"]["state"], fetched: Number(row.backfill_fetched), ...(typeof row.backfill_error === "string" && row.backfill_error ? { error: row.backfill_error } : {}), ...(typeof row.backfill_completed_at === "number" ? { completedAt: row.backfill_completed_at } : {}) } })
  const artifactFrom = (row: Row): ZooArtifactMeta => ({ id: String(row.id), sourceId: String(row.source_id), kind: String(row.kind), externalId: String(row.external_id), title: String(row.title), ...(typeof row.url === "string" && row.url ? { url: row.url } : {}), fetchedAt: Number(row.fetched_at) })
  const latestArtifacts = (sourceId?: string) => rows(`SELECT a.* FROM artifacts a WHERE ${sourceId ? "a.source_id = ? AND" : ""} NOT EXISTS (SELECT 1 FROM artifacts n WHERE n.source_id = a.source_id AND n.external_id = a.external_id AND (n.fetched_at > a.fetched_at OR (n.fetched_at = a.fetched_at AND n.rowid > a.rowid)))`, ...(sourceId ? [sourceId] : []))
  const count = (table: string) => Number(one(`SELECT COUNT(*) AS count FROM ${table}`)?.count || 0)
  const pass = (): string => { const id = randomUUID(); run("INSERT INTO passes (id, started_at, status) VALUES (?, ?, 'running')", id, Date.now()); return id }
  const insertArtifact = (sourceId: string, kind: string, externalId: string, title: string, content: string, url?: string) => {
    const contentHash = hash(content)
    if (!one("SELECT id FROM artifacts WHERE source_id = ? AND external_id = ? AND content_hash = ?", sourceId, externalId, contentHash)) run("INSERT INTO artifacts (id, source_id, kind, external_id, title, url, content, content_hash, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", randomUUID(), sourceId, kind, externalId, title, url || null, content, contentHash, Date.now())
  }
  const insightIds = (ideaId: string) => rows("SELECT insight_id FROM idea_insights WHERE idea_id = ? ORDER BY rowid", ideaId).map((r) => String(r.insight_id))
  const ideaFrom = (row: Row): ZooIdea => ({ id: String(row.id), type: row.type as ZooIdeaType, title: String(row.title), rationale: String(row.rationale), status: row.status as ZooIdeaStatus, insightIds: insightIds(String(row.id)), createdAt: Number(row.created_at), ...(typeof row.item_id === "string" && row.item_id ? { itemId: row.item_id } : {}), ...(typeof row.dismiss_reason === "string" && row.dismiss_reason ? { dismissReason: row.dismiss_reason } : {}) })
  const itemFrom = (row: Row): ZooItem => ({ id: String(row.id), ideaId: String(row.idea_id), title: String(row.title), stage: row.stage as ZooItemStage, sessionIds: rows("SELECT session_id FROM item_sessions WHERE item_id = ? ORDER BY rowid", row.id).map((r) => String(r.session_id)), decisions: rows("SELECT at, actor, note FROM item_decisions WHERE item_id = ? ORDER BY at, rowid", row.id).map((r): ZooDecision => ({ at: Number(r.at), actor: r.actor as ZooDecision["actor"], note: String(r.note) })), createdAt: Number(row.created_at), updatedAt: Number(row.updated_at) })

  async function gql(key: string, query: string, variables?: Record<string, unknown>): Promise<Record<string, unknown>> {
    const response = await request(LINEAR_URL, { method: "POST", headers: { Authorization: key, "Content-Type": "application/json" }, body: JSON.stringify({ query, variables }) })
    const body = await response.json().catch(() => ({})) as { data?: Record<string, unknown>; errors?: { message?: unknown }[] }
    if (!response.ok) throw new Error(`Linear request failed (${response.status})`)
    if (body.errors?.length) throw new Error(typeof body.errors[0]?.message === "string" ? body.errors[0].message : "Linear GraphQL error")
    if (!body.data) throw new Error("Linear returned no data")
    return body.data
  }
  function transcriptFiles(root: string): string[] {
    const out: string[] = []
    const visit = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith(".")) continue
        const path = join(dir, entry.name)
        if (entry.isDirectory()) visit(path)
        else if (out.length < MAX_TRANSCRIPT_FILES && entry.isFile() && /\.(?:txt|md)$/i.test(entry.name) && statSync(path).size <= MAX_TRANSCRIPT_BYTES) out.push(path)
      }
    }
    visit(root); return out
  }
  async function backfill(sourceId: string): Promise<void> {
    if (activeBackfills.has(sourceId)) return
    activeBackfills.add(sourceId)
    try {
      const source = one("SELECT * FROM sources WHERE id = ?", sourceId); if (!source) return
      run("UPDATE sources SET backfill_state = 'running', backfill_fetched = 0, backfill_error = NULL, backfill_completed_at = NULL WHERE id = ?", sourceId)
      let fetched = 0
      if (source.kind === "transcripts") {
        const folder = String(source.folder || "")
        if (!folder || !existsSync(folder) || !statSync(folder).isDirectory()) throw new Error("Transcript folder is unavailable")
        for (const file of transcriptFiles(folder)) { insertArtifact(sourceId, "transcript", relative(folder, file), basename(file), readFileSync(file, "utf8")); fetched++; run("UPDATE sources SET backfill_fetched = ? WHERE id = ?", fetched, sourceId) }
      } else {
        let after: string | null = null; let hasNext = true
        const query = `query ZooIssues($after: String) { issues(first: 50, after: $after, filter: { state: { type: { nin: [\"completed\", \"canceled\"] } } }) { nodes { id identifier title description url createdAt updatedAt state { name type } project { name } labels { nodes { name } } } pageInfo { hasNextPage endCursor } } }`
        while (hasNext) {
          const data = await gql(String(source.api_key), query, { after }); const issues = object(data.issues); const nodes = Array.isArray(issues?.nodes) ? issues.nodes as LinearIssue[] : []
          for (const issue of nodes) if (issue && typeof issue.identifier === "string" && typeof issue.title === "string") { insertArtifact(sourceId, "linear_issue", issue.identifier, issue.title, JSON.stringify(issue, null, 2), typeof issue.url === "string" ? issue.url : undefined); fetched++ }
          const page = object(issues?.pageInfo); hasNext = page?.hasNextPage === true; after = typeof page?.endCursor === "string" ? page.endCursor : null
          run("UPDATE sources SET backfill_fetched = ? WHERE id = ?", fetched, sourceId); if (hasNext && !after) throw new Error("Linear pagination cursor missing")
        }
      }
      run("UPDATE sources SET backfill_state = 'done', backfill_fetched = ?, backfill_completed_at = ? WHERE id = ?", fetched, Date.now(), sourceId)
    } catch (error) { run("UPDATE sources SET backfill_state = 'error', backfill_error = ? WHERE id = ?", errorMessage(error).slice(0, 2000), sourceId) } finally { activeBackfills.delete(sourceId) }
  }

  return {
    close: () => { db?.close(); db = undefined },
    async status(params: unknown): Promise<Result<{ sources: ZooSource[]; artifactCount: number; insightCount: number; ideaCount: number; itemCount: number; passes: ZooPass[] }>> { try {
      if (!emptyObject(params)) return { ok: false, error: "Invalid status request" }
      const passes = rows("SELECT * FROM passes ORDER BY started_at DESC").map((r): ZooPass => ({ id: String(r.id), startedAt: Number(r.started_at), status: r.status as ZooPass["status"], ...(typeof r.note === "string" && r.note ? { note: r.note } : {}) }))
      return { ok: true, sources: rows("SELECT * FROM sources ORDER BY created_at DESC").map(sourceFrom), artifactCount: count("artifacts"), insightCount: count("insights"), ideaCount: count("ideas"), itemCount: count("items"), passes }
    } catch (e) { return { ok: false, error: errorMessage(e) } } },
    async connectLinear(params: unknown): Promise<Result<{ source: ZooSource }>> { try {
      const key = text(object(params)?.apiKey, 4096); if (!key) return { ok: false, error: "Invalid Linear API key" }
      const data = await gql(key, "query ZooViewer { viewer { name organization { name } } }"); const viewer = object(data.viewer); const organization = object(viewer?.organization); const label = text(organization?.name, 500) || text(viewer?.name, 500) || "Linear"
      const existing = one("SELECT * FROM sources WHERE kind = 'linear' ORDER BY created_at LIMIT 1"); const id = existing ? String(existing.id) : randomUUID()
      if (existing) run("UPDATE sources SET api_key = ?, label = ? WHERE id = ?", key, label, id); else run("INSERT INTO sources (id, kind, label, api_key, created_at, backfill_state, backfill_fetched) VALUES (?, 'linear', ?, ?, ?, 'idle', 0)", id, label, key, Date.now())
      return { ok: true, source: sourceFrom(one("SELECT * FROM sources WHERE id = ?", id)!) }
    } catch (e) { return { ok: false, error: errorMessage(e) } } },
    async connectTranscripts(params: unknown): Promise<Result<{ source: ZooSource }>> { try {
      const folder = text(object(params)?.folder, 4096); if (!folder) return { ok: false, error: "Invalid transcript folder" }; const path = resolve(folder)
      if (!existsSync(path) || !statSync(path).isDirectory()) return { ok: false, error: "Transcript folder does not exist or is not a directory" }
      const existing = one("SELECT * FROM sources WHERE kind = 'transcripts' AND folder = ?", path); const id = existing ? String(existing.id) : randomUUID()
      if (!existing) run("INSERT INTO sources (id, kind, label, api_key, folder, created_at, backfill_state, backfill_fetched) VALUES (?, 'transcripts', ?, '', ?, ?, 'idle', 0)", id, `${basename(path)} · ${path}`, path, Date.now())
      return { ok: true, source: sourceFrom(one("SELECT * FROM sources WHERE id = ?", id)!) }
    } catch (e) { return { ok: false, error: errorMessage(e) } } },
    async startBackfill(params: unknown): Promise<Result<{}>> { try { const id = text(object(params)?.sourceId, 200); if (!id || !one("SELECT id FROM sources WHERE id = ?", id)) return { ok: false, error: "Unknown source" }; void backfill(id); return { ok: true } } catch (e) { return { ok: false, error: errorMessage(e) } } },
    async listArtifacts(params: unknown): Promise<Result<{ artifacts: ZooArtifactMeta[]; total: number }>> { try {
      const body = object(params); if (!body) return { ok: false, error: "Invalid artifact list request" }; const sourceId = body.sourceId === undefined ? undefined : text(body.sourceId, 200); if (body.sourceId !== undefined && !sourceId) return { ok: false, error: "Invalid sourceId" }
      const all = latestArtifacts(sourceId).sort((a, b) => Number(b.fetched_at) - Number(a.fetched_at)); const limit = number(body.limit, 100, 500) || 100; const offset = number(body.offset, 0, Number.MAX_SAFE_INTEGER)
      return { ok: true, artifacts: all.slice(offset, offset + limit).map(artifactFrom), total: all.length }
    } catch (e) { return { ok: false, error: errorMessage(e) } } },
    async getArtifact(params: unknown): Promise<Result<{ artifact: ZooArtifactMeta & { content: string } }>> { try { const id = text(object(params)?.id, 200); const row = id ? one("SELECT * FROM artifacts WHERE id = ?", id) : undefined; return row ? { ok: true, artifact: { ...artifactFrom(row), content: String(row.content) } } : { ok: false, error: id ? "Unknown artifact" : "Invalid artifact id" } } catch (e) { return { ok: false, error: errorMessage(e) } } },
    async exportForExtraction(params: unknown): Promise<Result<{ passId: string; bundle: string }>> { try {
      const body = object(params); if (!body) return { ok: false, error: "Invalid export request" }; const max = number(body.maxChars, DEFAULT_EXPORT_CHARS, MAX_EXPORT_CHARS); if (max < 1) return { ok: false, error: "maxChars must be positive" }; const passId = pass(); let bundle = ""
      for (const row of latestArtifacts().sort((a, b) => Number(b.fetched_at) - Number(a.fetched_at))) { const header = `\n\n[artifactId: ${row.id}]\nTitle: ${row.title}\n`; const remaining = max - bundle.length - header.length; if (remaining <= 0) break; bundle += header + String(row.content).slice(0, remaining) }
      return { ok: true, passId, bundle }
    } catch (e) { return { ok: false, error: errorMessage(e) } } },
    async recordInsights(params: unknown): Promise<Result<{ insightCount: number }>> { try {
      const body = object(params); const passId = text(body?.passId, 200); if (!passId || !Array.isArray(body?.insights)) return { ok: false, error: "Invalid insights request" }; if (!one("SELECT id FROM passes WHERE id = ?", passId)) return { ok: false, error: "Unknown pass" }; let insightCount = 0
      database().transaction(() => { for (const raw of body.insights as unknown[]) { const item = object(raw); const title = text(item?.title, 2000); const summary = text(item?.summary, 20_000); if (!title || !summary) continue; const id = randomUUID(); const priority = item?.priority === undefined ? null : number(item.priority, 0, 1_000_000); run("INSERT INTO insights (id, pass_id, title, summary, priority, created_at) VALUES (?, ?, ?, ?, ?, ?)", id, passId, title, summary, priority, Date.now()); insightCount++; if (Array.isArray(item?.evidence)) for (const rawEvidence of item.evidence) { const evidence = object(rawEvidence); const artifactId = text(evidence?.artifactId, 200); const quote = text(evidence?.quote, 20_000); if (artifactId && quote && one("SELECT id FROM artifacts WHERE id = ?", artifactId)) run("INSERT OR IGNORE INTO evidence (insight_id, artifact_id, quote) VALUES (?, ?, ?)", id, artifactId, quote) } }; run("UPDATE passes SET status = 'done', note = NULL WHERE id = ?", passId) })()
      return { ok: true, insightCount }
    } catch (e) { return { ok: false, error: errorMessage(e) } } },
    async failPass(params: unknown): Promise<Result<{}>> { try { const body = object(params); const id = text(body?.passId, 200); const note = text(body?.error, 2000); if (!id || !note) return { ok: false, error: "Invalid pass failure" }; if (!one("SELECT id FROM passes WHERE id = ?", id)) return { ok: false, error: "Unknown pass" }; run("UPDATE passes SET status = 'error', note = ? WHERE id = ?", note, id); return { ok: true } } catch (e) { return { ok: false, error: errorMessage(e) } } },
    async listInsights(params: unknown): Promise<Result<{ insights: ZooInsight[] }>> { try { if (!emptyObject(params)) return { ok: false, error: "Invalid insights request" }; return { ok: true, insights: rows("SELECT i.* FROM insights i JOIN passes p ON p.id = i.pass_id ORDER BY p.started_at DESC, i.created_at DESC").map((r): ZooInsight => ({ id: String(r.id), passId: String(r.pass_id), title: String(r.title), summary: String(r.summary), ...(typeof r.priority === "number" ? { priority: r.priority } : {}), evidence: rows("SELECT artifact_id, quote FROM evidence WHERE insight_id = ?", r.id).map((e): ZooEvidence => ({ artifactId: String(e.artifact_id), quote: String(e.quote) })), createdAt: Number(r.created_at) })) } } catch (e) { return { ok: false, error: errorMessage(e) } } },
    async exportInsightsForSynthesis(params: unknown): Promise<Result<{ passId: string; bundle: string }>> { try {
      const body = object(params); if (!body) return { ok: false, error: "Invalid synthesis export request" }; const max = number(body.maxChars, DEFAULT_EXPORT_CHARS, MAX_EXPORT_CHARS); if (max < 1) return { ok: false, error: "maxChars must be positive" }; const passId = pass(); let bundle = ""
      for (const insight of rows("SELECT * FROM insights ORDER BY created_at DESC")) { const evidence = rows("SELECT e.quote, a.title FROM evidence e JOIN artifacts a ON a.id = e.artifact_id WHERE e.insight_id = ?", insight.id).map((e) => `Evidence (${e.title}): ${e.quote}`).join("\n"); const entry = `\n\n[insightId: ${insight.id}]\nTitle: ${insight.title}\nSummary: ${insight.summary}${evidence ? `\n${evidence}` : ""}\n`; if (bundle.length + entry.length > max) { bundle += entry.slice(0, Math.max(0, max - bundle.length)); break } bundle += entry }
      return { ok: true, passId, bundle }
    } catch (e) { return { ok: false, error: errorMessage(e) } } },
    async recordIdeas(params: unknown): Promise<Result<{ ideaCount: number }>> { try {
      const body = object(params); const passId = text(body?.passId, 200); if (!passId || !Array.isArray(body?.ideas)) return { ok: false, error: "Invalid ideas request" }; if (!one("SELECT id FROM passes WHERE id = ?", passId)) return { ok: false, error: "Unknown pass" }; let ideaCount = 0
      for (const raw of body.ideas as unknown[]) { const idea = object(raw); const type = idea?.type; const title = text(idea?.title, 2000); const rationale = text(idea?.rationale, 20_000); if (typeof type !== "string" || !IDEA_TYPES.has(type as ZooIdeaType)) return { ok: false, error: "Invalid idea type" }; if (!title || !rationale || !Array.isArray(idea?.insightIds)) return { ok: false, error: "Invalid idea" } }
      database().transaction(() => { for (const raw of body.ideas as unknown[]) { const input = object(raw)!; const id = randomUUID(); run("INSERT INTO ideas (id, pass_id, type, title, rationale, status, created_at) VALUES (?, ?, ?, ?, ?, 'proposed', ?)", id, passId, input.type, text(input.title)!, text(input.rationale)!, Date.now()); ideaCount++; for (const rawId of input.insightIds as unknown[]) { const insightId = text(rawId, 200); if (insightId && one("SELECT id FROM insights WHERE id = ?", insightId)) run("INSERT OR IGNORE INTO idea_insights (idea_id, insight_id) VALUES (?, ?)", id, insightId) } }; run("UPDATE passes SET status = 'done', note = NULL WHERE id = ?", passId) })()
      return { ok: true, ideaCount }
    } catch (e) { return { ok: false, error: errorMessage(e) } } },
    async listIdeas(params: unknown): Promise<Result<{ ideas: ZooIdea[] }>> { try { if (!emptyObject(params)) return { ok: false, error: "Invalid ideas request" }; return { ok: true, ideas: rows("SELECT * FROM ideas ORDER BY created_at DESC, rowid DESC").map(ideaFrom) } } catch (e) { return { ok: false, error: errorMessage(e) } } },
    async setIdeaStatus(params: unknown): Promise<Result<{ idea: ZooIdea }>> { try { const body = object(params); const id = text(body?.ideaId, 200); const status = body?.status; if (!id || typeof status !== "string" || !IDEA_STATUSES.has(status as ZooIdeaStatus)) return { ok: false, error: "Invalid idea status" }; if (!one("SELECT id FROM ideas WHERE id = ?", id)) return { ok: false, error: "Unknown idea" }; run("UPDATE ideas SET status = ? WHERE id = ?", status, id); return { ok: true, idea: ideaFrom(one("SELECT * FROM ideas WHERE id = ?", id)!) } } catch (e) { return { ok: false, error: errorMessage(e) } } },
    async createItem(params: unknown): Promise<Result<{ item: ZooItem }>> { try { const ideaId = text(object(params)?.ideaId, 200); const idea = ideaId ? one("SELECT * FROM ideas WHERE id = ?", ideaId) : undefined; if (!idea) return { ok: false, error: "Unknown idea" }; if (idea.item_id) return { ok: false, error: "Idea already has an item" }; const id = randomUUID(); const now = Date.now(); database().transaction(() => { run("INSERT INTO items (id, idea_id, title, stage, created_at, updated_at) VALUES (?, ?, ?, 'research', ?, ?)", id, ideaId, idea.title, now, now); run("UPDATE ideas SET status = 'promoted', item_id = ? WHERE id = ?", id, ideaId) })(); return { ok: true, item: itemFrom(one("SELECT * FROM items WHERE id = ?", id)!) } } catch (e) { return { ok: false, error: errorMessage(e) } } },
    async updateItem(params: unknown): Promise<Result<{ item: ZooItem }>> { try {
      const body = object(params); const id = text(body?.itemId, 200); if (!id || !one("SELECT id FROM items WHERE id = ?", id)) return { ok: false, error: id ? "Unknown item" : "Invalid item id" }; const stage = body?.stage; const session = body?.addSessionId; const decision = body?.addDecision === undefined ? undefined : object(body.addDecision)
      if (stage !== undefined && (typeof stage !== "string" || !ITEM_STAGES.has(stage as ZooItemStage))) return { ok: false, error: "Invalid item stage" }; if (session !== undefined && !text(session, 500)) return { ok: false, error: "Invalid session id" }; const actor = decision?.actor; const note = decision ? text(decision.note, 20_000) : null; if (decision && ((actor !== "user" && actor !== "agent") || !note)) return { ok: false, error: "Invalid decision" }; if (stage === undefined && session === undefined && !decision) return { ok: false, error: "No item update supplied" }
      database().transaction(() => { if (stage !== undefined) run("UPDATE items SET stage = ? WHERE id = ?", stage, id); if (session !== undefined) run("INSERT OR IGNORE INTO item_sessions (item_id, session_id) VALUES (?, ?)", id, text(session, 500)!); if (decision) run("INSERT INTO item_decisions (id, item_id, at, actor, note) VALUES (?, ?, ?, ?, ?)", randomUUID(), id, Date.now(), actor, note!); run("UPDATE items SET updated_at = ? WHERE id = ?", Date.now(), id) })()
      return { ok: true, item: itemFrom(one("SELECT * FROM items WHERE id = ?", id)!) }
    } catch (e) { return { ok: false, error: errorMessage(e) } } },
    async listItems(params: unknown): Promise<Result<{ items: ZooItem[] }>> { try { if (!emptyObject(params)) return { ok: false, error: "Invalid items request" }; return { ok: true, items: rows("SELECT * FROM items ORDER BY updated_at DESC, rowid DESC").map(itemFrom) } } catch (e) { return { ok: false, error: errorMessage(e) } } },
    async board(params: unknown): Promise<Result<{ sources: ZooSource[]; counts: { artifacts: number; insights: number; ideas: number; items: number }; ideas: Record<string, unknown[]>; items: Record<string, unknown[]> }>> { try {
      if (!emptyObject(params)) return { ok: false, error: "Invalid board request" }
      const ideas: Record<string, unknown[]> = { proposed: [], promoted: [], dismissed: [] }; const items: Record<string, unknown[]> = { research: [], decision: [], building: [], review: [], shipped: [], dropped: [] }
      for (const row of rows("SELECT * FROM ideas ORDER BY created_at DESC, rowid DESC")) { const idea = ideaFrom(row); ideas[idea.status]!.push({ id: idea.id, type: idea.type, title: idea.title, status: idea.status, ...(idea.itemId ? { itemId: idea.itemId } : {}) }) }
      for (const row of rows("SELECT * FROM items ORDER BY updated_at DESC, rowid DESC")) { const item = itemFrom(row); items[item.stage]!.push({ id: item.id, title: item.title, stage: item.stage, sessionIds: item.sessionIds, updatedAt: item.updatedAt }) }
      return { ok: true, sources: rows("SELECT * FROM sources ORDER BY created_at DESC").map(sourceFrom), counts: { artifacts: count("artifacts"), insights: count("insights"), ideas: count("ideas"), items: count("items") }, ideas, items }
    } catch (e) { return { ok: false, error: errorMessage(e) } } },
    async search(params: unknown): Promise<Result<{ insights: { id: string; title: string; summary: string }[]; ideas: { id: string; type: ZooIdeaType; title: string; status: ZooIdeaStatus }[]; artifacts: { id: string; title: string; sourceId: string; kind: string }[] }>> { try {
      const query = text(object(params)?.query, 500); if (!query || query.length < 2) return { ok: false, error: "Search query must be at least 2 characters" }; const like = `%${query}%`
      return { ok: true, insights: rows("SELECT id, title, summary FROM insights WHERE title LIKE ? COLLATE NOCASE OR summary LIKE ? COLLATE NOCASE LIMIT 20", like, like).map((r) => ({ id: String(r.id), title: String(r.title), summary: String(r.summary) })), ideas: rows("SELECT id, type, title, status FROM ideas WHERE title LIKE ? COLLATE NOCASE OR rationale LIKE ? COLLATE NOCASE LIMIT 20", like, like).map((r) => ({ id: String(r.id), type: r.type as ZooIdeaType, title: String(r.title), status: r.status as ZooIdeaStatus })), artifacts: rows("SELECT id, title, source_id, kind FROM artifacts WHERE title LIKE ? COLLATE NOCASE OR content LIKE ? COLLATE NOCASE LIMIT 20", like, like).map((r) => ({ id: String(r.id), title: String(r.title), sourceId: String(r.source_id), kind: String(r.kind) })) }
    } catch (e) { return { ok: false, error: errorMessage(e) } } },
    async getIdea(params: unknown): Promise<Result<{ idea: ZooIdea; insights: Array<ZooInsight & { evidence: Array<ZooEvidence & { artifactTitle: string }> }> }>> { try {
      const id = text(object(params)?.ideaId, 200); const row = id ? one("SELECT * FROM ideas WHERE id = ?", id) : undefined; if (!row) return { ok: false, error: id ? "Unknown idea" : "Invalid idea id" }
      const insights = rows("SELECT i.* FROM insights i JOIN idea_insights ii ON ii.insight_id = i.id WHERE ii.idea_id = ?", id).map((insight) => ({ id: String(insight.id), passId: String(insight.pass_id), title: String(insight.title), summary: String(insight.summary), evidence: rows("SELECT e.artifact_id, e.quote, a.title FROM evidence e JOIN artifacts a ON a.id = e.artifact_id WHERE e.insight_id = ?", insight.id).map((e) => ({ artifactId: String(e.artifact_id), quote: String(e.quote), artifactTitle: String(e.title) })), createdAt: Number(insight.created_at) }))
      return { ok: true, idea: ideaFrom(row), insights }
    } catch (e) { return { ok: false, error: errorMessage(e) } } },
    async getItem(params: unknown): Promise<Result<{ item: ZooItem; idea: ZooIdea }>> { try { const id = text(object(params)?.itemId, 200); const item = id ? one("SELECT * FROM items WHERE id = ?", id) : undefined; if (!item) return { ok: false, error: id ? "Unknown item" : "Invalid item id" }; const idea = one("SELECT * FROM ideas WHERE id = ?", item.idea_id)!; return { ok: true, item: itemFrom(item), idea: ideaFrom(idea) } } catch (e) { return { ok: false, error: errorMessage(e) } } },
    async moveItem(params: unknown): Promise<Result<{ item: ZooItem }>> { const body = object(params); const stage = body?.stage; const reason = text(body?.reason, 20_000); if (typeof stage !== "string" || !ITEM_STAGES.has(stage as ZooItemStage) || !reason) return { ok: false, error: "Invalid item move" }; return this.updateItem({ itemId: body?.itemId, stage, addDecision: { actor: "agent", note: `Moved to ${stage}: ${reason}` } }) },
    async promoteIdea(params: unknown): Promise<Result<{ item: ZooItem }>> { const body = object(params); const reason = text(body?.reason, 20_000); if (!reason) return { ok: false, error: "Invalid promotion reason" }; const created = await this.createItem({ ideaId: body?.ideaId }); if (!created.ok) return created; return this.updateItem({ itemId: created.item.id, addDecision: { actor: "agent", note: `Promoted: ${reason}` } }) },
    async dismissIdea(params: unknown): Promise<Result<{ idea: ZooIdea }>> { try { const body = object(params); const id = text(body?.ideaId, 200); const reason = text(body?.reason, 20_000); if (!id || !reason) return { ok: false, error: "Invalid dismissal" }; if (!one("SELECT id FROM ideas WHERE id = ?", id)) return { ok: false, error: "Unknown idea" }; run("UPDATE ideas SET status = 'dismissed', dismiss_reason = ? WHERE id = ?", reason, id); return { ok: true, idea: ideaFrom(one("SELECT * FROM ideas WHERE id = ?", id)!) } } catch (e) { return { ok: false, error: errorMessage(e) } } },
    async createIdea(params: unknown): Promise<Result<{ idea: ZooIdea }>> { try { const body = object(params); const type = body?.type; const title = text(body?.title, 2000); const rationale = text(body?.rationale, 20_000); if (typeof type !== "string" || !IDEA_TYPES.has(type as ZooIdeaType) || !title || !rationale) return { ok: false, error: "Invalid idea" }; const id = randomUUID(); database().transaction(() => { run("INSERT INTO ideas (id, pass_id, type, title, rationale, status, created_at) VALUES (?, NULL, ?, ?, ?, 'proposed', ?)", id, type, title, rationale, Date.now()); if (Array.isArray(body?.insightIds)) for (const raw of body.insightIds) { const insightId = text(raw, 200); if (insightId && one("SELECT id FROM insights WHERE id = ?", insightId)) run("INSERT OR IGNORE INTO idea_insights (idea_id, insight_id) VALUES (?, ?)", id, insightId) } })(); return { ok: true, idea: ideaFrom(one("SELECT * FROM ideas WHERE id = ?", id)!) } } catch (e) { return { ok: false, error: errorMessage(e) } } },
    async addNote(params: unknown): Promise<Result<{ item: ZooItem }>> { const body = object(params); const note = text(body?.note, 20_000); if (!note) return { ok: false, error: "Invalid note" }; return this.updateItem({ itemId: body?.itemId, addDecision: { actor: "agent", note } }) },
  }
}
export type ZooManager = ReturnType<typeof createZooManager>
