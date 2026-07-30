import { afterEach, expect, test } from "bun:test"
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
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
