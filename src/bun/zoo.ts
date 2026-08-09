// Product-factory persistence and connectors. This module performs only
// deterministic fetch/store work; model synthesis is performed outside Zoo.
import { createHash, randomUUID } from "node:crypto"
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs"
import { basename, dirname, join, relative, resolve } from "node:path"
import { Database } from "bun:sqlite"
import { stateDir } from "./connectionManager"
import {
  fetchRepoDelta,
  formatWatchArtifact,
  parseRepoRef,
  repoLabel,
  type WatchCheckOutcome,
} from "./repoWatch"
import { DEFAULT_WATCH_HOUR } from "./watchScheduler"
import { DEFAULT_X_WATCH_INTERVAL_MINUTES, MAX_X_WATCH_INTERVAL_MINUTES, MIN_X_WATCH_INTERVAL_MINUTES } from "./xWatchScheduler"
import { formatXArtifact, normalizeXHandle, type XWatchRun } from "./xWatch"
import type { ZooArea, ZooAreaKind, ZooArtifactMeta, ZooRepoWatch, ZooWatchResult, ZooWatchStatus, ZooXWatch, ZooXWatchResult, ZooDecision, ZooEvidence, ZooIdea, ZooIdeaStatus, ZooIdeaType, ZooInsight, ZooItem, ZooItemStage, ZooPass, ZooSource } from "../shared/zooTypes"

const LINEAR_URL = "https://api.linear.app/graphql"
const DEFAULT_EXPORT_CHARS = 150_000
const MAX_EXPORT_CHARS = 1_000_000
const MAX_TRANSCRIPT_BYTES = 1_000_000
const MAX_TRANSCRIPT_FILES = 2_000
const IDEA_TYPES = new Set<ZooIdeaType>(["close", "investigate", "build", "needs-detail"])
const IDEA_STATUSES = new Set<ZooIdeaStatus>(["proposed", "promoted", "dismissed"])
const ITEM_STAGES = new Set<ZooItemStage>(["research", "decision", "building", "review", "shipped", "dropped"])
/** Tables that carry an optional area_id. Every one of them treats NULL as
 *  "unassigned", which every area shows — areas scope a single board, they do
 *  not shard it. */
const AREA_TABLES: Record<ZooAreaKind, string> = { source: "sources", insight: "insights", idea: "ideas", item: "items" }
const MAX_AREA_REPOS = 20
/** Guard rail on a check: 60 unauthenticated GitHub calls/hour, ~6 per watch. */
const MAX_WATCHES = 25
const MAX_X_WATCHES = 25
export const DEFAULT_X_WATCHES = ["theo"] as const
export const DEFAULT_REPO_WATCHES = [
  { owner: "pingdotgg", name: "t3code" },
  { owner: "craft-ai-agents", name: "craft-agents-oss" },
  { owner: "Emanuele-web04", name: "synara" },
  { owner: "get-bb", name: "bb" },
] as const

type Row = Record<string, unknown>
type Result<T extends object> = ({ ok: true } & T) | { ok: false; error: string }
type ZooDependencies = { dbPath?: string; fetch?: typeof fetch; githubToken?: string | null; xWatchRun?: XWatchRun; now?: () => number; seedDefaults?: boolean }
type LinearIssue = { identifier: string; title: string; url?: string | null }

function object(value: unknown): Record<string, unknown> | null { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null }
function emptyObject(value: unknown): boolean { const body = object(value); return body !== null && Object.keys(body).length === 0 }
function text(value: unknown, max = 20_000): string | null { return typeof value === "string" && value.trim() && value.length <= max && !value.includes("\0") ? value.trim() : null }
function number(value: unknown, fallback: number, cap: number): number { const n = typeof value === "number" ? value : Number(value); return Number.isFinite(n) ? Math.max(0, Math.min(Math.floor(n), cap)) : fallback }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : "Unexpected zoo error" }
function artifactSummary(outcome: Extract<WatchCheckOutcome, { status: "ok" }>): string {
  const { releases, newTags, pulls, commits } = outcome.delta
  const parts: string[] = []
  if (releases.length) parts.push(`${releases.length} release${releases.length === 1 ? "" : "s"}`)
  if (newTags.length) parts.push(`${newTags.length} tag${newTags.length === 1 ? "" : "s"}`)
  if (pulls.length) parts.push(`${pulls.length} merged PR${pulls.length === 1 ? "" : "s"}`)
  if (commits.length) parts.push(`${commits.length} doc commit${commits.length === 1 ? "" : "s"}`)
  return parts.join(", ") || "no change"
}
function hash(value: string): string { return createHash("sha256").update(value).digest("hex") }

