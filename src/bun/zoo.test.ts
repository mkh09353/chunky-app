import { afterEach, expect, test } from "bun:test"
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Database } from "bun:sqlite"
import { createZooManager, type ZooManager } from "./zoo"
import { createWatchScheduler } from "./watchScheduler"

const cleanup: { path: string; zoo: ZooManager }[] = []
afterEach(() => {
  for (const entry of cleanup.splice(0)) {
    entry.zoo.close()
    Bun.spawnSync(["rm", "-rf", entry.path])
  }
})

function issue(identifier: string, title: string, description = "description") {
  return { id: `linear-${identifier}`, identifier, title, description, url: `https://linear.app/acme/issue/${identifier}`, createdAt: "2025-01-01T00:00:00.000Z", updatedAt: "2025-01-01T00:00:00.000Z", state: { name: "Open", type: "started" }, project: { name: "Zoo" }, labels: { nodes: [{ name: "customer" }] } }
}

function setup(pages: ReturnType<typeof issue>[][] = [[issue("ZOO-1", "First")]]) {
  const path = mkdtempSync(join(tmpdir(), "chunky-zoo-"))
  const fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body || "{}")) as { query?: string; variables?: { after?: string | null } }
    if (request.query?.includes("ZooViewer")) {
      const key = new Headers(init?.headers).get("Authorization")
      return key === "bad" ? new Response(JSON.stringify({ errors: [{ message: "Invalid token" }] }), { status: 200 }) : new Response(JSON.stringify({ data: { viewer: { name: "Ada", organization: { name: "Acme" } } } }))
    }
    const page = request.variables?.after ? Number(request.variables.after.replace("cursor-", "")) : 0
    const current = pages[page] || []
    return new Response(JSON.stringify({ data: { issues: { nodes: current, pageInfo: { hasNextPage: page + 1 < pages.length, endCursor: page + 1 < pages.length ? `cursor-${page + 1}` : null } } } }))
  }) as typeof fetch
  const zoo = createZooManager({ dbPath: join(path, "zoo.db"), fetch, seedDefaults: false })
  cleanup.push({ path, zoo })
  return zoo
}

async function backfillDone(zoo: ZooManager, sourceId: string) {
  expect((await zoo.startBackfill({ sourceId })).ok).toBe(true)
  for (let i = 0; i < 50; i++) {
    const result = await zoo.status({})
    if (result.ok && result.sources[0]?.backfill.state !== "running") return result
    await Bun.sleep(2)
  }
  throw new Error("backfill did not settle")
}

test("initializes schema lazily and connects Linear without exposing its key", async () => {
  const zoo = setup()
  expect(existsSync(join(cleanup[0]!.path, "zoo.db"))).toBe(false)
  const initial = await zoo.status({})
  expect(initial).toMatchObject({ ok: true, sources: [], artifactCount: 0, insightCount: 0, passes: [] })
  expect(existsSync(join(cleanup[0]!.path, "zoo.db"))).toBe(true)
  expect(await zoo.connectLinear({ apiKey: "bad" })).toMatchObject({ ok: false, error: "Invalid token" })
  const connected = await zoo.connectLinear({ apiKey: "good" })
  expect(connected).toMatchObject({ ok: true, source: { kind: "linear", label: "Acme", backfill: { state: "idle" } } })
  expect(JSON.stringify(connected)).not.toContain("good")
})

test("backfills paginated issues, dedupes unchanged content, and versions changes", async () => {
  const zoo = setup([[issue("ZOO-1", "First")], [issue("ZOO-2", "Second")]])
  const connected = await zoo.connectLinear({ apiKey: "good" }); if (!connected.ok) throw new Error(connected.error)
  const first = await backfillDone(zoo, connected.source.id)
  expect(first).toMatchObject({ ok: true, artifactCount: 2, sources: [{ backfill: { state: "done", fetched: 2 } }] })
  expect((await backfillDone(zoo, connected.source.id)).artifactCount).toBe(2)

  // The mock repeats its final page after two runs; change it by using a second
  // manager fixture with the same database and a changed issue response.
  zoo.close()
  const path = cleanup[0]!.path
  const changed = createZooManager({ dbPath: join(path, "zoo.db"), fetch: (async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { query?: string }
    return body.query?.includes("ZooIssues")
      ? new Response(JSON.stringify({ data: { issues: { nodes: [issue("ZOO-1", "First", "changed")], pageInfo: { hasNextPage: false, endCursor: null } } } }))
      : new Response(JSON.stringify({ data: { viewer: { name: "Ada" } } }))
  }) as typeof fetch })
  cleanup[0]!.zoo = changed
  await backfillDone(changed, connected.source.id)
  const listed = await changed.listArtifacts({})
  expect(listed).toMatchObject({ ok: true, total: 2 })
  if (listed.ok) {
    const artifact = await changed.getArtifact({ id: listed.artifacts.find((a) => a.externalId === "ZOO-1")!.id })
    expect(artifact).toMatchObject({ ok: true, artifact: { content: expect.stringContaining("changed") } })
  }
  expect((await changed.status({})).artifactCount).toBe(3)
})

