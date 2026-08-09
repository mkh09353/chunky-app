import { afterEach, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Database } from "bun:sqlite"
import { createZooManager, type ZooManager } from "./zoo"
import { createZooService } from "./zooService"

const cleanup: Array<{ path: string; manager: ZooManager; stop: () => void }> = []
afterEach(() => { for (const entry of cleanup.splice(0)) { entry.stop(); entry.manager.close(); Bun.spawnSync(["rm", "-rf", entry.path]) } })

function setup() {
  const path = mkdtempSync(join(tmpdir(), "chunky-zoo-service-"))
  const manager = createZooManager({ dbPath: join(path, "zoo.db") })
  const service = createZooService({ manager })
  cleanup.push({ path, manager, stop: service.stop })
  return { path, manager, service }
}
async function op(target: { port: number; token: string }, method: string, params: object, authorization = `Bearer ${target.token}`) {
  return fetch(`http://127.0.0.1:${target.port}/zoo/op`, { method: "POST", headers: { Authorization: authorization, "Content-Type": "application/json" }, body: JSON.stringify({ method, params }) })
}

test("Zoo service requires token auth, routes operations, and rejects malformed requests", async () => {
  const { service } = setup(); const target = await service.target()
  expect(target.token).toMatch(/^[a-f0-9]{64}$/)
  expect((await fetch(`http://127.0.0.1:${target.port}/zoo/op`, { method: "POST" })).status).toBe(401)
  expect((await op(target, "board", {}, "Bearer wrong")).status).toBe(401)
  expect((await fetch(`http://127.0.0.1:${target.port}/nope`, { method: "POST", headers: { Authorization: `Bearer ${target.token}` } })).status).toBe(404)
  const malformed = await fetch(`http://127.0.0.1:${target.port}/zoo/op`, { method: "POST", headers: { Authorization: `Bearer ${target.token}`, "Content-Type": "application/json" }, body: "{" })
  expect(malformed.status).toBe(400); expect(await malformed.json()).toMatchObject({ ok: false, error: "Malformed JSON" })
  expect(await (await op(target, "nope", {})).json()).toMatchObject({ ok: false, error: expect.any(String) })
  expect(await (await op(target, "board", {})).json()).toMatchObject({ ok: true, counts: { artifacts: 0, insights: 0, ideas: 0, items: 0 } })
})

test("Zoo service excludes renderer setup and credential operations", async () => {
  const { service, manager } = setup(); const target = await service.target(); const secret = "must-not-cross-agent-service"
  for (const [method, params] of [
    ["listSetupSessions", {}], ["recordSetupSession", { sessionId: "s" }],
    ["listCredentials", {}], ["setCredential", { name: "token", value: secret }],
    ["deleteCredential", { name: "token" }],
  ] as const) {
    const response = await (await op(target, method, params)).json()
    expect(response).toEqual({ ok: false, error: "Unknown Zoo operation" })
    expect(JSON.stringify(response)).not.toContain(secret)
  }
  expect(await manager.listCredentials({})).toEqual({ ok: true, credentials: [] })
})

test("Zoo addNote routes jam targets to idea outcomes while direct outcome stays excluded", async () => {
  const { service, manager } = setup(); const target = await service.target()
  const created = await manager.createIdea({ type: "investigate", title: "Jam", rationale: "Learn" }); if (!created.ok) throw new Error(created.error)
  await manager.recordJamSession({ target: "idea", targetId: created.idea.id, sessionId: "session-1" })
  expect(await (await op(target, "addNote", { itemId: "jam:session-1", note: "Keep proposed" })).json()).toMatchObject({ ok: true, idea: { status: "proposed", decisions: [{ note: "Keep proposed" }] } })
  expect(await (await op(target, "addNote", { itemId: "jam:", note: "Malformed" })).json()).toMatchObject({ ok: false, error: "Invalid jam outcome" })
  expect(await (await op(target, "addNote", { itemId: "jam:missing", note: "Unknown" })).json()).toMatchObject({ ok: false, error: "Unknown jam session" })
  expect(await (await op(target, "addJamOutcome", { sessionId: "session-1", note: "Bypass" })).json()).toEqual({ ok: false, error: "Unknown Zoo operation" })
  const promoted = await manager.promoteIdea({ ideaId: created.idea.id, reason: "Now go" }); if (!promoted.ok) throw new Error(promoted.error)
  expect(await (await op(target, "addNote", { itemId: promoted.item.id, note: "Ordinary item note" })).json()).toMatchObject({ ok: true, item: { decisions: expect.arrayContaining([expect.objectContaining({ note: "Ordinary item note" })]) } })
})

