// Product-factory persistence and Linear ingestion. This module intentionally
// does no model work: it only fetches, versions, and serves durable evidence.
import { createHash, randomUUID } from "node:crypto"
import { mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { Database } from "bun:sqlite"
import { stateDir } from "./connectionManager"
import type { ZooArtifactMeta, ZooEvidence, ZooInsight, ZooPass, ZooSource } from "../shared/zooTypes"

const LINEAR_URL = "https://api.linear.app/graphql"
const DEFAULT_EXPORT_CHARS = 150_000
const MAX_EXPORT_CHARS = 1_000_000

type Row = Record<string, unknown>
type Result<T extends object> = { ok: true } & T | { ok: false; error: string }
type LinearIssue = { id: string; identifier: string; title: string; description?: string | null; url?: string | null; createdAt: string; updatedAt: string; state?: { name?: string; type?: string } | null; project?: { name?: string } | null; labels?: { nodes?: { name?: string }[] } | null }
type ZooDependencies = { dbPath?: string; fetch?: typeof fetch }

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null
}
function emptyObject(value: unknown): boolean {
  const body = object(value)
  return body !== null && Object.keys(body).length === 0
}
function text(value: unknown, max = 20_000): string | null {
  return typeof value === "string" && value.trim() && value.length <= max && !value.includes("\0") ? value.trim() : null
}
function number(value: unknown, fallback: number, cap: number): number {
  const n = typeof value === "number" ? value : Number(value)
  return Number.isFinite(n) ? Math.max(0, Math.min(Math.floor(n), cap)) : fallback
}
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
    db.run("PRAGMA journal_mode = WAL")
    db.run("PRAGMA foreign_keys = ON")
    db.run(`CREATE TABLE IF NOT EXISTS sources (id TEXT PRIMARY KEY, kind TEXT NOT NULL, label TEXT NOT NULL, api_key TEXT NOT NULL, created_at INTEGER NOT NULL, backfill_state TEXT NOT NULL, backfill_fetched INTEGER NOT NULL DEFAULT 0, backfill_error TEXT, backfill_completed_at INTEGER)`)
    db.run(`CREATE TABLE IF NOT EXISTS artifacts (id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES sources(id), kind TEXT NOT NULL, external_id TEXT NOT NULL, title TEXT NOT NULL, url TEXT, content TEXT NOT NULL, content_hash TEXT NOT NULL, fetched_at INTEGER NOT NULL, UNIQUE(source_id, external_id, content_hash))`)
    db.run("CREATE INDEX IF NOT EXISTS artifacts_latest ON artifacts(source_id, external_id, fetched_at DESC)")
    db.run(`CREATE TABLE IF NOT EXISTS passes (id TEXT PRIMARY KEY, started_at INTEGER NOT NULL, status TEXT NOT NULL, note TEXT)`)
    db.run(`CREATE TABLE IF NOT EXISTS insights (id TEXT PRIMARY KEY, pass_id TEXT NOT NULL REFERENCES passes(id), title TEXT NOT NULL, summary TEXT NOT NULL, priority INTEGER, created_at INTEGER NOT NULL)`)
    db.run(`CREATE TABLE IF NOT EXISTS evidence (insight_id TEXT NOT NULL REFERENCES insights(id), artifact_id TEXT NOT NULL REFERENCES artifacts(id), quote TEXT NOT NULL, PRIMARY KEY(insight_id, artifact_id, quote))`)
    return db
  }

  const rows = (sql: string, ...args: unknown[]): Row[] => database().query(sql).all(...args) as Row[]
  const one = (sql: string, ...args: unknown[]): Row | undefined => database().query(sql).get(...args) as Row | undefined
  const run = (sql: string, ...args: unknown[]) => database().query(sql).run(...args)
  const sourceFrom = (row: Row): ZooSource => ({
    id: String(row.id), kind: "linear", label: String(row.label), createdAt: Number(row.created_at),
    backfill: {
      state: row.backfill_state as ZooSource["backfill"]["state"], fetched: Number(row.backfill_fetched),
      ...(typeof row.backfill_error === "string" && row.backfill_error ? { error: row.backfill_error } : {}),
      ...(typeof row.backfill_completed_at === "number" ? { completedAt: row.backfill_completed_at } : {}),
    },
  })
  const artifactFrom = (row: Row): ZooArtifactMeta => ({ id: String(row.id), sourceId: String(row.source_id), kind: String(row.kind), externalId: String(row.external_id), title: String(row.title), ...(typeof row.url === "string" && row.url ? { url: row.url } : {}), fetchedAt: Number(row.fetched_at) })
  const latestArtifacts = (sourceId?: string) => rows(`SELECT a.* FROM artifacts a WHERE ${sourceId ? "a.source_id = ? AND" : ""} NOT EXISTS (SELECT 1 FROM artifacts newer WHERE newer.source_id = a.source_id AND newer.external_id = a.external_id AND (newer.fetched_at > a.fetched_at OR (newer.fetched_at = a.fetched_at AND newer.rowid > a.rowid)))`, ...(sourceId ? [sourceId] : []))

  async function gql(key: string, query: string, variables?: Record<string, unknown>): Promise<Record<string, unknown>> {
    const response = await request(LINEAR_URL, { method: "POST", headers: { Authorization: key, "Content-Type": "application/json" }, body: JSON.stringify({ query, variables }) })
    const body = await response.json().catch(() => ({})) as { data?: Record<string, unknown>; errors?: { message?: unknown }[] }
    if (!response.ok) throw new Error(`Linear request failed (${response.status})`)
    if (body.errors?.length) throw new Error(typeof body.errors[0]?.message === "string" ? body.errors[0].message : "Linear GraphQL error")
    if (!body.data) throw new Error("Linear returned no data")
    return body.data
  }

  async function backfill(sourceId: string): Promise<void> {
    if (activeBackfills.has(sourceId)) return
    activeBackfills.add(sourceId)
    try {
      const source = one("SELECT * FROM sources WHERE id = ? AND kind = 'linear'", sourceId)
      if (!source) return
      run("UPDATE sources SET backfill_state = 'running', backfill_fetched = 0, backfill_error = NULL, backfill_completed_at = NULL WHERE id = ?", sourceId)
      let after: string | null = null; let fetched = 0; let hasNext = true
      const query = `query ZooIssues($after: String) { issues(first: 50, after: $after, filter: { state: { type: { nin: [\"completed\", \"canceled\"] } } }) { nodes { id identifier title description url createdAt updatedAt state { name type } project { name } labels { nodes { name } } } pageInfo { hasNextPage endCursor } } }`
      while (hasNext) {
        const data = await gql(String(source.api_key), query, { after })
        const issues = object(data.issues); const nodes = Array.isArray(issues?.nodes) ? issues.nodes as LinearIssue[] : []
        for (const issue of nodes) {
          if (!issue || typeof issue.identifier !== "string" || typeof issue.title !== "string") continue
          const content = JSON.stringify(issue, null, 2); const contentHash = hash(content); const now = Date.now()
          const exists = one("SELECT id FROM artifacts WHERE source_id = ? AND external_id = ? AND content_hash = ?", sourceId, issue.identifier, contentHash)
          if (!exists) run("INSERT INTO artifacts (id, source_id, kind, external_id, title, url, content, content_hash, fetched_at) VALUES (?, ?, 'linear_issue', ?, ?, ?, ?, ?, ?)", randomUUID(), sourceId, issue.identifier, issue.title, typeof issue.url === "string" ? issue.url : null, content, contentHash, now)
          fetched++
        }
        const page = object(issues?.pageInfo); hasNext = page?.hasNextPage === true; after = typeof page?.endCursor === "string" ? page.endCursor : null
        run("UPDATE sources SET backfill_fetched = ? WHERE id = ?", fetched, sourceId)
        if (hasNext && !after) throw new Error("Linear pagination cursor missing")
      }
      run("UPDATE sources SET backfill_state = 'done', backfill_fetched = ?, backfill_completed_at = ? WHERE id = ?", fetched, Date.now(), sourceId)
    } catch (error) {
      run("UPDATE sources SET backfill_state = 'error', backfill_error = ? WHERE id = ?", errorMessage(error).slice(0, 2000), sourceId)
    } finally { activeBackfills.delete(sourceId) }
  }

  return {
    close: () => { db?.close(); db = undefined },
    async status(params: unknown): Promise<Result<{ sources: ZooSource[]; artifactCount: number; insightCount: number; passes: ZooPass[] }>> { try {
      if (!emptyObject(params)) return { ok: false, error: "Invalid status request" }
      const sources = rows("SELECT * FROM sources ORDER BY created_at DESC").map(sourceFrom)
      const count = (table: string) => Number(one(`SELECT COUNT(*) AS count FROM ${table}`)?.count || 0)
      const passes = rows("SELECT * FROM passes ORDER BY started_at DESC").map((p): ZooPass => ({ id: String(p.id), startedAt: Number(p.started_at), status: p.status as ZooPass["status"], ...(typeof p.note === "string" && p.note ? { note: p.note } : {}) }))
      return { ok: true, sources, artifactCount: count("artifacts"), insightCount: count("insights"), passes }
    } catch (e) { return { ok: false, error: errorMessage(e) } } },
    async connectLinear(params: unknown): Promise<Result<{ source: ZooSource }>> { try {
      const key = text(object(params)?.apiKey, 4096); if (!key) return { ok: false, error: "Invalid Linear API key" }
      const data = await gql(key, "query ZooViewer { viewer { name organization { name } } }")
      const viewer = object(data.viewer); const organization = object(viewer?.organization)
      const label = text(organization?.name, 500) || text(viewer?.name, 500) || "Linear"
      const existing = one("SELECT * FROM sources WHERE kind = 'linear' ORDER BY created_at LIMIT 1"); const id = existing ? String(existing.id) : randomUUID(); const now = Date.now()
      if (existing) run("UPDATE sources SET api_key = ?, label = ? WHERE id = ?", key, label, id)
      else run("INSERT INTO sources (id, kind, label, api_key, created_at, backfill_state, backfill_fetched) VALUES (?, 'linear', ?, ?, ?, 'idle', 0)", id, label, key, now)
      return { ok: true, source: sourceFrom(one("SELECT * FROM sources WHERE id = ?", id)!) }
    } catch (e) { return { ok: false, error: errorMessage(e) } } },
    async startBackfill(params: unknown): Promise<Result<{}>> { try {
      const id = text(object(params)?.sourceId, 200); if (!id || !one("SELECT id FROM sources WHERE id = ?", id)) return { ok: false, error: "Unknown source" }
      void backfill(id); return { ok: true }
    } catch (e) { return { ok: false, error: errorMessage(e) } } },
    async listArtifacts(params: unknown): Promise<Result<{ artifacts: ZooArtifactMeta[]; total: number }>> { try {
      const body = object(params) || {}; const sourceId = body.sourceId === undefined ? undefined : text(body.sourceId, 200)
      if (body.sourceId !== undefined && !sourceId) return { ok: false, error: "Invalid sourceId" }
      const limit = number(body.limit, 100, 500) || 100; const offset = number(body.offset, 0, Number.MAX_SAFE_INTEGER); const all = latestArtifacts(sourceId)
      return { ok: true, artifacts: all.slice(offset, offset + limit).sort((a, b) => Number(b.fetched_at) - Number(a.fetched_at)).map(artifactFrom), total: all.length }
    } catch (e) { return { ok: false, error: errorMessage(e) } } },
    async getArtifact(params: unknown): Promise<Result<{ artifact: ZooArtifactMeta & { content: string } }>> { try {
      const id = text(object(params)?.id, 200); if (!id) return { ok: false, error: "Invalid artifact id" }; const row = one("SELECT * FROM artifacts WHERE id = ?", id)
      if (!row) return { ok: false, error: "Unknown artifact" }; return { ok: true, artifact: { ...artifactFrom(row), content: String(row.content) } }
    } catch (e) { return { ok: false, error: errorMessage(e) } } },
    async exportForExtraction(params: unknown): Promise<Result<{ passId: string; bundle: string }>> { try {
      const body = object(params); if (!body) return { ok: false, error: "Invalid export request" }
      const maxChars = number(body.maxChars, DEFAULT_EXPORT_CHARS, MAX_EXPORT_CHARS); if (maxChars < 1) return { ok: false, error: "maxChars must be positive" }
      const passId = randomUUID(); run("INSERT INTO passes (id, started_at, status) VALUES (?, ?, 'running')", passId, Date.now())
      let bundle = ""; for (const row of latestArtifacts().sort((a, b) => Number(b.fetched_at) - Number(a.fetched_at))) {
        const header = `\n\n[artifactId: ${row.id}]\nTitle: ${row.title}\n`; const remaining = maxChars - bundle.length - header.length
        if (remaining <= 0) break; bundle += header + String(row.content).slice(0, remaining)
      }
      return { ok: true, passId, bundle }
    } catch (e) { return { ok: false, error: errorMessage(e) } } },
    async recordInsights(params: unknown): Promise<Result<{ insightCount: number }>> { try {
      const body = object(params); const passId = text(body?.passId, 200); const input = body?.insights
      if (!passId || !Array.isArray(input)) return { ok: false, error: "Invalid insights request" }; if (!one("SELECT id FROM passes WHERE id = ?", passId)) return { ok: false, error: "Unknown pass" }
      let count = 0; database().transaction(() => { for (const raw of input) { const item = object(raw); const title = text(item?.title, 2000); const summary = text(item?.summary, 20_000); if (!title || !summary) continue
        const id = randomUUID(); const priority = item?.priority === undefined ? null : number(item.priority, 0, 1_000_000); run("INSERT INTO insights (id, pass_id, title, summary, priority, created_at) VALUES (?, ?, ?, ?, ?, ?)", id, passId, title, summary, priority, Date.now()); count++
        if (Array.isArray(item?.evidence)) for (const rawEvidence of item.evidence) { const evidence = object(rawEvidence); const artifactId = text(evidence?.artifactId, 200); const quote = text(evidence?.quote, 20_000); if (artifactId && quote && one("SELECT id FROM artifacts WHERE id = ?", artifactId)) run("INSERT OR IGNORE INTO evidence (insight_id, artifact_id, quote) VALUES (?, ?, ?)", id, artifactId, quote) }
      }; run("UPDATE passes SET status = 'done', note = NULL WHERE id = ?", passId) })()
      return { ok: true, insightCount: count }
    } catch (e) { return { ok: false, error: errorMessage(e) } } },
    async failPass(params: unknown): Promise<Result<{}>> { try { const body = object(params); const passId = text(body?.passId, 200); const note = text(body?.error, 2000); if (!passId || !note) return { ok: false, error: "Invalid pass failure" }; if (!one("SELECT id FROM passes WHERE id = ?", passId)) return { ok: false, error: "Unknown pass" }; run("UPDATE passes SET status = 'error', note = ? WHERE id = ?", note, passId); return { ok: true } } catch (e) { return { ok: false, error: errorMessage(e) } } },
    async listInsights(params: unknown): Promise<Result<{ insights: ZooInsight[] }>> { try {
      if (!emptyObject(params)) return { ok: false, error: "Invalid insights request" }
      const insights = rows("SELECT i.* FROM insights i JOIN passes p ON p.id = i.pass_id ORDER BY p.started_at DESC, i.created_at DESC").map((row): ZooInsight => ({ id: String(row.id), passId: String(row.pass_id), title: String(row.title), summary: String(row.summary), ...(typeof row.priority === "number" ? { priority: row.priority } : {}), evidence: rows("SELECT artifact_id, quote FROM evidence WHERE insight_id = ?", row.id).map((e): ZooEvidence => ({ artifactId: String(e.artifact_id), quote: String(e.quote) })), createdAt: Number(row.created_at) }))
      return { ok: true, insights }
    } catch (e) { return { ok: false, error: errorMessage(e) } } },
  }
}

export type ZooManager = ReturnType<typeof createZooManager>