test("exports bounded bundles and records insights with valid evidence only", async () => {
  const zoo = setup([[issue("ZOO-1", "A", "x".repeat(500))]])
  const connected = await zoo.connectLinear({ apiKey: "good" }); if (!connected.ok) throw new Error(connected.error)
  await backfillDone(zoo, connected.source.id)
  const exported = await zoo.exportForExtraction({ maxChars: 120 }); if (!exported.ok) throw new Error(exported.error)
  expect(exported.bundle.length).toBeLessThanOrEqual(120)
  expect(exported.bundle).toContain("artifactId")
  expect(await zoo.recordInsights({ passId: "missing", insights: [] })).toMatchObject({ ok: false, error: "Unknown pass" })
  const artifacts = await zoo.listArtifacts({}); if (!artifacts.ok) throw new Error(artifacts.error)
  expect(await zoo.recordInsights({ passId: exported.passId, insights: [{ title: "Need", summary: "Important", priority: 7, evidence: [{ artifactId: artifacts.artifacts[0]!.id, quote: "proof" }, { artifactId: "missing", quote: "drop" }] }] })).toEqual({ ok: true, insightCount: 1 })
  const insights = await zoo.listInsights({})
  expect(insights).toMatchObject({ ok: true, insights: [{ passId: exported.passId, title: "Need", priority: 7, evidence: [{ artifactId: artifacts.artifacts[0]!.id, quote: "proof" }] }] })
})

test("connects and versions transcript artifacts while skipping hidden and oversized files", async () => {
  const zoo = setup()
  const folder = join(cleanup[0]!.path, "transcripts")
  mkdirSync(join(folder, "nested"), { recursive: true })
  mkdirSync(join(folder, ".hidden"))
  writeFileSync(join(folder, "one.md"), "first")
  writeFileSync(join(folder, "nested", "two.txt"), "second")
  writeFileSync(join(folder, ".hidden", "skip.md"), "hidden")
  writeFileSync(join(folder, "large.txt"), "x".repeat(1_000_001))
  expect(await zoo.connectTranscripts({ folder: join(folder, "missing") })).toMatchObject({ ok: false })
  const source = await zoo.connectTranscripts({ folder }); if (!source.ok) throw new Error(source.error)
  expect((await zoo.connectTranscripts({ folder })).ok).toBe(true)
  expect((await backfillDone(zoo, source.source.id)).artifactCount).toBe(2)
  expect((await backfillDone(zoo, source.source.id)).artifactCount).toBe(2)
  writeFileSync(join(folder, "one.md"), "changed")
  await backfillDone(zoo, source.source.id)
  expect((await zoo.status({})).artifactCount).toBe(3)
})

test("synthesizes insights into ideas and promotes them to mutable items", async () => {
  const zoo = setup()
  const connected = await zoo.connectLinear({ apiKey: "good" }); if (!connected.ok) throw new Error(connected.error)
  await backfillDone(zoo, connected.source.id)
  const artifact = await zoo.listArtifacts({}); if (!artifact.ok) throw new Error(artifact.error)
  const extraction = await zoo.exportForExtraction({}); if (!extraction.ok) throw new Error(extraction.error)
  await zoo.recordInsights({ passId: extraction.passId, insights: [{ title: "Signal", summary: "A signal", evidence: [{ artifactId: artifact.artifacts[0]!.id, quote: "proof" }] }] })
  const insight = await zoo.listInsights({}); if (!insight.ok) throw new Error(insight.error)
  const synthesis = await zoo.exportInsightsForSynthesis({ maxChars: 80 }); if (!synthesis.ok) throw new Error(synthesis.error)
  expect(synthesis.bundle.length).toBeLessThanOrEqual(80)
  expect(await zoo.recordIdeas({ passId: "unknown", ideas: [] })).toMatchObject({ ok: false, error: "Unknown pass" })
  expect(await zoo.recordIdeas({ passId: synthesis.passId, ideas: [{ type: "wrong", title: "Bad", rationale: "No", insightIds: [] }] })).toMatchObject({ ok: false, error: "Invalid idea type" })
  expect(await zoo.recordIdeas({ passId: synthesis.passId, ideas: [{ type: "build", title: "Build it", rationale: "Demand", insightIds: [insight.insights[0]!.id, "missing"] }] })).toEqual({ ok: true, ideaCount: 1 })
  const ideas = await zoo.listIdeas({}); if (!ideas.ok) throw new Error(ideas.error)
  expect(ideas.ideas[0]).toMatchObject({ type: "build", status: "proposed", insightIds: [insight.insights[0]!.id] })
  const dismissed = await zoo.setIdeaStatus({ ideaId: ideas.ideas[0]!.id, status: "dismissed" })
  expect(dismissed).toMatchObject({ ok: true, idea: { status: "dismissed" } })
  const item = await zoo.createItem({ ideaId: ideas.ideas[0]!.id }); if (!item.ok) throw new Error(item.error)
  expect(item.item).toMatchObject({ stage: "research", sessionIds: [], decisions: [] })
  expect(await zoo.createItem({ ideaId: ideas.ideas[0]!.id })).toMatchObject({ ok: false, error: "Idea already has an item" })
  expect(await zoo.updateItem({ itemId: item.item.id, stage: "nope" })).toMatchObject({ ok: false, error: "Invalid item stage" })
  const updated = await zoo.updateItem({ itemId: item.item.id, stage: "building", addSessionId: "session-1", addDecision: { actor: "user", note: "Ship it" } })
  expect(updated).toMatchObject({ ok: true, item: { stage: "building", sessionIds: ["session-1"], decisions: [{ actor: "user", note: "Ship it" }] } })
  expect(await zoo.listItems({})).toMatchObject({ ok: true, items: [{ id: item.item.id }] })
  expect(await zoo.status({})).toMatchObject({ ok: true, ideaCount: 1, itemCount: 1 })
})

// ---- Areas: multi-product scoping over ONE board ---------------------------