test("Zoo service reads and mutates product-factory ideas and items", async () => {
  const { service } = setup(); const target = await service.target()
  const created = await (await op(target, "createIdea", { type: "build", title: "Better search", rationale: "Customers ask" })).json() as any
  expect(created).toMatchObject({ ok: true, idea: { title: "Better search" } })
  expect(await (await op(target, "createIdea", { type: "bad", title: "No", rationale: "No" })).json()).toMatchObject({ ok: false })
  const ideaId = created.idea.id
  expect(await (await op(target, "search", { query: "search" })).json()).toMatchObject({ ok: true, ideas: [{ id: ideaId }] })
  expect(await (await op(target, "getIdea", { ideaId })).json()).toMatchObject({ ok: true, idea: { id: ideaId }, insights: [] })
  const promoted = await (await op(target, "promoteIdea", { ideaId, reason: "Validated demand" })).json() as any
  expect(promoted).toMatchObject({ ok: true, item: { stage: "research", decisions: [{ actor: "agent", note: "Promoted: Validated demand" }] } })
  expect(await (await op(target, "promoteIdea", { ideaId, reason: "Again" })).json()).toMatchObject({ ok: false })
  const itemId = promoted.item.id
  const moved = await (await op(target, "moveItem", { itemId, stage: "building", reason: "Ready" })).json() as any
  expect(moved.item.stage).toBe("building")
  expect(moved.item.decisions.some((decision: { actor: string; note: string }) => decision.actor === "agent" && decision.note === "Moved to building: Ready")).toBe(true)
  const noted = await (await op(target, "addNote", { itemId, note: "Handed to implementation" })).json() as any
  expect(noted.item.decisions.some((decision: { actor: string; note: string }) => decision.actor === "agent" && decision.note === "Handed to implementation")).toBe(true)
  expect(await (await op(target, "getItem", { itemId })).json()).toMatchObject({ ok: true, item: { id: itemId }, idea: { id: ideaId } })
  expect(await (await op(target, "board", {})).json()).toMatchObject({ ok: true, ideas: { promoted: [{ id: ideaId }] }, items: { building: [{ id: itemId }] } })

  const dismissed = await (await op(target, "createIdea", { type: "close", title: "Old issue", rationale: "Resolved" })).json() as any
  expect(await (await op(target, "dismissIdea", { ideaId: dismissed.idea.id, reason: "No longer relevant" })).json()).toMatchObject({ ok: true, idea: { status: "dismissed", dismissReason: "No longer relevant" } })
})

test("migrates an old ideas schema to nullable pass and dismissal reason", async () => {
  const { path, manager } = setup(); const dbPath = join(path, "legacy.db")
  const db = new Database(dbPath)
  db.run("CREATE TABLE passes (id TEXT PRIMARY KEY)")
  db.run("CREATE TABLE ideas (id TEXT PRIMARY KEY, pass_id TEXT NOT NULL REFERENCES passes(id), type TEXT NOT NULL, title TEXT NOT NULL, rationale TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL, item_id TEXT)")
  db.close(); manager.close()
  const migrated = createZooManager({ dbPath }); cleanup[cleanup.length - 1]!.manager = migrated
  const created = await migrated.createIdea({ type: "build", title: "No pass", rationale: "Allowed" })
  expect(created).toMatchObject({ ok: true, idea: { title: "No pass" } })
  const inspect = new Database(dbPath); const columns = inspect.query("PRAGMA table_info(ideas)").all() as Array<{ name: string; notnull: number }>; inspect.close()
  expect(columns.find((column) => column.name === "pass_id")?.notnull).toBe(0)
  expect(columns.some((column) => column.name === "dismiss_reason")).toBe(true)
})
