import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  resetChunkyConnectionForTest,
  resolveChunkyConnection,
  selectHealthyRecord,
  type ConnectionDependencies,
} from "./connectionManager"

const cleanup: string[] = []
afterEach(async () => {
  await resetChunkyConnectionForTest()
  for (const path of cleanup.splice(0)) Bun.spawnSync(["rm", "-rf", path])
})

function tempState() {
  const state = mkdtempSync(join(tmpdir(), "chunky-app-connection-"))
  cleanup.push(state)
  mkdirSync(join(state, "servers"))
  return state
}

function record(port: number, workspace: string, startedAt: number) {
  return { schema: 1, id: `id-${port}`, workspace, version: "1", buildId: "build", nonce: `nonce-${port}`, port, pid: port, startedAt }
}

function deps(live: Set<number>, starts: { count: number }): ConnectionDependencies {
  return {
    now: () => Date.now(),
    sleep: async () => {},
    spawn: () => ({ pid: ++starts.count }),
    fetch: (async (input: RequestInfo | URL) => {
      const url = new URL(input.toString())
      const port = Number(url.port)
      if (!live.has(port)) throw new Error("offline")
      if (url.pathname === "/_chunky/server-identity") {
        return new Response(JSON.stringify(record(port, port === 2 ? "/wanted" : "/other", port)), { status: 200 })
      }
      return new Response("{}", { status: 200 })
    }) as typeof fetch,
  }
}

test("explicit URL and port overrides win without discovery", async () => {
  const starts = { count: 0 }
  expect(await resolveChunkyConnection({ CHUNKY_URL: "http://override" }, deps(new Set(), starts))).toMatchObject({ baseUrl: "http://override" })
  await resetChunkyConnectionForTest()
  expect(await resolveChunkyConnection({ CHUNKY_PORT: "48123" }, deps(new Set(), starts))).toMatchObject({ baseUrl: "http://localhost:48123" })
  expect(starts.count).toBe(0)
})

test("selects preferred healthy workspace then newest healthy record", async () => {
  const state = tempState()
  writeFileSync(join(state, "servers", "old.json"), JSON.stringify(record(1, "/other", 1)))
  writeFileSync(join(state, "servers", "wanted.json"), JSON.stringify(record(2, "/wanted", 2)))
  writeFileSync(join(state, "servers", "new.json"), JSON.stringify(record(3, "/other", 3)))
  const live = new Set([1, 2, 3])
  expect((await selectHealthyRecord(join(state, "servers"), "token", "/wanted", deps(live, { count: 0 })))?.port).toBe(2)
  expect((await selectHealthyRecord(join(state, "servers"), "token", undefined, deps(live, { count: 0 })))?.port).toBe(3)
})

test("ignores malformed and stale records", async () => {
  const state = tempState()
  writeFileSync(join(state, "servers", "bad.json"), "not json")
  writeFileSync(join(state, "servers", "stale.json"), JSON.stringify(record(9, "/old", 9)))
  expect(await selectHealthyRecord(join(state, "servers"), "token", undefined, deps(new Set(), { count: 0 }))).toBeUndefined()
})

test("reports automatic runtime installation failure actionably", async () => {
  const state = tempState()
  const testDeps = deps(new Set(), { count: 0 })
  testDeps.installRuntime = async () => { throw new Error("release lookup unavailable") }
  const result = await resolveChunkyConnection({ CHUNKY_HOME: state, CHUNKY_RUNTIME_DIR: join(state, "missing"), CHUNKY_BUN_PATH: join(state, "bun") }, testDeps)
  expect(result.baseUrl).toBe("")
  expect(result.connectionError).toContain("Failed to install the Chunky server automatically: release lookup unavailable")
})

test("starts an isolated runtime and waits until its authenticated server is ready", async () => {
  const state = tempState()
  const runtime = join(state, "runtime")
  mkdirSync(join(runtime, "packages", "server", "src"), { recursive: true })
  writeFileSync(join(runtime, "packages", "server", "src", "index.ts"), "")
  writeFileSync(join(runtime, "package.json"), JSON.stringify({ version: "1" }))
  writeFileSync(join(runtime, "chunky.ts"), "")
  writeFileSync(join(runtime, "bun.lock"), "")
  const live = new Set<number>()
  const starts = { count: 0 }
  const testDeps = deps(live, starts)
  let started: Record<string, string | undefined> = {}
  testDeps.allocatePort = async () => 43210
  testDeps.spawn = (_command, options) => {
    starts.count++
    started = options.env
    live.add(Number(options.env.CHUNKY_PORT))
    return { pid: 12345 }
  }
  testDeps.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(input.toString())
    if (!live.has(Number(url.port))) throw new Error("offline")
    if (url.pathname === "/_chunky/server-identity") {
      return new Response(JSON.stringify({
        id: started.CHUNKY_SERVER_ID,
        workspace: started.CHUNKY_WORKSPACE,
        version: started.CHUNKY_VERSION,
        buildId: started.CHUNKY_BUILD_ID,
        nonce: started.CHUNKY_SERVER_NONCE,
        port: Number(started.CHUNKY_PORT),
      }))
    }
    return new Response("{}", { status: 200 })
  }) as typeof fetch
  const result = await resolveChunkyConnection({ CHUNKY_HOME: state, CHUNKY_RUNTIME_DIR: runtime }, testDeps)
  expect(result.baseUrl).toBe("http://localhost:43210")
  expect(result.serverToken).toBeTruthy()
  expect(starts.count).toBe(1)
})