test("areas are CRUD-able, scope new rows, and never partition existing data", async () => {
  const zoo = setup()
  expect(await zoo.listAreas({})).toEqual({ ok: true, areas: [] })
  expect(await zoo.listRepoWatches({})).toMatchObject({ ok: true, watches: [] })
  expect(await zoo.createArea({ name: "   " })).toMatchObject({ ok: false, error: "Invalid area name" })
  expect(await zoo.createArea({ name: "Payments", repoPaths: "/tmp/pay" })).toMatchObject({ ok: false, error: "Invalid area repo paths" })

  const payments = await zoo.createArea({ name: "Payments", repoPaths: ["/tmp/pay"] })
  if (!payments.ok) throw new Error(payments.error)
  expect(payments.area).toMatchObject({ name: "Payments", repoPaths: ["/tmp/pay"] })
  expect(await zoo.createArea({ name: "payments" })).toMatchObject({ ok: false, error: "An area with that name already exists" })
  const growth = await zoo.createArea({ name: "Growth" })
  if (!growth.ok) throw new Error(growth.error)
  expect(growth.area.repoPaths).toBeUndefined()

  const renamed = await zoo.updateArea({ areaId: growth.area.id, name: "Growth & Onboarding", repoPaths: ["/tmp/growth"] })
  expect(renamed).toMatchObject({ ok: true, area: { name: "Growth & Onboarding", repoPaths: ["/tmp/growth"] } })
  expect(await zoo.updateArea({ areaId: "nope", name: "x" })).toMatchObject({ ok: false, error: "Unknown area" })
  expect(await zoo.updateArea({ areaId: growth.area.id })).toMatchObject({ ok: false, error: "No area update supplied" })

  // A source connected inside an area belongs to it; an unknown area is refused.
  expect(await zoo.connectLinear({ apiKey: "good", areaId: "nope" })).toMatchObject({ ok: false, error: "Unknown area" })
  const connected = await zoo.connectLinear({ apiKey: "good", areaId: payments.area.id })
  if (!connected.ok) throw new Error(connected.error)
  expect(connected.source.areaId).toBe(payments.area.id)
  await backfillDone(zoo, connected.source.id)

  // Insights and ideas recorded inside an area are stamped with it, and the
  // item a promotion creates inherits the idea's area.
  const artifacts = await zoo.listArtifacts({}); if (!artifacts.ok) throw new Error(artifacts.error)
  const extraction = await zoo.exportForExtraction({ areaId: payments.area.id }); if (!extraction.ok) throw new Error(extraction.error)
  expect(await zoo.recordInsights({ passId: extraction.passId, areaId: "nope", insights: [] })).toMatchObject({ ok: false, error: "Unknown area" })
  await zoo.recordInsights({ passId: extraction.passId, areaId: payments.area.id, insights: [{ title: "Declines", summary: "Silent failures", evidence: [{ artifactId: artifacts.artifacts[0]!.id, quote: "it vanished" }] }] })
  const insights = await zoo.listInsights({}); if (!insights.ok) throw new Error(insights.error)
  expect(insights.insights[0]?.areaId).toBe(payments.area.id)

  const synthesis = await zoo.exportInsightsForSynthesis({ areaId: payments.area.id }); if (!synthesis.ok) throw new Error(synthesis.error)
  expect(synthesis.bundle).toContain("Declines")
  await zoo.recordIdeas({ passId: synthesis.passId, areaId: payments.area.id, ideas: [{ type: "build", title: "Retry declines", rationale: "Costly", insightIds: [insights.insights[0]!.id] }] })
  const ideas = await zoo.listIdeas({}); if (!ideas.ok) throw new Error(ideas.error)
  expect(ideas.ideas[0]?.areaId).toBe(payments.area.id)
  const item = await zoo.createItem({ ideaId: ideas.ideas[0]!.id }); if (!item.ok) throw new Error(item.error)
  expect(item.item.areaId).toBe(payments.area.id)

  // Reassignment moves the idea and the item it became together.
  expect(await zoo.assignArea({ kind: "team", id: item.item.id, areaId: null })).toMatchObject({ ok: false, error: "Invalid area assignment kind" })
  expect(await zoo.assignArea({ kind: "item", id: "nope", areaId: null })).toMatchObject({ ok: false, error: "Unknown item" })
  expect(await zoo.assignArea({ kind: "item", id: item.item.id, areaId: "nope" })).toMatchObject({ ok: false, error: "Unknown area" })
  expect(await zoo.assignArea({ kind: "item", id: item.item.id, areaId: growth.area.id })).toEqual({ ok: true })
  const moved = await zoo.listItems({}); if (!moved.ok) throw new Error(moved.error)
  expect(moved.items[0]?.areaId).toBe(growth.area.id)
  const movedIdea = await zoo.listIdeas({}); if (!movedIdea.ok) throw new Error(movedIdea.error)
  expect(movedIdea.ideas[0]?.areaId).toBe(growth.area.id)
  expect(await zoo.assignArea({ kind: "idea", id: ideas.ideas[0]!.id, areaId: null })).toEqual({ ok: true })
  expect((await zoo.listItems({}) as { items: { areaId?: string }[] }).items[0]?.areaId).toBeUndefined()

  // Deleting an area unassigns its rows; nothing on the board disappears.
  expect(await zoo.deleteArea({ areaId: "nope" })).toMatchObject({ ok: false, error: "Unknown area" })
  expect(await zoo.deleteArea({ areaId: payments.area.id })).toEqual({ ok: true })
  expect(await zoo.listAreas({})).toMatchObject({ ok: true, areas: [{ name: "Growth & Onboarding" }] })
  // The agent-facing board summary carries areas too, so a Factory conversation
  // can reason about which product something belongs to.
  const summary = await zoo.board({}); if (!summary.ok) throw new Error(summary.error)
  expect(summary.areas).toMatchObject([{ name: "Growth & Onboarding" }])
  expect(summary.items.decision?.[0] ?? summary.items.research?.[0]).toMatchObject({ title: "Retry declines" })

  const survivors = await zoo.status({}); if (!survivors.ok) throw new Error(survivors.error)
  expect(survivors).toMatchObject({ insightCount: 1, ideaCount: 1, itemCount: 1 })
  expect(survivors.sources[0]?.areaId).toBeUndefined()
  expect(survivors.sources).toHaveLength(1)
})

