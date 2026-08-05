import { afterEach, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { installedRuntimeIdentity, type RecordFile } from "./connectionManager"
import { inspectServers, retireServer, stopServer, type ServerInspectionDependencies } from "./serverInspection"

const cleanup: string[] = []
afterEach(() => {
  for (const path of cleanup.splice(0)) Bun.spawnSync(["rm", "-rf", path])
})

function state() {
  const root = mkdtempSync(join(tmpdir(), "chunky-app-inspection-"))
  mkdirSync(join(root, "servers"))
  cleanup.push(root)
  return root
}

function record(port: number, overrides: Partial<RecordFile> = {}): RecordFile {
  return { schema: 1, id: `server-${port}`, workspace: "/workspace", version: "1", buildId: "old-build", nonce: `nonce-${port}`, port, pid: port, startedAt: port, ...overrides }
}

function runtime(root: string, version = "2") {
  mkdirSync(join(root, "packages", "server", "src"), { recursive: true })
  writeFileSync(join(root, "packages", "server", "src", "index.ts"), `// ${version}`)
  writeFileSync(join(root, "package.json"), JSON.stringify({ version }))
  writeFileSync(join(root, "chunky.ts"), "")
  writeFileSync(join(root, "bun.lock"), "")
  return installedRuntimeIdentity({ CHUNKY_RUNTIME_DIR: root } as NodeJS.ProcessEnv)!
}

function harness(root: string, identities: Map<number, unknown>, sessions: Map<number, unknown>, live = new Set<number>(), networkLive = live) {
  const killed: Array<{ pid: number; signal?: NodeJS.Signals }> = []
  const deps: ServerInspectionDependencies = {
    env: { CHUNKY_HOME: root, CHUNKY_RUNTIME_DIR: join(root, "runtime"), CHUNKY_SETTINGS: join(root, "settings.json") },
    now: () => 100,
    pidAlive: (pid) => live.has(pid),
    kill: (pid, signal) => { killed.push({ pid, signal }) },
    fetch: (async (input: RequestInfo | URL) => {
      const url = new URL(input.toString())
      const port = Number(url.port)
      if (!networkLive.has(port)) throw new Error("offline")
      if (url.pathname === "/_chunky/server-identity") {
        const identity = identities.get(port)
        if (!identity) throw new Error("identity mismatch")
        return new Response(JSON.stringify(identity))
      }
      if (url.pathname === "/api/sessions/shell") {
        const body = sessions.get(port)
        if (body instanceof Error) throw body
        return new Response(JSON.stringify(body ?? { sessions: [] }))
      }
      return new Response("{}", { status: 200 })
    }) as typeof fetch,
  }
  return { deps, killed }
}

function save(root: string, value: RecordFile, name = `${value.id}.json`) {
  writeFileSync(join(root, "servers", name), JSON.stringify(value))
}

test("inspection classifies current, old, dead, busy, idle, and unknown servers", async () => {
  const root = state()
  const installed = runtime(join(root, "runtime"))
  const current = record(4101, { version: installed.version, buildId: installed.buildId })
  const old = record(4102)
  const dead = record(4103)
  const unknown = record(4104)
  for (const value of [current, old, dead, unknown]) save(root, value)
  const identities = new Map<number, unknown>([
    [4101, current], [4102, old], [4104, unknown],
  ])
  const sessions = new Map<number, unknown>([
    [4101, { sessions: [{ busy: true, attached: true }, { running: true, attached: false }, { busy: false, running: true, attached: true }] }],
    [4102, { sessions: [{ busy: false, running: false, attached: true }] }],
    [4104, new Error("old server has no shell endpoint")],
  ])
  const h = harness(root, identities, sessions, new Set([4101, 4102, 4104]))
  const result = await inspectServers(h.deps)
  expect(result.installed).toEqual(installed)
  expect(result.servers).toHaveLength(4)
  expect(result.servers.find((s) => s.id === current.id)).toMatchObject({ current: true, reachable: true, busy: true, busySessions: 2, attachedSessions: 2, totalSessions: 3 })
  expect(result.servers.find((s) => s.id === old.id)).toMatchObject({ current: false, reachable: true, busy: false, busySessions: 0, attachedSessions: 1, totalSessions: 1 })
  expect(result.servers.find((s) => s.id === unknown.id)).toMatchObject({ reachable: true, busy: null, busySessions: 0, totalSessions: 0 })
  expect(result.servers.find((s) => s.id === dead.id)).toMatchObject({ reachable: false, busy: null, totalSessions: 0 })
})

test("retireServer supersedes a verified record without killing it", async () => {
  const root = state(), value = record(4201)
  save(root, value)
  const h = harness(root, new Map([[value.port, value]]), new Map(), new Set([value.pid]))
  const result = await retireServer(h.deps, value.id)
  expect(result).toEqual({ ok: true })
  expect(existsSync(join(root, "servers", `${value.id}.json`))).toBe(false)
  expect(h.killed).toHaveLength(0)
})

test("stopServer refuses identity mismatch and never kills", async () => {
  const root = state(), value = record(4301)
  save(root, value)
  const mismatch = { ...value, id: "different-server" }
  const h = harness(root, new Map([[value.port, mismatch]]), new Map(), new Set([value.pid]))
  const result = await stopServer(h.deps, value.id)
  expect(result.ok).toBe(false)
  expect(existsSync(join(root, "servers", `${value.id}.json`))).toBe(true)
  expect(h.killed).toHaveLength(0)
})

test("stopServer supersedes and SIGTERMs a verified live server", async () => {
  const root = state(), value = record(4302)
  save(root, value)
  const h = harness(root, new Map([[value.port, value]]), new Map(), new Set([value.pid]))
  expect(await stopServer(h.deps, value.id)).toEqual({ ok: true })
  expect(existsSync(join(root, "servers", `${value.id}.json`))).toBe(false)
  expect(h.killed).toEqual([{ pid: value.pid, signal: "SIGTERM" }])
})

test("stopServer cleans a verified dead server without killing", async () => {
  const root = state(), value = record(4303)
  save(root, value)
  const h = harness(root, new Map([[value.port, value]]), new Map(), new Set(), new Set([value.port]))
  expect(await stopServer(h.deps, value.id)).toEqual({ ok: true })
  expect(existsSync(join(root, "servers", `${value.id}.json`))).toBe(false)
  expect(h.killed).toHaveLength(0)
})