export function createZooManager(deps: ZooDependencies = {}) {
  const dbPath = deps.dbPath || join(stateDir(process.env), "zoo.db")
  const request = deps.fetch || fetch
  // Read once, kept in this closure: the token never leaves the Bun process and
  // is never written to a note, an artifact, or an error.
  const githubToken = deps.githubToken !== undefined ? deps.githubToken : process.env.GITHUB_TOKEN || null
  const clock = deps.now || (() => Date.now())
  let db: Database | undefined
  const activeBackfills = new Set<string>()
  let activeWatchCheck = false
  let activeXWatchCheck = false

  const database = () => {
    if (db) return db
    // This is deliberately captured before SQLite opens the path. Defaults are
    // for a genuinely new board only: an existing empty/migrated database is
    // user state and must remain untouched.
    const isNewStore = !existsSync(dbPath)
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
    // Areas, and the nullable area_id every scoped table carries. These ALTERs
    // run LAST on purpose: the ideas rebuild above copies a fixed column list,
    // so adding the column before it would silently drop it again.
    db.run("CREATE TABLE IF NOT EXISTS areas (id TEXT PRIMARY KEY, name TEXT NOT NULL, repo_paths TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL)")
    for (const table of Object.values(AREA_TABLES)) { try { db.run(`ALTER TABLE ${table} ADD COLUMN area_id TEXT`) } catch {} }
    // Competitor watches. A watch IS a source (kind 'repo-watch'), so its
    // artifacts flow through the ordinary extraction pipeline; this table only
    // holds what a source row cannot: the repo, the tag baseline, and the
    // per-watch check outcome that the scheduler and the UI both read.
    db.run("CREATE TABLE IF NOT EXISTS repo_watches (id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES sources(id), owner TEXT NOT NULL, name TEXT NOT NULL, seen_tags TEXT NOT NULL DEFAULT '[]', last_check_at INTEGER, last_status TEXT, last_note TEXT, last_artifact_at INTEGER, last_extract_at INTEGER, created_at INTEGER NOT NULL)")
    try { db.run("ALTER TABLE repo_watches ADD COLUMN last_attempt_at INTEGER") } catch {}
    // Enforce the same identity rule as addRepoWatch at the database boundary.
    // A development build may already have case-only duplicates under the old
    // case-sensitive index. Keep the oldest active watch, retain every source
    // and artifact, then install the stronger index without making that board
    // impossible to open.
    db.run("DELETE FROM repo_watches WHERE EXISTS (SELECT 1 FROM repo_watches older WHERE older.owner = repo_watches.owner COLLATE NOCASE AND older.name = repo_watches.name COLLATE NOCASE AND older.rowid < repo_watches.rowid)")
    db.run("DROP INDEX IF EXISTS repo_watches_repo")
    db.run("CREATE UNIQUE INDEX IF NOT EXISTS repo_watches_repo ON repo_watches(owner COLLATE NOCASE, name COLLATE NOCASE)")
    // X watches are independent sources and jobs. `last_success_at` is the
    // collection cursor; attempts and failures never move it.
    db.run("CREATE TABLE IF NOT EXISTS x_watches (id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES sources(id), handle TEXT NOT NULL, last_success_at INTEGER, last_attempt_at INTEGER, last_status TEXT, last_note TEXT, last_artifact_at INTEGER, last_extract_at INTEGER, created_at INTEGER NOT NULL)")
    db.run("DELETE FROM x_watches WHERE EXISTS (SELECT 1 FROM x_watches older WHERE older.handle = x_watches.handle COLLATE NOCASE AND older.rowid < x_watches.rowid)")
    db.run("CREATE UNIQUE INDEX IF NOT EXISTS x_watches_handle ON x_watches(handle COLLATE NOCASE)")
    db.run("CREATE TABLE IF NOT EXISTS zoo_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
    if (isNewStore && deps.seedDefaults !== false) {
      const now = clock()
      db.transaction(() => {
        for (const ref of DEFAULT_REPO_WATCHES) {
          const sourceId = randomUUID(); const watchId = randomUUID(); const label = repoLabel(ref)
          db!.query("INSERT INTO sources (id, kind, label, api_key, area_id, created_at, backfill_state, backfill_fetched) VALUES (?, 'repo-watch', ?, '', NULL, ?, 'idle', 0)").run(sourceId, label, now)
          db!.query("INSERT INTO repo_watches (id, source_id, owner, name, seen_tags, created_at) VALUES (?, ?, ?, ?, '[]', ?)").run(watchId, sourceId, ref.owner, ref.name, now)
        }
        for (const handle of DEFAULT_X_WATCHES) {
          const sourceId = randomUUID(); const watchId = randomUUID()
          db!.query("INSERT INTO sources (id, kind, label, api_key, area_id, created_at, backfill_state, backfill_fetched) VALUES (?, 'x-watch', ?, '', NULL, ?, 'idle', 0)").run(sourceId, `@${handle}`, now)
          db!.query("INSERT INTO x_watches (id, source_id, handle, created_at) VALUES (?, ?, ?, ?)").run(watchId, sourceId, handle, now)
        }
      })()
    }
    return db
  }
  const rows = (sql: string, ...args: unknown[]): Row[] => database().query(sql).all(...args) as Row[]
  const one = (sql: string, ...args: unknown[]): Row | undefined => database().query(sql).get(...args) as Row | undefined
  const run = (sql: string, ...args: unknown[]) => database().query(sql).run(...args)
  const sourceFrom = (row: Row): ZooSource => ({ id: String(row.id), kind: row.kind === "transcripts" ? "transcripts" : row.kind === "repo-watch" ? "repo-watch" : row.kind === "x-watch" ? "x-watch" : "linear", label: String(row.label), ...areaOf(row), createdAt: Number(row.created_at), backfill: { state: row.backfill_state as ZooSource["backfill"]["state"], fetched: Number(row.backfill_fetched), ...(typeof row.backfill_error === "string" && row.backfill_error ? { error: row.backfill_error } : {}), ...(typeof row.backfill_completed_at === "number" ? { completedAt: row.backfill_completed_at } : {}) } })
  const artifactFrom = (row: Row): ZooArtifactMeta => ({ id: String(row.id), sourceId: String(row.source_id), kind: String(row.kind), externalId: String(row.external_id), title: String(row.title), ...(typeof row.url === "string" && row.url ? { url: row.url } : {}), fetchedAt: Number(row.fetched_at) })
  const latestArtifacts = (sourceId?: string) => rows(`SELECT a.* FROM artifacts a WHERE ${sourceId ? "a.source_id = ? AND" : ""} NOT EXISTS (SELECT 1 FROM artifacts n WHERE n.source_id = a.source_id AND n.external_id = a.external_id AND (n.fetched_at > a.fetched_at OR (n.fetched_at = a.fetched_at AND n.rowid > a.rowid)))`, ...(sourceId ? [sourceId] : []))
  const count = (table: string) => Number(one(`SELECT COUNT(*) AS count FROM ${table}`)?.count || 0)
  const pass = (): string => { const id = randomUUID(); run("INSERT INTO passes (id, started_at, status) VALUES (?, ?, 'running')", id, clock()); return id }
  /** Returns false when an identical artifact is already stored (dedupe). */
  const insertArtifact = (sourceId: string, kind: string, externalId: string, title: string, content: string, url?: string): boolean => {
    const contentHash = hash(content)
    if (one("SELECT id FROM artifacts WHERE source_id = ? AND external_id = ? AND content_hash = ?", sourceId, externalId, contentHash)) return false
    run("INSERT INTO artifacts (id, source_id, kind, external_id, title, url, content, content_hash, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", randomUUID(), sourceId, kind, externalId, title, url || null, content, contentHash, clock())
    return true
  }
  /** area_id is nullable everywhere: absent means "unassigned", never an error. */
  const areaOf = (row: Row): { areaId?: string } => (typeof row.area_id === "string" && row.area_id ? { areaId: row.area_id } : {})
  const areaFrom = (row: Row): ZooArea => {
    let repoPaths: string[] = []
    try { const parsed: unknown = JSON.parse(String(row.repo_paths || "[]")); if (Array.isArray(parsed)) repoPaths = parsed.filter((entry): entry is string => typeof entry === "string" && !!entry.trim()) } catch {}
    return { id: String(row.id), name: String(row.name), ...(repoPaths.length ? { repoPaths } : {}), createdAt: Number(row.created_at) }
  }
  /** Repo paths are stored verbatim (they are matched against the server's repo
   *  registry, not the local filesystem) — only shape and volume are enforced. */
  const repoPathsOf = (value: unknown): string[] | null => {
    if (value === undefined) return []
    if (!Array.isArray(value)) return null
    const out: string[] = []
    for (const entry of value.slice(0, MAX_AREA_REPOS)) { const path = text(entry, 4096); if (!path) return null; out.push(path) }
    return out
  }
  const setting = (key: string): string | null => { const row = one("SELECT value FROM zoo_settings WHERE key = ?", key); return row && typeof row.value === "string" ? row.value : null }
  const putSetting = (key: string, value: string) => run("INSERT INTO zoo_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, value)
  const watchHour = (): number => { const stored = setting("watchHour"); const raw = stored === null ? Number.NaN : Number(stored); return Number.isFinite(raw) && raw >= 0 && raw <= 23 ? Math.floor(raw) : DEFAULT_WATCH_HOUR }
  const jsonList = (value: unknown): string[] => { try { const parsed: unknown = JSON.parse(String(value || "[]")); return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [] } catch { return [] } }
  const watchFrom = (row: Row): ZooRepoWatch => ({
    id: String(row.id),
    sourceId: String(row.source_id),
    owner: String(row.owner),
    name: String(row.name),
    label: `${String(row.owner)}/${String(row.name)}`,
    ...(typeof row.area_id === "string" && row.area_id ? { areaId: row.area_id } : {}),
    ...(typeof row.last_check_at === "number" ? { lastCheckAt: row.last_check_at } : {}),
    ...(typeof row.last_status === "string" && row.last_status ? { lastStatus: row.last_status as ZooRepoWatch["lastStatus"] } : {}),
    ...(typeof row.last_note === "string" && row.last_note ? { lastNote: row.last_note } : {}),
    ...(typeof row.last_artifact_at === "number" ? { lastArtifactAt: row.last_artifact_at } : {}),
    ...(typeof row.last_extract_at === "number" ? { lastExtractAt: row.last_extract_at } : {}),
    createdAt: Number(row.created_at),
  })
  const watchRows = () => rows("SELECT w.*, s.area_id AS area_id FROM repo_watches w JOIN sources s ON s.id = w.source_id ORDER BY w.created_at, w.rowid")
  const xInterval = (): number => { const raw = Number(setting("xWatchIntervalMinutes")); return Number.isFinite(raw) && raw >= MIN_X_WATCH_INTERVAL_MINUTES && raw <= MAX_X_WATCH_INTERVAL_MINUTES ? Math.floor(raw) : DEFAULT_X_WATCH_INTERVAL_MINUTES }
  const xWatchFrom = (row: Row): ZooXWatch => ({ id: String(row.id), sourceId: String(row.source_id), handle: String(row.handle), label: `@${String(row.handle)}`, ...areaOf(row), ...(typeof row.last_success_at === "number" ? { lastSuccessAt: row.last_success_at } : {}), ...(typeof row.last_attempt_at === "number" ? { lastAttemptAt: row.last_attempt_at } : {}), ...(typeof row.last_status === "string" && row.last_status ? { lastStatus: row.last_status as ZooXWatch["lastStatus"] } : {}), ...(typeof row.last_note === "string" && row.last_note ? { lastNote: row.last_note } : {}), ...(typeof row.last_artifact_at === "number" ? { lastArtifactAt: row.last_artifact_at } : {}), ...(typeof row.last_extract_at === "number" ? { lastExtractAt: row.last_extract_at } : {}), createdAt: Number(row.created_at) })
  const xWatchRows = () => rows("SELECT w.*, s.area_id AS area_id FROM x_watches w JOIN sources s ON s.id = w.source_id ORDER BY w.created_at, w.rowid")
  /** Where an insight's evidence came from — a watch's insights can then be
   *  badged with the repository they are about. */
  const sourceLabelsOf = (insightId: string): { sourceLabels?: string[] } => {
    const labels = rows("SELECT DISTINCT s.label AS label FROM evidence e JOIN artifacts a ON a.id = e.artifact_id JOIN sources s ON s.id = a.source_id WHERE e.insight_id = ? LIMIT 4", insightId).map((r) => String(r.label)).filter(Boolean)
    return labels.length ? { sourceLabels: labels } : {}
  }
  const areaExists = (id: string) => !!one("SELECT id FROM areas WHERE id = ?", id)
  const insightIds = (ideaId: string) => rows("SELECT insight_id FROM idea_insights WHERE idea_id = ? ORDER BY rowid", ideaId).map((r) => String(r.insight_id))
  const ideaFrom = (row: Row): ZooIdea => ({ id: String(row.id), type: row.type as ZooIdeaType, title: String(row.title), rationale: String(row.rationale), status: row.status as ZooIdeaStatus, insightIds: insightIds(String(row.id)), ...areaOf(row), createdAt: Number(row.created_at), ...(typeof row.item_id === "string" && row.item_id ? { itemId: row.item_id } : {}), ...(typeof row.dismiss_reason === "string" && row.dismiss_reason ? { dismissReason: row.dismiss_reason } : {}) })
  const itemFrom = (row: Row): ZooItem => ({ id: String(row.id), ideaId: String(row.idea_id), title: String(row.title), stage: row.stage as ZooItemStage, sessionIds: rows("SELECT session_id FROM item_sessions WHERE item_id = ? ORDER BY rowid", row.id).map((r) => String(r.session_id)), decisions: rows("SELECT at, actor, note FROM item_decisions WHERE item_id = ? ORDER BY at, rowid", row.id).map((r): ZooDecision => ({ at: Number(r.at), actor: r.actor as ZooDecision["actor"], note: String(r.note) })), ...areaOf(row), createdAt: Number(row.created_at), updatedAt: Number(row.updated_at) })

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
      run("UPDATE sources SET backfill_state = 'done', backfill_fetched = ?, backfill_completed_at = ? WHERE id = ?", fetched, clock(), sourceId)
    } catch (error) { run("UPDATE sources SET backfill_state = 'error', backfill_error = ? WHERE id = ?", errorMessage(error).slice(0, 2000), sourceId) } finally { activeBackfills.delete(sourceId) }
  }

  return {
    close: () => { db?.close(); db = undefined },
    /** Is there a board on disk at all? Lets a caller (the watch scheduler at
     *  launch) skip work WITHOUT creating zoo.db as a side effect. */
    hasStore: () => existsSync(dbPath),
    async listAreas(params: unknown): Promise<Result<{ areas: ZooArea[] }>> { try { if (!emptyObject(params)) return { ok: false, error: "Invalid areas request" }; return { ok: true, areas: rows("SELECT * FROM areas ORDER BY created_at, rowid").map(areaFrom) } } catch (e) { return { ok: false, error: errorMessage(e) } } },
    async createArea(params: unknown): Promise<Result<{ area: ZooArea }>> { try {
      const body = object(params); const name = text(body?.name, 200); if (!name) return { ok: false, error: "Invalid area name" }
      const repoPaths = repoPathsOf(body?.repoPaths); if (!repoPaths) return { ok: false, error: "Invalid area repo paths" }
      if (one("SELECT id FROM areas WHERE name = ? COLLATE NOCASE", name)) return { ok: false, error: "An area with that name already exists" }
      const id = randomUUID(); run("INSERT INTO areas (id, name, repo_paths, created_at) VALUES (?, ?, ?, ?)", id, name, JSON.stringify(repoPaths), clock())
      return { ok: true, area: areaFrom(one("SELECT * FROM areas WHERE id = ?", id)!) }
    } catch (e) { return { ok: false, error: errorMessage(e) } } },
    async updateArea(params: unknown): Promise<Result<{ area: ZooArea }>> { try {
      const body = object(params); const id = text(body?.areaId, 200); if (!id || !areaExists(id)) return { ok: false, error: id ? "Unknown area" : "Invalid area id" }
      const name = body?.name === undefined ? null : text(body.name, 200); if (body?.name !== undefined && !name) return { ok: false, error: "Invalid area name" }
      const repoPaths = body?.repoPaths === undefined ? null : repoPathsOf(body.repoPaths); if (body?.repoPaths !== undefined && !repoPaths) return { ok: false, error: "Invalid area repo paths" }
      if (!name && !repoPaths) return { ok: false, error: "No area update supplied" }
      if (name && one("SELECT id FROM areas WHERE name = ? COLLATE NOCASE AND id <> ?", name, id)) return { ok: false, error: "An area with that name already exists" }
      database().transaction(() => { if (name) run("UPDATE areas SET name = ? WHERE id = ?", name, id); if (repoPaths) run("UPDATE areas SET repo_paths = ? WHERE id = ?", JSON.stringify(repoPaths), id) })()
      return { ok: true, area: areaFrom(one("SELECT * FROM areas WHERE id = ?", id)!) }
    } catch (e) { return { ok: false, error: errorMessage(e) } } },
    /** Deleting an area UNASSIGNS its rows; it never deletes board data. */
    async deleteArea(params: unknown): Promise<Result<{}>> { try {
      const id = text(object(params)?.areaId, 200); if (!id || !areaExists(id)) return { ok: false, error: id ? "Unknown area" : "Invalid area id" }
      database().transaction(() => { for (const table of Object.values(AREA_TABLES)) run(`UPDATE ${table} SET area_id = NULL WHERE area_id = ?`, id); run("DELETE FROM areas WHERE id = ?", id) })()
      return { ok: true }
    } catch (e) { return { ok: false, error: errorMessage(e) } } },
    /** Move one row between areas (areaId null = unassigned). An idea and the
     *  item it became always travel together, so the pair can never straddle
     *  two areas. */
    async assignArea(params: unknown): Promise<Result<{}>> { try {
      const body = object(params); const kind = body?.kind; const id = text(body?.id, 200)
      if (typeof kind !== "string" || !(kind in AREA_TABLES)) return { ok: false, error: "Invalid area assignment kind" }
      if (!id) return { ok: false, error: "Invalid area assignment id" }
      const areaId = body?.areaId === null || body?.areaId === undefined ? null : text(body.areaId, 200)
      if (body?.areaId !== null && body?.areaId !== undefined && !areaId) return { ok: false, error: "Invalid area id" }
      if (areaId && !areaExists(areaId)) return { ok: false, error: "Unknown area" }
      const table = AREA_TABLES[kind as ZooAreaKind]
      if (!one(`SELECT id FROM ${table} WHERE id = ?`, id)) return { ok: false, error: `Unknown ${kind}` }
      database().transaction(() => {
        run(`UPDATE ${table} SET area_id = ? WHERE id = ?`, areaId, id)
        if (kind === "idea") run("UPDATE items SET area_id = ? WHERE idea_id = ?", areaId, id)
        if (kind === "item") run("UPDATE ideas SET area_id = ? WHERE id = (SELECT idea_id FROM items WHERE id = ?)", areaId, id)
      })()
      return { ok: true }
    } catch (e) { return { ok: false, error: errorMessage(e) } } },
    // ---- competitor watch -------------------------------------------------
    async listRepoWatches(params: unknown): Promise<Result<{ watches: ZooRepoWatch[]; hour: number; lastRunAt: number | null }>> { try {
      if (!emptyObject(params)) return { ok: false, error: "Invalid watch list request" }
      const lastRun = Number(setting("watchLastRunAt"))
      return { ok: true, watches: watchRows().map(watchFrom), hour: watchHour(), lastRunAt: Number.isFinite(lastRun) && lastRun > 0 ? lastRun : null }
    } catch (e) { return { ok: false, error: errorMessage(e) } } },
    /** Adding a watch creates its source too — one source per watched repo, so
     *  its artifacts, its area, and its evidence stay attributable. */
    async addRepoWatch(params: unknown): Promise<Result<{ watch: ZooRepoWatch }>> { try {
      const body = object(params); const ref = parseRepoRef(text(body?.repo, 300))
      if (!ref) return { ok: false, error: "Enter a repository as owner/name" }
      const areaId = text(body?.areaId, 200); if (areaId && !areaExists(areaId)) return { ok: false, error: "Unknown area" }
      if (one("SELECT id FROM repo_watches WHERE owner = ? COLLATE NOCASE AND name = ? COLLATE NOCASE", ref.owner, ref.name)) return { ok: false, error: "That repository is already watched" }
      if (Number(one("SELECT COUNT(*) AS count FROM repo_watches")?.count || 0) >= MAX_WATCHES) return { ok: false, error: `A watchlist tops out at ${MAX_WATCHES} repositories` }
      const label = repoLabel(ref); const sourceId = randomUUID(); const id = randomUUID(); const now = clock()
      database().transaction(() => {
        run("INSERT INTO sources (id, kind, label, api_key, area_id, created_at, backfill_state, backfill_fetched) VALUES (?, 'repo-watch', ?, '', ?, ?, 'idle', 0)", sourceId, label, areaId || null, now)
        run("INSERT INTO repo_watches (id, source_id, owner, name, seen_tags, created_at) VALUES (?, ?, ?, ?, '[]', ?)", id, sourceId, ref.owner, ref.name, now)
      })()
      return { ok: true, watch: watchFrom(one("SELECT w.*, s.area_id AS area_id FROM repo_watches w JOIN sources s ON s.id = w.source_id WHERE w.id = ?", id)!) }
    } catch (e) { return { ok: false, error: errorMessage(e) } } },
    /** Stops watching but KEEPS the source and everything it taught us — the
     *  insights already drawn from it still have their evidence. */
    async removeRepoWatch(params: unknown): Promise<Result<{}>> { try {
      const id = text(object(params)?.watchId, 200); if (!id || !one("SELECT id FROM repo_watches WHERE id = ?", id)) return { ok: false, error: id ? "Unknown watch" : "Invalid watch id" }
      run("DELETE FROM repo_watches WHERE id = ?", id)
      return { ok: true }
    } catch (e) { return { ok: false, error: errorMessage(e) } } },
    async setWatchSchedule(params: unknown): Promise<Result<{ hour: number }>> { try {
      const raw = object(params)?.hour; const hour = typeof raw === "number" ? raw : Number(raw)
      if (!Number.isFinite(hour) || hour < 0 || hour > 23) return { ok: false, error: "Pick an hour between 0 and 23" }
      putSetting("watchHour", String(Math.floor(hour)))
      return { ok: true, hour: Math.floor(hour) }
    } catch (e) { return { ok: false, error: errorMessage(e) } } },
    /** State the scheduler arms itself from — persisted, so a relaunch mid-day
     *  does not re-run a check that already happened. */
    async watchState(params: unknown): Promise<Result<{ hour: number; lastCheckAt: number | null; watchCount: number }>> { try {
      if (!emptyObject(params)) return { ok: false, error: "Invalid watch state request" }
      const lastRun = Number(setting("watchLastRunAt"))
      return { ok: true, hour: watchHour(), lastCheckAt: Number.isFinite(lastRun) && lastRun > 0 ? lastRun : null, watchCount: Number(one("SELECT COUNT(*) AS count FROM repo_watches")?.count || 0) }
    } catch (e) { return { ok: false, error: errorMessage(e) } } },
    /**
     * One check pass: fetch each watch's delta and store it as an artifact.
     *
     * A skip or an error records the attempt but LEAVES THE CURSOR ALONE, so a
     * rate-limited morning is retried later without losing the window. Nothing
     * here throws: the scheduler must survive every outcome.
     */
    async checkRepoWatches(params: unknown): Promise<Result<{ results: ZooWatchResult[]; checkedAt: number }>> { try {
      if (activeWatchCheck) return { ok: false, error: "A competitor-watch check is already running." }
      const body = object(params) || {}; const only = body.watchId === undefined ? null : text(body.watchId, 200)
      if (body.watchId !== undefined && !only) return { ok: false, error: "Invalid watch id" }
      const targets = watchRows().filter((row) => !only || String(row.id) === only)
      if (only && !targets.length) return { ok: false, error: "Unknown watch" }
      activeWatchCheck = true
      const checkedAt = clock()
      const results: ZooWatchResult[] = []
      try { for (const row of targets) {
        const watch = watchFrom(row)
        const since = typeof row.last_check_at === "number" ? row.last_check_at : null
        let outcome: WatchCheckOutcome
        try {
          outcome = await fetchRepoDelta({
            ref: { owner: watch.owner, name: watch.name },
            since,
            seenTags: jsonList(row.seen_tags),
            deps: { fetch: request, token: githubToken, now: clock },
          })
        } catch (error) {
          outcome = { status: "error", note: errorMessage(error) }
        }

        if (outcome.status === "ok") {
          let added = 0
          if (outcome.changed) {
            const artifact = formatWatchArtifact(outcome.delta)
            if (insertArtifact(watch.sourceId, "repo-watch", artifact.externalId, artifact.title, artifact.content, `https://github.com/${watch.label}`)) added = 1
          }
          const note = outcome.changed ? `Recorded ${artifactSummary(outcome)}` : "No new activity"
          run("UPDATE repo_watches SET last_check_at = ?, last_attempt_at = ?, last_status = 'ok', last_note = ?, seen_tags = ?" + (added ? ", last_artifact_at = ?" : "") + " WHERE id = ?", outcome.delta.until, checkedAt, note, JSON.stringify(outcome.tags), ...(added ? [outcome.delta.until] : []), watch.id)
          run("UPDATE sources SET backfill_state = 'done', backfill_fetched = backfill_fetched + ?, backfill_error = NULL, backfill_completed_at = ? WHERE id = ?", added, checkedAt, watch.sourceId)
          results.push({ watchId: watch.id, label: watch.label, status: "ok", added, note })
        } else {
          const status: ZooWatchStatus = outcome.status === "skipped" ? "skipped" : "error"
          const note = outcome.status === "skipped" && outcome.retryAt ? `${outcome.note} — retry after ${new Date(outcome.retryAt).toISOString()}` : outcome.note
          run("UPDATE repo_watches SET last_attempt_at = ?, last_status = ?, last_note = ? WHERE id = ?", checkedAt, status, note, watch.id)
          if (status === "error") run("UPDATE sources SET backfill_state = 'error', backfill_error = ? WHERE id = ?", note.slice(0, 2000), watch.sourceId)
          results.push({ watchId: watch.id, label: watch.label, status, added: 0, note })
        }
      } } finally { activeWatchCheck = false }
      // Records the PASS, not the per-watch cursors: this is what the scheduler
      // uses to decide whether a launch needs to catch up.
      putSetting("watchLastRunAt", String(checkedAt))
      return { ok: true, results, checkedAt }
    } catch (e) { activeWatchCheck = false; return { ok: false, error: errorMessage(e) } } },
    /** The renderer ran the extraction pass over this watch's new artifacts. */
    async markWatchExtracted(params: unknown): Promise<Result<{}>> { try {
      const id = text(object(params)?.watchId, 200); if (!id || !one("SELECT id FROM repo_watches WHERE id = ?", id)) return { ok: false, error: id ? "Unknown watch" : "Invalid watch id" }
      run("UPDATE repo_watches SET last_extract_at = ? WHERE id = ?", clock(), id)
      return { ok: true }
    } catch (e) { return { ok: false, error: errorMessage(e) } } },
    // ---- X watch ----------------------------------------------------------
    async listXWatches(params: unknown): Promise<Result<{ watches: ZooXWatch[]; intervalMinutes: number; lastSuccessAt: number | null }>> { try {
      if (!emptyObject(params)) return { ok: false, error: "Invalid X-watch list request" }
      const last = Number(setting("xWatchLastSuccessAt"))
      return { ok: true, watches: xWatchRows().map(xWatchFrom), intervalMinutes: xInterval(), lastSuccessAt: Number.isFinite(last) && last > 0 ? last : null }
    } catch (e) { return { ok: false, error: errorMessage(e) } } },
    async addXWatch(params: unknown): Promise<Result<{ watch: ZooXWatch }>> { try {
      const body = object(params); const handle = normalizeXHandle(body?.handle); if (!handle) return { ok: false, error: "Enter a valid X handle" }
      const areaId = text(body?.areaId, 200); if (areaId && !areaExists(areaId)) return { ok: false, error: "Unknown area" }
      if (one("SELECT id FROM x_watches WHERE handle = ? COLLATE NOCASE", handle)) return { ok: false, error: "That X account is already watched" }
      if (Number(one("SELECT COUNT(*) AS count FROM x_watches")?.count || 0) >= MAX_X_WATCHES) return { ok: false, error: `An X watchlist tops out at ${MAX_X_WATCHES} accounts` }
      const id = randomUUID(); const sourceId = randomUUID(); const now = clock()
      database().transaction(() => { run("INSERT INTO sources (id, kind, label, api_key, area_id, created_at, backfill_state, backfill_fetched) VALUES (?, 'x-watch', ?, '', ?, ?, 'idle', 0)", sourceId, `@${handle}`, areaId || null, now); run("INSERT INTO x_watches (id, source_id, handle, created_at) VALUES (?, ?, ?, ?)", id, sourceId, handle, now) })()
      return { ok: true, watch: xWatchFrom(one("SELECT w.*, s.area_id FROM x_watches w JOIN sources s ON s.id = w.source_id WHERE w.id = ?", id)!) }
    } catch (e) { return { ok: false, error: errorMessage(e) } } },
    async removeXWatch(params: unknown): Promise<Result<{}>> { try { const id = text(object(params)?.watchId, 200); if (!id || !one("SELECT id FROM x_watches WHERE id = ?", id)) return { ok: false, error: id ? "Unknown X watch" : "Invalid X-watch id" }; run("DELETE FROM x_watches WHERE id = ?", id); return { ok: true } } catch (e) { return { ok: false, error: errorMessage(e) } } },
    async setXWatchSchedule(params: unknown): Promise<Result<{ intervalMinutes: number }>> { try { const raw = Number(object(params)?.intervalMinutes); if (!Number.isFinite(raw) || raw < MIN_X_WATCH_INTERVAL_MINUTES || raw > MAX_X_WATCH_INTERVAL_MINUTES) return { ok: false, error: `Pick an interval between ${MIN_X_WATCH_INTERVAL_MINUTES} and ${MAX_X_WATCH_INTERVAL_MINUTES} minutes` }; const intervalMinutes = Math.floor(raw); putSetting("xWatchIntervalMinutes", String(intervalMinutes)); return { ok: true, intervalMinutes } } catch (e) { return { ok: false, error: errorMessage(e) } } },
    async xWatchState(params: unknown): Promise<Result<{ intervalMinutes: number; lastSuccessAt: number | null; watchCount: number }>> { try { if (!emptyObject(params)) return { ok: false, error: "Invalid X-watch state request" }; const last = Number(setting("xWatchLastSuccessAt")); return { ok: true, intervalMinutes: xInterval(), lastSuccessAt: Number.isFinite(last) && last > 0 ? last : null, watchCount: Number(one("SELECT COUNT(*) AS count FROM x_watches")?.count || 0) } } catch (e) { return { ok: false, error: errorMessage(e) } } },
    async checkXWatches(params: unknown): Promise<Result<{ results: ZooXWatchResult[]; checkedAt: number; succeeded: boolean }>> { try {
      if (activeXWatchCheck) return { ok: false, error: "An X-watch check is already running." }
      const body = object(params); if (!body) return { ok: false, error: "Invalid X-watch check request" }; const only = body.watchId === undefined ? null : text(body.watchId, 200); if (body.watchId !== undefined && !only) return { ok: false, error: "Invalid X-watch id" }
      const targets = xWatchRows().filter((row) => !only || String(row.id) === only); if (only && !targets.length) return { ok: false, error: "Unknown X watch" }
      activeXWatchCheck = true; const checkedAt = clock(); const results: ZooXWatchResult[] = []; let succeeded = targets.length > 0
      try { for (const row of targets) {
        const watch = xWatchFrom(row); run("UPDATE x_watches SET last_attempt_at = ? WHERE id = ?", checkedAt, watch.id)
        try {
          if (!deps.xWatchRun) throw new Error("X-watch collection is unavailable.")
          const collection = await deps.xWatchRun({ handle: watch.handle, since: watch.lastSuccessAt ?? null, now: checkedAt })
          let added = 0
          for (const finding of collection.findings) { const artifact = formatXArtifact(finding); if (!one("SELECT id FROM artifacts WHERE source_id = ? AND external_id = ?", watch.sourceId, artifact.externalId) && insertArtifact(watch.sourceId, "x-watch", artifact.externalId, artifact.title, artifact.content, artifact.url)) added++ }
          const note = added ? `Recorded ${added} new post${added === 1 ? "" : "s"}` : "No new posts"
          run("UPDATE x_watches SET last_success_at = ?, last_status = 'ok', last_note = ?" + (added ? ", last_artifact_at = ?" : "") + " WHERE id = ?", checkedAt, note, ...(added ? [checkedAt] : []), watch.id)
          run("UPDATE sources SET backfill_state = 'done', backfill_fetched = backfill_fetched + ?, backfill_error = NULL, backfill_completed_at = ? WHERE id = ?", added, checkedAt, watch.sourceId)
          results.push({ watchId: watch.id, label: watch.label, status: "ok", added, note })
        } catch (error) { succeeded = false; const note = errorMessage(error).slice(0, 2000); run("UPDATE x_watches SET last_status = 'error', last_note = ? WHERE id = ?", note, watch.id); run("UPDATE sources SET backfill_state = 'error', backfill_error = ? WHERE id = ?", note, watch.sourceId); results.push({ watchId: watch.id, label: watch.label, status: "error", added: 0, note }) }
      } } finally { activeXWatchCheck = false }
      if (succeeded) putSetting("xWatchLastSuccessAt", String(checkedAt))
      return { ok: true, results, checkedAt, succeeded }
    } catch (e) { activeXWatchCheck = false; return { ok: false, error: errorMessage(e) } } },
    async markXWatchExtracted(params: unknown): Promise<Result<{}>> { try { const id = text(object(params)?.watchId, 200); if (!id || !one("SELECT id FROM x_watches WHERE id = ?", id)) return { ok: false, error: id ? "Unknown X watch" : "Invalid X-watch id" }; run("UPDATE x_watches SET last_extract_at = ? WHERE id = ?", clock(), id); return { ok: true } } catch (e) { return { ok: false, error: errorMessage(e) } } },
    async status(params: unknown): Promise<Result<{ sources: ZooSource[]; artifactCount: number; insightCount: number; ideaCount: number; itemCount: number; passes: ZooPass[] }>> { try {
      if (!emptyObject(params)) return { ok: false, error: "Invalid status request" }
      const passes = rows("SELECT * FROM passes ORDER BY started_at DESC").map((r): ZooPass => ({ id: String(r.id), startedAt: Number(r.started_at), status: r.status as ZooPass["status"], ...(typeof r.note === "string" && r.note ? { note: r.note } : {}) }))
      return { ok: true, sources: rows("SELECT * FROM sources ORDER BY created_at DESC").map(sourceFrom), artifactCount: count("artifacts"), insightCount: count("insights"), ideaCount: count("ideas"), itemCount: count("items"), passes }
    } catch (e) { return { ok: false, error: errorMessage(e) } } },
    async connectLinear(params: unknown): Promise<Result<{ source: ZooSource }>> { try {
      const key = text(object(params)?.apiKey, 4096); if (!key) return { ok: false, error: "Invalid Linear API key" }
      const areaId = text(object(params)?.areaId, 200); if (areaId && !areaExists(areaId)) return { ok: false, error: "Unknown area" }
      const data = await gql(key, "query ZooViewer { viewer { name organization { name } } }"); const viewer = object(data.viewer); const organization = object(viewer?.organization); const label = text(organization?.name, 500) || text(viewer?.name, 500) || "Linear"
      const existing = one("SELECT * FROM sources WHERE kind = 'linear' ORDER BY created_at LIMIT 1"); const id = existing ? String(existing.id) : randomUUID()
      if (existing) run("UPDATE sources SET api_key = ?, label = ? WHERE id = ?", key, label, id); else run("INSERT INTO sources (id, kind, label, api_key, area_id, created_at, backfill_state, backfill_fetched) VALUES (?, 'linear', ?, ?, ?, ?, 'idle', 0)", id, label, key, areaId || null, clock())
      return { ok: true, source: sourceFrom(one("SELECT * FROM sources WHERE id = ?", id)!) }
    } catch (e) { return { ok: false, error: errorMessage(e) } } },
    async connectTranscripts(params: unknown): Promise<Result<{ source: ZooSource }>> { try {
      const folder = text(object(params)?.folder, 4096); if (!folder) return { ok: false, error: "Invalid transcript folder" }; const path = resolve(folder)
      const areaId = text(object(params)?.areaId, 200); if (areaId && !areaExists(areaId)) return { ok: false, error: "Unknown area" }
      if (!existsSync(path) || !statSync(path).isDirectory()) return { ok: false, error: "Transcript folder does not exist or is not a directory" }
      const existing = one("SELECT * FROM sources WHERE kind = 'transcripts' AND folder = ?", path); const id = existing ? String(existing.id) : randomUUID()
      if (!existing) run("INSERT INTO sources (id, kind, label, api_key, folder, area_id, created_at, backfill_state, backfill_fetched) VALUES (?, 'transcripts', ?, '', ?, ?, ?, 'idle', 0)", id, `${basename(path)} · ${path}`, path, areaId || null, clock())
      return { ok: true, source: sourceFrom(one("SELECT * FROM sources WHERE id = ?", id)!) }
    } catch (e) { return { ok: false, error: errorMessage(e) } } },
    async startBackfill(params: unknown): Promise<Result<{}>> { try { const id = text(object(params)?.sourceId, 200); const source = id ? one("SELECT id, kind FROM sources WHERE id = ?", id) : undefined; if (!source) return { ok: false, error: "Unknown source" }; if (source.kind === "repo-watch" || source.kind === "x-watch") return { ok: false, error: "Watch sources are checked, not backfilled" }; void backfill(id); return { ok: true } } catch (e) { return { ok: false, error: errorMessage(e) } } },
    async listArtifacts(params: unknown): Promise<Result<{ artifacts: ZooArtifactMeta[]; total: number }>> { try {
      const body = object(params); if (!body) return { ok: false, error: "Invalid artifact list request" }; const sourceId = body.sourceId === undefined ? undefined : text(body.sourceId, 200); if (body.sourceId !== undefined && !sourceId) return { ok: false, error: "Invalid sourceId" }
      const all = latestArtifacts(sourceId).sort((a, b) => Number(b.fetched_at) - Number(a.fetched_at)); const limit = number(body.limit, 100, 500) || 100; const offset = number(body.offset, 0, Number.MAX_SAFE_INTEGER)
      return { ok: true, artifacts: all.slice(offset, offset + limit).map(artifactFrom), total: all.length }
    } catch (e) { return { ok: false, error: errorMessage(e) } } },
    async getArtifact(params: unknown): Promise<Result<{ artifact: ZooArtifactMeta & { content: string } }>> { try { const id = text(object(params)?.id, 200); const row = id ? one("SELECT * FROM artifacts WHERE id = ?", id) : undefined; return row ? { ok: true, artifact: { ...artifactFrom(row), content: String(row.content) } } : { ok: false, error: id ? "Unknown artifact" : "Invalid artifact id" } } catch (e) { return { ok: false, error: errorMessage(e) } } },
    async exportForExtraction(params: unknown): Promise<Result<{ passId: string; bundle: string }>> { try {
      const body = object(params); if (!body) return { ok: false, error: "Invalid export request" }; const max = number(body.maxChars, DEFAULT_EXPORT_CHARS, MAX_EXPORT_CHARS); if (max < 1) return { ok: false, error: "maxChars must be positive" }
      // Scoping a run to an area keeps unassigned sources in the bundle: they
      // belong to no product yet, so every area may still learn from them.
      const areaId = text(body.areaId, 200); if (areaId && !areaExists(areaId)) return { ok: false, error: "Unknown area" }
      const scoped = areaId ? new Set(rows("SELECT id FROM sources WHERE area_id = ? OR area_id IS NULL", areaId).map((r) => String(r.id))) : null
      // A competitor-watch pass reads ONE source, and only what arrived since it
      // was last extracted — otherwise every check would re-summarize the lot.
      const sourceId = body.sourceId === undefined ? undefined : text(body.sourceId, 200)
      if (body.sourceId !== undefined && !sourceId) return { ok: false, error: "Invalid sourceId" }
      if (sourceId && !one("SELECT id FROM sources WHERE id = ?", sourceId)) return { ok: false, error: "Unknown source" }
      const since = body.sinceFetchedAt === undefined ? null : number(body.sinceFetchedAt, 0, Number.MAX_SAFE_INTEGER)
      const passId = pass(); let bundle = ""
      for (const row of latestArtifacts(sourceId).filter((row) => (!scoped || scoped.has(String(row.source_id))) && (since === null || Number(row.fetched_at) > since)).sort((a, b) => Number(b.fetched_at) - Number(a.fetched_at))) { const header = `\n\n[artifactId: ${row.id}]\nTitle: ${row.title}\n`; const remaining = max - bundle.length - header.length; if (remaining <= 0) break; bundle += header + String(row.content).slice(0, remaining) }
      return { ok: true, passId, bundle }
    } catch (e) { return { ok: false, error: errorMessage(e) } } },
    async recordInsights(params: unknown): Promise<Result<{ insightCount: number }>> { try {
      const body = object(params); const passId = text(body?.passId, 200); if (!passId || !Array.isArray(body?.insights)) return { ok: false, error: "Invalid insights request" }; if (!one("SELECT id FROM passes WHERE id = ?", passId)) return { ok: false, error: "Unknown pass" }; let insightCount = 0
      const areaId = text(body?.areaId, 200); if (areaId && !areaExists(areaId)) return { ok: false, error: "Unknown area" }
      database().transaction(() => { for (const raw of body.insights as unknown[]) { const item = object(raw); const title = text(item?.title, 2000); const summary = text(item?.summary, 20_000); if (!title || !summary) continue; const id = randomUUID(); const priority = item?.priority === undefined ? null : number(item.priority, 0, 1_000_000); run("INSERT INTO insights (id, pass_id, title, summary, priority, area_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)", id, passId, title, summary, priority, areaId || null, clock()); insightCount++; if (Array.isArray(item?.evidence)) for (const rawEvidence of item.evidence) { const evidence = object(rawEvidence); const artifactId = text(evidence?.artifactId, 200); const quote = text(evidence?.quote, 20_000); if (artifactId && quote && one("SELECT id FROM artifacts WHERE id = ?", artifactId)) run("INSERT OR IGNORE INTO evidence (insight_id, artifact_id, quote) VALUES (?, ?, ?)", id, artifactId, quote) } }; run("UPDATE passes SET status = 'done', note = NULL WHERE id = ?", passId) })()
      return { ok: true, insightCount }
    } catch (e) { return { ok: false, error: errorMessage(e) } } },
    async failPass(params: unknown): Promise<Result<{}>> { try { const body = object(params); const id = text(body?.passId, 200); const note = text(body?.error, 2000); if (!id || !note) return { ok: false, error: "Invalid pass failure" }; if (!one("SELECT id FROM passes WHERE id = ?", id)) return { ok: false, error: "Unknown pass" }; run("UPDATE passes SET status = 'error', note = ? WHERE id = ?", note, id); return { ok: true } } catch (e) { return { ok: false, error: errorMessage(e) } } },
    async listInsights(params: unknown): Promise<Result<{ insights: ZooInsight[] }>> { try { if (!emptyObject(params)) return { ok: false, error: "Invalid insights request" }; return { ok: true, insights: rows("SELECT i.* FROM insights i JOIN passes p ON p.id = i.pass_id ORDER BY p.started_at DESC, i.created_at DESC").map((r): ZooInsight => ({ id: String(r.id), passId: String(r.pass_id), title: String(r.title), summary: String(r.summary), ...(typeof r.priority === "number" ? { priority: r.priority } : {}), evidence: rows("SELECT artifact_id, quote FROM evidence WHERE insight_id = ?", r.id).map((e): ZooEvidence => ({ artifactId: String(e.artifact_id), quote: String(e.quote) })), ...sourceLabelsOf(String(r.id)), ...areaOf(r), createdAt: Number(r.created_at) })) } } catch (e) { return { ok: false, error: errorMessage(e) } } },
    async exportInsightsForSynthesis(params: unknown): Promise<Result<{ passId: string; bundle: string }>> { try {
      const body = object(params); if (!body) return { ok: false, error: "Invalid synthesis export request" }; const max = number(body.maxChars, DEFAULT_EXPORT_CHARS, MAX_EXPORT_CHARS); if (max < 1) return { ok: false, error: "maxChars must be positive" }
      const areaId = text(body.areaId, 200); if (areaId && !areaExists(areaId)) return { ok: false, error: "Unknown area" }
      const passId = pass(); let bundle = ""
      for (const insight of rows(areaId ? "SELECT * FROM insights WHERE area_id = ? OR area_id IS NULL ORDER BY created_at DESC" : "SELECT * FROM insights ORDER BY created_at DESC", ...(areaId ? [areaId] : []))) { const evidence = rows("SELECT e.quote, a.title FROM evidence e JOIN artifacts a ON a.id = e.artifact_id WHERE e.insight_id = ?", insight.id).map((e) => `Evidence (${e.title}): ${e.quote}`).join("\n"); const entry = `\n\n[insightId: ${insight.id}]\nTitle: ${insight.title}\nSummary: ${insight.summary}${evidence ? `\n${evidence}` : ""}\n`; if (bundle.length + entry.length > max) { bundle += entry.slice(0, Math.max(0, max - bundle.length)); break } bundle += entry }
      return { ok: true, passId, bundle }
    } catch (e) { return { ok: false, error: errorMessage(e) } } },
    async recordIdeas(params: unknown): Promise<Result<{ ideaCount: number }>> { try {
      const body = object(params); const passId = text(body?.passId, 200); if (!passId || !Array.isArray(body?.ideas)) return { ok: false, error: "Invalid ideas request" }; if (!one("SELECT id FROM passes WHERE id = ?", passId)) return { ok: false, error: "Unknown pass" }; let ideaCount = 0
      const areaId = text(body?.areaId, 200); if (areaId && !areaExists(areaId)) return { ok: false, error: "Unknown area" }
      for (const raw of body.ideas as unknown[]) { const idea = object(raw); const type = idea?.type; const title = text(idea?.title, 2000); const rationale = text(idea?.rationale, 20_000); if (typeof type !== "string" || !IDEA_TYPES.has(type as ZooIdeaType)) return { ok: false, error: "Invalid idea type" }; if (!title || !rationale || !Array.isArray(idea?.insightIds)) return { ok: false, error: "Invalid idea" } }
      database().transaction(() => { for (const raw of body.ideas as unknown[]) { const input = object(raw)!; const id = randomUUID(); run("INSERT INTO ideas (id, pass_id, type, title, rationale, status, area_id, created_at) VALUES (?, ?, ?, ?, ?, 'proposed', ?, ?)", id, passId, input.type, text(input.title)!, text(input.rationale)!, areaId || null, clock()); ideaCount++; for (const rawId of input.insightIds as unknown[]) { const insightId = text(rawId, 200); if (insightId && one("SELECT id FROM insights WHERE id = ?", insightId)) run("INSERT OR IGNORE INTO idea_insights (idea_id, insight_id) VALUES (?, ?)", id, insightId) } }; run("UPDATE passes SET status = 'done', note = NULL WHERE id = ?", passId) })()
      return { ok: true, ideaCount }
    } catch (e) { return { ok: false, error: errorMessage(e) } } },
    async listIdeas(params: unknown): Promise<Result<{ ideas: ZooIdea[] }>> { try { if (!emptyObject(params)) return { ok: false, error: "Invalid ideas request" }; return { ok: true, ideas: rows("SELECT * FROM ideas ORDER BY created_at DESC, rowid DESC").map(ideaFrom) } } catch (e) { return { ok: false, error: errorMessage(e) } } },
    async setIdeaStatus(params: unknown): Promise<Result<{ idea: ZooIdea }>> { try { const body = object(params); const id = text(body?.ideaId, 200); const status = body?.status; if (!id || typeof status !== "string" || !IDEA_STATUSES.has(status as ZooIdeaStatus)) return { ok: false, error: "Invalid idea status" }; if (!one("SELECT id FROM ideas WHERE id = ?", id)) return { ok: false, error: "Unknown idea" }; run("UPDATE ideas SET status = ? WHERE id = ?", status, id); return { ok: true, idea: ideaFrom(one("SELECT * FROM ideas WHERE id = ?", id)!) } } catch (e) { return { ok: false, error: errorMessage(e) } } },
    async createItem(params: unknown): Promise<Result<{ item: ZooItem }>> { try { const ideaId = text(object(params)?.ideaId, 200); const idea = ideaId ? one("SELECT * FROM ideas WHERE id = ?", ideaId) : undefined; if (!idea) return { ok: false, error: "Unknown idea" }; if (idea.item_id) return { ok: false, error: "Idea already has an item" }; const id = randomUUID(); const now = clock(); database().transaction(() => { run("INSERT INTO items (id, idea_id, title, stage, area_id, created_at, updated_at) VALUES (?, ?, ?, 'research', ?, ?, ?)", id, ideaId, idea.title, typeof idea.area_id === "string" && idea.area_id ? idea.area_id : null, now, now); run("UPDATE ideas SET status = 'promoted', item_id = ? WHERE id = ?", id, ideaId) })(); return { ok: true, item: itemFrom(one("SELECT * FROM items WHERE id = ?", id)!) } } catch (e) { return { ok: false, error: errorMessage(e) } } },
    async updateItem(params: unknown): Promise<Result<{ item: ZooItem }>> { try {
      const body = object(params); const id = text(body?.itemId, 200); if (!id || !one("SELECT id FROM items WHERE id = ?", id)) return { ok: false, error: id ? "Unknown item" : "Invalid item id" }; const stage = body?.stage; const session = body?.addSessionId; const decision = body?.addDecision === undefined ? undefined : object(body.addDecision)
      if (stage !== undefined && (typeof stage !== "string" || !ITEM_STAGES.has(stage as ZooItemStage))) return { ok: false, error: "Invalid item stage" }; if (session !== undefined && !text(session, 500)) return { ok: false, error: "Invalid session id" }; const actor = decision?.actor; const note = decision ? text(decision.note, 20_000) : null; if (decision && ((actor !== "user" && actor !== "agent") || !note)) return { ok: false, error: "Invalid decision" }; if (stage === undefined && session === undefined && !decision) return { ok: false, error: "No item update supplied" }
      database().transaction(() => { if (stage !== undefined) run("UPDATE items SET stage = ? WHERE id = ?", stage, id); if (session !== undefined) run("INSERT OR IGNORE INTO item_sessions (item_id, session_id) VALUES (?, ?)", id, text(session, 500)!); if (decision) run("INSERT INTO item_decisions (id, item_id, at, actor, note) VALUES (?, ?, ?, ?, ?)", randomUUID(), id, clock(), actor, note!); run("UPDATE items SET updated_at = ? WHERE id = ?", clock(), id) })()
      return { ok: true, item: itemFrom(one("SELECT * FROM items WHERE id = ?", id)!) }
    } catch (e) { return { ok: false, error: errorMessage(e) } } },
    async listItems(params: unknown): Promise<Result<{ items: ZooItem[] }>> { try { if (!emptyObject(params)) return { ok: false, error: "Invalid items request" }; return { ok: true, items: rows("SELECT * FROM items ORDER BY updated_at DESC, rowid DESC").map(itemFrom) } } catch (e) { return { ok: false, error: errorMessage(e) } } },
    async board(params: unknown): Promise<Result<{ sources: ZooSource[]; areas: ZooArea[]; counts: { artifacts: number; insights: number; ideas: number; items: number }; ideas: Record<string, unknown[]>; items: Record<string, unknown[]> }>> { try {
      if (!emptyObject(params)) return { ok: false, error: "Invalid board request" }
      const ideas: Record<string, unknown[]> = { proposed: [], promoted: [], dismissed: [] }; const items: Record<string, unknown[]> = { research: [], decision: [], building: [], review: [], shipped: [], dropped: [] }
      for (const row of rows("SELECT * FROM ideas ORDER BY created_at DESC, rowid DESC")) { const idea = ideaFrom(row); ideas[idea.status]!.push({ id: idea.id, type: idea.type, title: idea.title, status: idea.status, ...(idea.areaId ? { areaId: idea.areaId } : {}), ...(idea.itemId ? { itemId: idea.itemId } : {}) }) }
      for (const row of rows("SELECT * FROM items ORDER BY updated_at DESC, rowid DESC")) { const item = itemFrom(row); items[item.stage]!.push({ id: item.id, title: item.title, stage: item.stage, sessionIds: item.sessionIds, ...(item.areaId ? { areaId: item.areaId } : {}), updatedAt: item.updatedAt }) }
      return { ok: true, sources: rows("SELECT * FROM sources ORDER BY created_at DESC").map(sourceFrom), areas: rows("SELECT * FROM areas ORDER BY created_at, rowid").map(areaFrom), counts: { artifacts: count("artifacts"), insights: count("insights"), ideas: count("ideas"), items: count("items") }, ideas, items }
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
    async createIdea(params: unknown): Promise<Result<{ idea: ZooIdea }>> { try { const body = object(params); const type = body?.type; const title = text(body?.title, 2000); const rationale = text(body?.rationale, 20_000); if (typeof type !== "string" || !IDEA_TYPES.has(type as ZooIdeaType) || !title || !rationale) return { ok: false, error: "Invalid idea" }; const areaId = text(body?.areaId, 200); if (areaId && !areaExists(areaId)) return { ok: false, error: "Unknown area" }; const id = randomUUID(); database().transaction(() => { run("INSERT INTO ideas (id, pass_id, type, title, rationale, status, area_id, created_at) VALUES (?, NULL, ?, ?, ?, 'proposed', ?, ?)", id, type, title, rationale, areaId || null, clock()); if (Array.isArray(body?.insightIds)) for (const raw of body.insightIds) { const insightId = text(raw, 200); if (insightId && one("SELECT id FROM insights WHERE id = ?", insightId)) run("INSERT OR IGNORE INTO idea_insights (idea_id, insight_id) VALUES (?, ?)", id, insightId) } })(); return { ok: true, idea: ideaFrom(one("SELECT * FROM ideas WHERE id = ?", id)!) } } catch (e) { return { ok: false, error: errorMessage(e) } } },
    async addNote(params: unknown): Promise<Result<{ item: ZooItem }>> { const body = object(params); const note = text(body?.note, 20_000); if (!note) return { ok: false, error: "Invalid note" }; return this.updateItem({ itemId: body?.itemId, addDecision: { actor: "agent", note } }) },
  }
}
export type ZooManager = ReturnType<typeof createZooManager>