test("an area-scoped run still sees unassigned sources and insights", async () => {
  const zoo = setup()
  const area = await zoo.createArea({ name: "Payments" }); if (!area.ok) throw new Error(area.error)
  // A source connected BEFORE the area existed has no areaId at all.
  const connected = await zoo.connectLinear({ apiKey: "good" }); if (!connected.ok) throw new Error(connected.error)
  await backfillDone(zoo, connected.source.id)
  const scoped = await zoo.exportForExtraction({ areaId: area.area.id }); if (!scoped.ok) throw new Error(scoped.error)
  expect(scoped.bundle).toContain("First")

  const artifacts = await zoo.listArtifacts({}); if (!artifacts.ok) throw new Error(artifacts.error)
  await zoo.recordInsights({ passId: scoped.passId, insights: [{ title: "Unscoped signal", summary: "From before areas", evidence: [{ artifactId: artifacts.artifacts[0]!.id, quote: "proof" }] }] })
  const synthesis = await zoo.exportInsightsForSynthesis({ areaId: area.area.id }); if (!synthesis.ok) throw new Error(synthesis.error)
  expect(synthesis.bundle).toContain("Unscoped signal")
})

test("opens a board written before areas existed and keeps every row", async () => {
  const path = mkdtempSync(join(tmpdir(), "chunky-zoo-legacy-"))
  const dbPath = join(path, "zoo.db")
  // The original schema, verbatim: no areas table and no area_id anywhere.
  const legacy = new Database(dbPath)
  legacy.run("CREATE TABLE sources (id TEXT PRIMARY KEY, kind TEXT NOT NULL, label TEXT NOT NULL, api_key TEXT NOT NULL, created_at INTEGER NOT NULL, backfill_state TEXT NOT NULL, backfill_fetched INTEGER NOT NULL DEFAULT 0, backfill_error TEXT, backfill_completed_at INTEGER)")
  legacy.run("CREATE TABLE artifacts (id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES sources(id), kind TEXT NOT NULL, external_id TEXT NOT NULL, title TEXT NOT NULL, url TEXT, content TEXT NOT NULL, content_hash TEXT NOT NULL, fetched_at INTEGER NOT NULL, UNIQUE(source_id, external_id, content_hash))")
  legacy.run("CREATE TABLE passes (id TEXT PRIMARY KEY, started_at INTEGER NOT NULL, status TEXT NOT NULL, note TEXT)")
  legacy.run("CREATE TABLE insights (id TEXT PRIMARY KEY, pass_id TEXT NOT NULL REFERENCES passes(id), title TEXT NOT NULL, summary TEXT NOT NULL, priority INTEGER, created_at INTEGER NOT NULL)")
  legacy.run("CREATE TABLE evidence (insight_id TEXT NOT NULL REFERENCES insights(id), artifact_id TEXT NOT NULL REFERENCES artifacts(id), quote TEXT NOT NULL, PRIMARY KEY(insight_id, artifact_id, quote))")
  // pass_id NOT NULL: the pre-existing rebuild migration has to run too.
  legacy.run("CREATE TABLE ideas (id TEXT PRIMARY KEY, pass_id TEXT NOT NULL REFERENCES passes(id), type TEXT NOT NULL, title TEXT NOT NULL, rationale TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL, item_id TEXT)")
  legacy.run("CREATE TABLE idea_insights (idea_id TEXT NOT NULL REFERENCES ideas(id), insight_id TEXT NOT NULL REFERENCES insights(id), PRIMARY KEY(idea_id, insight_id))")
  legacy.run("CREATE TABLE items (id TEXT PRIMARY KEY, idea_id TEXT NOT NULL UNIQUE REFERENCES ideas(id), title TEXT NOT NULL, stage TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)")
  legacy.run("CREATE TABLE item_sessions (item_id TEXT NOT NULL REFERENCES items(id), session_id TEXT NOT NULL, PRIMARY KEY(item_id, session_id))")
  legacy.run("CREATE TABLE item_decisions (id TEXT PRIMARY KEY, item_id TEXT NOT NULL REFERENCES items(id), at INTEGER NOT NULL, actor TEXT NOT NULL, note TEXT NOT NULL)")
  legacy.run("INSERT INTO sources VALUES ('s-1', 'linear', 'Acme', 'key', 1000, 'done', 3, NULL, 1500)")
  legacy.run("INSERT INTO artifacts VALUES ('a-1', 's-1', 'linear_issue', 'ZOO-1', 'Old issue', NULL, 'body', 'h1', 1200)")
  legacy.run("INSERT INTO passes VALUES ('p-1', 1300, 'done', NULL)")
  legacy.run("INSERT INTO insights VALUES ('i-1', 'p-1', 'Old signal', 'Recorded before areas', 2, 1400)")
  legacy.run("INSERT INTO evidence VALUES ('i-1', 'a-1', 'the old quote')")
  legacy.run("INSERT INTO ideas VALUES ('d-1', 'p-1', 'build', 'Old idea', 'Old rationale', 'promoted', 1450, 't-1')")
  legacy.run("INSERT INTO idea_insights VALUES ('d-1', 'i-1')")
  legacy.run("INSERT INTO items VALUES ('t-1', 'd-1', 'Old idea', 'decision', 1460, 1470)")
  legacy.run("INSERT INTO item_decisions VALUES ('dec-1', 't-1', 1465, 'user', 'Promoted for research')")
  legacy.close()

  const zoo = createZooManager({ dbPath })
  cleanup.push({ path, zoo })

  const status = await zoo.status({}); if (!status.ok) throw new Error(status.error)
  expect(status).toMatchObject({ artifactCount: 1, insightCount: 1, ideaCount: 1, itemCount: 1 })
  expect(status.sources[0]).toMatchObject({ id: "s-1", label: "Acme" })
  expect(status.sources[0]?.areaId).toBeUndefined()
  const insights = await zoo.listInsights({}); if (!insights.ok) throw new Error(insights.error)
  expect(insights.insights[0]).toMatchObject({ id: "i-1", title: "Old signal", evidence: [{ artifactId: "a-1", quote: "the old quote" }] })
  expect(insights.insights[0]?.areaId).toBeUndefined()
  const ideas = await zoo.listIdeas({}); if (!ideas.ok) throw new Error(ideas.error)
  expect(ideas.ideas[0]).toMatchObject({ id: "d-1", insightIds: ["i-1"], itemId: "t-1" })
  expect(ideas.ideas[0]?.areaId).toBeUndefined()
  const items = await zoo.listItems({}); if (!items.ok) throw new Error(items.error)
  expect(items.items[0]).toMatchObject({ id: "t-1", stage: "decision", decisions: [{ actor: "user", note: "Promoted for research" }] })
  expect(items.items[0]?.areaId).toBeUndefined()
  expect(await zoo.listAreas({})).toEqual({ ok: true, areas: [] })
  expect(await zoo.listRepoWatches({})).toMatchObject({ ok: true, watches: [] })

  // The legacy rows are assignable once an area exists, and unassignable again.
  const area = await zoo.createArea({ name: "Payments" }); if (!area.ok) throw new Error(area.error)
  expect(await zoo.assignArea({ kind: "item", id: "t-1", areaId: area.area.id })).toEqual({ ok: true })
  expect((await zoo.listItems({}) as { items: { areaId?: string }[] }).items[0]?.areaId).toBe(area.area.id)
  expect((await zoo.listIdeas({}) as { ideas: { areaId?: string }[] }).ideas[0]?.areaId).toBe(area.area.id)
})

