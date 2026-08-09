import { afterEach, expect, test } from "bun:test"
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Database } from "bun:sqlite"
import { createZooManager, type ZooManager } from "./zoo"

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
  const zoo = createZooManager({ dbPath: join(path, "zoo.db"), fetch })
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

  // The legacy rows are assignable once an area exists, and unassignable again.
  const area = await zoo.createArea({ name: "Payments" }); if (!area.ok) throw new Error(area.error)
  expect(await zoo.assignArea({ kind: "item", id: "t-1", areaId: area.area.id })).toEqual({ ok: true })
  expect((await zoo.listItems({}) as { items: { areaId?: string }[] }).items[0]?.areaId).toBe(area.area.id)
  expect((await zoo.listIdeas({}) as { ideas: { areaId?: string }[] }).ideas[0]?.areaId).toBe(area.area.id)
})