test("seeds exactly four watches only for a genuinely new database and never recreates removals", async () => {
  const path = mkdtempSync(join(tmpdir(), "chunky-zoo-seed-"))
  const dbPath = join(path, "zoo.db")
  let networkCalls = 0
  const deps = { dbPath, fetch: (async () => { networkCalls++; return new Response("[]") }) as typeof fetch, now: () => 1234 }
  const first = createZooManager(deps)
  cleanup.push({ path, zoo: first })
  const seeded = await first.listRepoWatches({}); if (!seeded.ok) throw new Error(seeded.error)
  expect(seeded.watches.map((watch) => watch.label)).toEqual([
    "pingdotgg/t3code",
    "craft-ai-agents/craft-agents-oss",
    "Emanuele-web04/synara",
    "get-bb/bb",
  ])
  expect(seeded.watches.every((watch) => watch.areaId === undefined && watch.lastCheckAt === undefined)).toBe(true)
  expect(networkCalls).toBe(0)
  const ids = seeded.watches.map((watch) => watch.id)
  expect(await first.addRepoWatch({ repo: "PINGDOTGG/T3CODE" })).toMatchObject({ ok: false, error: "That repository is already watched" })
  first.close()

  const reopened = createZooManager(deps)
  cleanup[0]!.zoo = reopened
  const stable = await reopened.listRepoWatches({}); if (!stable.ok) throw new Error(stable.error)
  expect(stable.watches.map((watch) => watch.id)).toEqual(ids)
  await reopened.removeRepoWatch({ watchId: stable.watches[0]!.id })
  reopened.close()

  const afterRemoval = createZooManager(deps)
  cleanup[0]!.zoo = afterRemoval
  const after = await afterRemoval.listRepoWatches({}); if (!after.ok) throw new Error(after.error)
  expect(after.watches).toHaveLength(3)
  expect(after.watches.map((watch) => watch.id)).toEqual(ids.slice(1))
  expect(networkCalls).toBe(0)
})

test("does not seed a pre-existing empty database", async () => {
  const path = mkdtempSync(join(tmpdir(), "chunky-zoo-existing-empty-"))
  const dbPath = join(path, "zoo.db")
  new Database(dbPath).close()
  const zoo = createZooManager({ dbPath })
  cleanup.push({ path, zoo })
  const watches = await zoo.listRepoWatches({}); if (!watches.ok) throw new Error(watches.error)
  expect(watches.watches).toEqual([])
})

// ---- Competitor watch: a watch is a source, its delta is an artifact --------

const DAY_MS = 86_400_000

/** A GitHub stub for the six endpoints one check touches. */
function githubFetch(state: { releases?: unknown[]; tags?: unknown[]; pulls?: unknown[]; rateLimited?: boolean }) {
  return (async (url: RequestInfo | URL) => {
    const href = String(url)
    if (state.rateLimited) return new Response("{}", { status: 403, headers: { "x-ratelimit-remaining": "0" } })
    if (href.endsWith("/repos/sst/opencode")) return new Response(JSON.stringify({ default_branch: "main", description: "Terminal agent" }))
    if (href.includes("/releases")) return new Response(JSON.stringify(state.releases ?? []))
    if (href.includes("/tags")) return new Response(JSON.stringify(state.tags ?? []))
    if (href.includes("/pulls")) return new Response(JSON.stringify(state.pulls ?? []))
    return new Response("[]")
  }) as typeof fetch
}

test("pingdotgg/t3code baselines tags, emits one later tag-only nightly delta, and preserves baseline on skips", async () => {
  const path = mkdtempSync(join(tmpdir(), "chunky-zoo-t3code-"))
  let clock = Date.UTC(2026, 0, 10, 8, 0)
  const state = { tags: [{ name: "v0.1.0" }], rateLimited: false }
  const fetch = (async (url: RequestInfo | URL) => {
    const href = String(url)
    if (state.rateLimited) return new Response("{}", { status: 403, headers: { "x-ratelimit-remaining": "0" } })
    if (href.endsWith("/repos/pingdotgg/t3code")) return new Response(JSON.stringify({ default_branch: "main" }))
    if (href.includes("/releases")) return new Response("[]")
    if (href.includes("/tags")) return new Response(JSON.stringify(state.tags))
    return new Response("[]")
  }) as typeof fetch
  const zoo = createZooManager({ dbPath: join(path, "zoo.db"), fetch, githubToken: null, now: () => clock, seedDefaults: false })
  cleanup.push({ path, zoo })
  const added = await zoo.addRepoWatch({ repo: "pingdotgg/t3code" }); if (!added.ok) throw new Error(added.error)

  const baseline = await zoo.checkRepoWatches({}); if (!baseline.ok) throw new Error(baseline.error)
  expect(baseline.results[0]).toMatchObject({ added: 0, status: "ok" })
  expect((await zoo.listArtifacts({}) as { total: number }).total).toBe(0)

  clock += DAY_MS
  state.tags = [{ name: "v0.2.0" }, { name: "v0.1.0" }]
  state.rateLimited = true
  expect(await zoo.checkRepoWatches({})).toMatchObject({ ok: true, results: [{ status: "skipped", added: 0 }] })

  clock += DAY_MS
  state.rateLimited = false
  const nightly = await zoo.checkRepoWatches({}); if (!nightly.ok) throw new Error(nightly.error)
  expect(nightly.results[0]).toMatchObject({ added: 1, note: "Recorded 1 tag" })
  const artifacts = await zoo.listArtifacts({}); if (!artifacts.ok) throw new Error(artifacts.error)
  expect(artifacts).toMatchObject({ total: 1, artifacts: [{ title: "pingdotgg/t3code — 1 tag" }] })

  clock += DAY_MS
  const repeat = await zoo.checkRepoWatches({}); if (!repeat.ok) throw new Error(repeat.error)
  expect(repeat.results[0]).toMatchObject({ added: 0, note: "No new activity" })
  expect((await zoo.listArtifacts({}) as { total: number }).total).toBe(1)
})

function watchSetup(state: Parameters<typeof githubFetch>[0], now: () => number) {
  const path = mkdtempSync(join(tmpdir(), "chunky-zoo-watch-"))
  const zoo = createZooManager({ dbPath: join(path, "zoo.db"), fetch: githubFetch(state), githubToken: null, now, seedDefaults: false })
  cleanup.push({ path, zoo })
  return zoo
}

test("watches a repo, turns its delta into an artifact, and never re-reports it", async () => {
  const state: Parameters<typeof githubFetch>[0] = { releases: [], tags: [{ name: "v1.0.0" }], pulls: [] }
  let clock = Date.UTC(2026, 0, 10, 8, 0)
  const zoo = watchSetup(state, () => clock)

  expect(await zoo.addRepoWatch({ repo: "not a repo" })).toMatchObject({ ok: false, error: "Enter a repository as owner/name" })
  const added = await zoo.addRepoWatch({ repo: "https://github.com/sst/opencode" })
  if (!added.ok) throw new Error(added.error)
  expect(added.watch).toMatchObject({ owner: "sst", name: "opencode", label: "sst/opencode" })
  expect(await zoo.addRepoWatch({ repo: "sst/opencode" })).toMatchObject({ ok: false, error: "That repository is already watched" })

  // The watch shows up as an ordinary source, so the rest of the pipeline needs
  // no special case for it.
  const status = await zoo.status({}); if (!status.ok) throw new Error(status.error)
  expect(status.sources[0]).toMatchObject({ kind: "repo-watch", label: "sst/opencode" })

  // First check: a tag baseline is captured, but tags are not reported as news.
  const first = await zoo.checkRepoWatches({}); if (!first.ok) throw new Error(first.error)
  expect(first.results).toEqual([{ watchId: added.watch.id, label: "sst/opencode", status: "ok", added: 0, note: "No new activity" }])
  expect((await zoo.listArtifacts({}) as { total: number }).total).toBe(0)

  // Second check, after they ship: one artifact, formatted for extraction.
  clock += DAY_MS
  state.releases = [{ tag_name: "v1.1.0", name: "1.1.0", published_at: new Date(clock - 3600_000).toISOString(), html_url: "https://gh/r/1", body: "Subagents" }]
  state.tags = [{ name: "v1.1.0" }, { name: "v1.0.0" }]
  const second = await zoo.checkRepoWatches({}); if (!second.ok) throw new Error(second.error)
  expect(second.results[0]).toMatchObject({ status: "ok", added: 1, note: "Recorded 1 release, 1 tag" })
  const artifacts = await zoo.listArtifacts({}); if (!artifacts.ok) throw new Error(artifacts.error)
  expect(artifacts.total).toBe(1)
  expect(artifacts.artifacts[0]).toMatchObject({ kind: "repo-watch", title: "sst/opencode — 1 release, 1 tag" })
  const artifact = await zoo.getArtifact({ id: artifacts.artifacts[0]!.id }); if (!artifact.ok) throw new Error(artifact.error)
  expect(artifact.artifact.content).toContain("Competitor activity: sst/opencode")
  expect(artifact.artifact.content).toContain("Subagents")

  // Third check with nothing new: no artifact, and the release is not repeated.
  clock += DAY_MS
  const third = await zoo.checkRepoWatches({}); if (!third.ok) throw new Error(third.error)
  expect(third.results[0]).toMatchObject({ status: "ok", added: 0, note: "No new activity" })
  expect((await zoo.listArtifacts({}) as { total: number }).total).toBe(1)

  const watches = await zoo.listRepoWatches({}); if (!watches.ok) throw new Error(watches.error)
  expect(watches.watches[0]).toMatchObject({ lastStatus: "ok", lastNote: "No new activity" })
  expect(watches.watches[0]?.lastCheckAt).toBe(clock)
  expect(watches.hour).toBe(8)
  expect(watches.lastRunAt).toBe(clock)
})

test("a rate-limited check records a skip and keeps the delta window", async () => {
  const state: Parameters<typeof githubFetch>[0] = { releases: [], tags: [], pulls: [] }
  let clock = Date.UTC(2026, 0, 10, 8, 0)
  const zoo = watchSetup(state, () => clock)
  const added = await zoo.addRepoWatch({ repo: "sst/opencode" }); if (!added.ok) throw new Error(added.error)
  await zoo.checkRepoWatches({})
  const cursor = (await zoo.listRepoWatches({}) as { watches: { lastCheckAt?: number }[] }).watches[0]?.lastCheckAt

  clock += DAY_MS
  state.rateLimited = true
  const limited = await zoo.checkRepoWatches({}); if (!limited.ok) throw new Error(limited.error)
  expect(limited.results[0]).toMatchObject({ status: "skipped", added: 0 })
  expect(limited.results[0]?.note).toContain("rate limit")
  const after = await zoo.listRepoWatches({}); if (!after.ok) throw new Error(after.error)
  // The cursor did NOT move: the missed window is picked up by the next check.
  expect(after.watches[0]?.lastCheckAt).toBe(cursor)
  expect(after.watches[0]?.lastStatus).toBe("skipped")

  // And the very next check still sees everything since the last good cursor.
  clock += DAY_MS
  state.rateLimited = false
  state.releases = [{ tag_name: "v2", name: "2.0", published_at: new Date(clock - 3600_000).toISOString(), html_url: "", body: "" }]
  const recovered = await zoo.checkRepoWatches({}); if (!recovered.ok) throw new Error(recovered.error)
  expect(recovered.results[0]).toMatchObject({ status: "ok", added: 1 })
})

test("manager guard prevents single-watch and all-watch checks from racing", async () => {
  const path = mkdtempSync(join(tmpdir(), "chunky-zoo-watch-race-"))
  let release: (() => void) | undefined
  const gate = new Promise<void>((resolve) => { release = resolve })
  let entered = false
  const fetch = (async (url: RequestInfo | URL) => {
    const href = String(url)
    if (href.endsWith("/repos/sst/opencode")) {
      entered = true
      await gate
      return new Response(JSON.stringify({ default_branch: "main" }))
    }
    return new Response("[]")
  }) as typeof fetch
  const zoo = createZooManager({ dbPath: join(path, "zoo.db"), fetch, githubToken: null, seedDefaults: false })
  cleanup.push({ path, zoo })
  const added = await zoo.addRepoWatch({ repo: "sst/opencode" }); if (!added.ok) throw new Error(added.error)
  const first = zoo.checkRepoWatches({ watchId: added.watch.id })
  for (let i = 0; i < 20 && !entered; i++) await Bun.sleep(1)
  expect(entered).toBe(true)
  expect(await zoo.checkRepoWatches({})).toEqual({ ok: false, error: "A competitor-watch check is already running." })
  release?.()
  expect((await first).ok).toBe(true)
})

test("scopes an extraction pass to one watch and to what arrived since its last one", async () => {
  const state: Parameters<typeof githubFetch>[0] = { releases: [], tags: [], pulls: [] }
  let clock = Date.UTC(2026, 0, 10, 8, 0)
  const zoo = watchSetup(state, () => clock)
  const area = await zoo.createArea({ name: "Agents" }); if (!area.ok) throw new Error(area.error)
  const watch = await zoo.addRepoWatch({ repo: "sst/opencode", areaId: area.area.id }); if (!watch.ok) throw new Error(watch.error)
  expect(watch.watch.areaId).toBe(area.area.id)

  state.releases = [{ tag_name: "v1", name: "1.0", published_at: new Date(clock - 3600_000).toISOString(), html_url: "", body: "First" }]
  await zoo.checkRepoWatches({})
  const firstRun = clock

  clock += DAY_MS
  state.releases = [{ tag_name: "v2", name: "2.0", published_at: new Date(clock - 3600_000).toISOString(), html_url: "", body: "Second" }]
  await zoo.checkRepoWatches({})

  const all = await zoo.exportForExtraction({ sourceId: watch.watch.sourceId }); if (!all.ok) throw new Error(all.error)
  expect(all.bundle).toContain("First")
  expect(all.bundle).toContain("Second")

  const fresh = await zoo.exportForExtraction({ sourceId: watch.watch.sourceId, sinceFetchedAt: firstRun })
  if (!fresh.ok) throw new Error(fresh.error)
  expect(fresh.bundle).toContain("Second")
  expect(fresh.bundle).not.toContain("First")

  expect(await zoo.exportForExtraction({ sourceId: "nope" })).toMatchObject({ ok: false, error: "Unknown source" })

  // Insights recorded from that bundle carry the watch label, so an Inbox card
  // can say which competitor it is about.
  const artifacts = await zoo.listArtifacts({ sourceId: watch.watch.sourceId }); if (!artifacts.ok) throw new Error(artifacts.error)
  await zoo.recordInsights({
    passId: fresh.passId,
    areaId: area.area.id,
    insights: [{ title: "They shipped subagents", summary: "Applies to us", evidence: [{ artifactId: artifacts.artifacts[0]!.id, quote: "Second" }] }],
  })
  const insights = await zoo.listInsights({}); if (!insights.ok) throw new Error(insights.error)
  expect(insights.insights[0]?.sourceLabels).toEqual(["sst/opencode"])
  expect(insights.insights[0]?.areaId).toBe(area.area.id)

  expect(await zoo.markWatchExtracted({ watchId: watch.watch.id })).toEqual({ ok: true })
  const marked = await zoo.listRepoWatches({}); if (!marked.ok) throw new Error(marked.error)
  expect(marked.watches[0]?.lastExtractAt).toBe(clock)
})

test("stores the schedule hour, reports scheduler state, and keeps evidence when a watch is dropped", async () => {
  let clock = Date.UTC(2026, 0, 10, 8, 0)
  const zoo = watchSetup({ releases: [{ tag_name: "v1", name: "1.0", published_at: new Date(clock - 3600_000).toISOString(), html_url: "", body: "note" }] }, () => clock)
  const idle = await zoo.watchState({}); if (!idle.ok) throw new Error(idle.error)
  expect(idle).toMatchObject({ hour: 8, lastCheckAt: null, watchCount: 0 })

  expect(await zoo.setWatchSchedule({ hour: 25 })).toMatchObject({ ok: false })
  expect(await zoo.setWatchSchedule({ hour: 6 })).toEqual({ ok: true, hour: 6 })

  const watch = await zoo.addRepoWatch({ repo: "sst/opencode" }); if (!watch.ok) throw new Error(watch.error)
  await zoo.checkRepoWatches({ watchId: watch.watch.id })
  const state = await zoo.watchState({}); if (!state.ok) throw new Error(state.error)
  expect(state).toMatchObject({ hour: 6, lastCheckAt: clock, watchCount: 1 })
  expect(await zoo.checkRepoWatches({ watchId: "nope" })).toMatchObject({ ok: false, error: "Unknown watch" })

  // Dropping a watch stops the checks but keeps the source and its artifacts —
  // insights already drawn from them still have their evidence.
  expect(await zoo.removeRepoWatch({ watchId: watch.watch.id })).toEqual({ ok: true })
  expect(await zoo.listRepoWatches({})).toMatchObject({ ok: true, watches: [] })
  const after = await zoo.status({}); if (!after.ok) throw new Error(after.error)
  expect(after.sources).toHaveLength(1)
  expect(after.artifactCount).toBe(1)
})

test("the scheduler catches up on launch, stores the delta, and does not re-run after a relaunch", async () => {
  // Store + scheduler together, on one database file, with a fake clock: the
  // closest thing to "the app opened, checked, and was reopened later".
  const path = mkdtempSync(join(tmpdir(), "chunky-zoo-sched-"))
  const dbPath = join(path, "zoo.db")
  let clock = Date.UTC(2026, 0, 10, 9, 0)
  const state = { releases: [{ tag_name: "v1", name: "1.0", published_at: new Date(clock - 3600_000).toISOString(), html_url: "https://gh/r/1", body: "Subagents" }], tags: [{ name: "v1" }], pulls: [] }

  const boot = () => {
    const manager = createZooManager({ dbPath, fetch: githubFetch(state), githubToken: null, now: () => clock, seedDefaults: false })
    cleanup.push({ path, zoo: manager })
    const timers: { at: number; fn: () => void }[] = []
    const runs: number[] = []
    const scheduler = createWatchScheduler({
      state: async () => {
        const watchState = await manager.watchState({})
        return watchState.ok ? { hour: watchState.hour, lastCheckAt: watchState.lastCheckAt } : { hour: 8, lastCheckAt: null }
      },
      run: async () => {
        runs.push(clock)
        const watchState = await manager.watchState({})
        if (watchState.ok && watchState.watchCount > 0) await manager.checkRepoWatches({})
      },
      now: () => clock,
      setTimer: (ms, fn) => {
        const timer = { at: clock + ms, fn }
        timers.push(timer)
        return timer
      },
      clearTimer: () => {},
    })
    return { manager, scheduler, runs, timers }
  }

  const first = boot()
  const watch = await first.manager.addRepoWatch({ repo: "sst/opencode" })
  if (!watch.ok) throw new Error(watch.error)
  await first.scheduler.start()
  // Never checked before -> catch-up ran, and the delta is on the board.
  expect(first.runs).toEqual([clock])
  expect((await first.manager.listArtifacts({}) as { total: number }).total).toBe(1)
  expect(first.scheduler.nextRunAt()).toBe(new Date(2026, 0, 11, 8, 0, 0, 0).getTime())
  first.scheduler.stop()
  first.manager.close()

  // Relaunch two hours later: the persisted run time says today is done.
  clock += 2 * 3600_000
  const second = boot()
  await second.scheduler.start()
  expect(second.runs).toEqual([])
  expect((await second.manager.listArtifacts({}) as { total: number }).total).toBe(1)
  second.scheduler.stop()
  second.manager.close()

  // Relaunch after a day away: stale, so it catches up — and picks up what
  // shipped while the app was closed.
  clock += 30 * 3600_000
  state.releases = [{ tag_name: "v2", name: "2.0", published_at: new Date(clock - 3600_000).toISOString(), html_url: "https://gh/r/2", body: "Plugins" }]
  state.tags = [{ name: "v2" }, { name: "v1" }]
  const third = boot()
  await third.scheduler.start()
  expect(third.runs).toHaveLength(1)
  const artifacts = await third.manager.listArtifacts({}); if (!artifacts.ok) throw new Error(artifacts.error)
  expect(artifacts.total).toBe(2)
  expect(artifacts.artifacts[0]?.title).toBe("sst/opencode — 1 release, 1 tag")
  third.scheduler.stop()
})
