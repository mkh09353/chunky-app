import { afterEach, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  installedRuntimeIdentity,
  resetChunkyConnectionForTest,
  resolveChunkyConnection,
  selectHealthyRecord,
  upgradeRuntimeAndReconnect,
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

/** A minimal installed runtime tree, plus the identity servers built from it
 *  would advertise. */
function fakeRuntime(state: string, version: string) {
  const root = join(state, `runtime-${version}`)
  mkdirSync(join(root, "packages", "server", "src"), { recursive: true })
  writeFileSync(join(root, "packages", "server", "src", "index.ts"), `// v${version}`)
  writeFileSync(join(root, "package.json"), JSON.stringify({ version }))
  writeFileSync(join(root, "chunky.ts"), "")
  writeFileSync(join(root, "bun.lock"), "")
  const identity = installedRuntimeIdentity({ CHUNKY_RUNTIME_DIR: root } as NodeJS.ProcessEnv)!
  return { root, ...identity }
}

/** deps whose spawn brings the new server's port to life, so startServer's
 *  readiness poll succeeds like it would in production. */
function startableDeps(live: Set<number>, starts: { count: number }, records: Map<number, unknown>) {
  const testDeps = deps(live, starts)
  let started: Record<string, string | undefined> = {}
  testDeps.allocatePort = async () => 43210
  testDeps.spawn = (_command, options) => {
    starts.count++
    started = options.env
    const port = Number(options.env.CHUNKY_PORT)
    records.set(port, {
      id: started.CHUNKY_SERVER_ID, workspace: started.CHUNKY_WORKSPACE, version: started.CHUNKY_VERSION,
      buildId: started.CHUNKY_BUILD_ID, nonce: started.CHUNKY_SERVER_NONCE, port,
    })
    live.add(port)
    return { pid: 12345 }
  }
  testDeps.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(input.toString())
    const port = Number(url.port)
    if (!live.has(port)) throw new Error("offline")
    if (url.pathname === "/_chunky/server-identity") return new Response(JSON.stringify(records.get(port)))
    return new Response("{}", { status: 200 })
  }) as typeof fetch
  return testDeps
}

test("reuses a healthy server built from the installed runtime", async () => {
  const state = tempState()
  const workspace = "/wanted"
  const runtime = fakeRuntime(state, "2")
  const existing = { ...record(48201, workspace, Date.now()), version: runtime.version, buildId: runtime.buildId }
  writeFileSync(join(state, "servers", "cli.json"), JSON.stringify(existing))
  writeFileSync(join(state, "settings.json"), JSON.stringify({ serverToken: "shared-token" }))
  const starts = { count: 0 }
  const testDeps = startableDeps(new Set([existing.port]), starts, new Map([[existing.port, existing]]))

  const result = await resolveChunkyConnection({
    CHUNKY_HOME: state, CHUNKY_WORKSPACE: workspace, CHUNKY_RUNTIME_DIR: runtime.root,
  }, testDeps)

  expect(result).toMatchObject({ baseUrl: `http://localhost:${existing.port}`, workspace, serverToken: "shared-token" })
  expect(starts.count).toBe(0)
  expect(existsSync(join(state, "servers", "cli.json"))).toBe(true)
})

test("supersedes a healthy server built by a replaced runtime", async () => {
  const state = tempState()
  const workspace = "/wanted"
  const runtime = fakeRuntime(state, "2")
  // Same workspace, older build: healthy, but not ours any more.
  const stale = { ...record(48201, workspace, Date.now()), version: "1", buildId: "old-build" }
  writeFileSync(join(state, "servers", "cli.json"), JSON.stringify(stale))
  writeFileSync(join(state, "settings.json"), JSON.stringify({ serverToken: "shared-token" }))
  const messages: string[] = []
  const starts = { count: 0 }
  const testDeps = startableDeps(new Set([stale.port]), starts, new Map([[stale.port, stale]]))
  testDeps.log = (message) => messages.push(message)

  const result = await resolveChunkyConnection({
    CHUNKY_HOME: state, CHUNKY_WORKSPACE: workspace, CHUNKY_RUNTIME_DIR: runtime.root,
  }, testDeps)

  // A server from the installed runtime is started instead of adopting the old one.
  expect(starts.count).toBe(1)
  expect(result.baseUrl).toBe("http://localhost:43210")
  // The old server is retired through its discovery record, never by signal.
  expect(existsSync(join(state, "servers", "cli.json"))).toBe(false)
  expect(messages.join("\n")).toContain("predates runtime v2")
  expect(messages.join("\n")).toContain("retiring superseded Chunky v1 server")
})

test("leaves another workspace's older server alone", async () => {
  const state = tempState()
  const runtime = fakeRuntime(state, "2")
  const other = { ...record(48202, "/somewhere-else", Date.now()), version: "1", buildId: "old-build" }
  writeFileSync(join(state, "servers", "other.json"), JSON.stringify(other))
  writeFileSync(join(state, "settings.json"), JSON.stringify({ serverToken: "shared-token" }))
  const starts = { count: 0 }
  const testDeps = startableDeps(new Set([other.port]), starts, new Map([[other.port, other]]))

  await resolveChunkyConnection({
    CHUNKY_HOME: state, CHUNKY_WORKSPACE: "/wanted", CHUNKY_RUNTIME_DIR: runtime.root,
  }, testDeps)

  expect(starts.count).toBe(1)
  expect(existsSync(join(state, "servers", "other.json"))).toBe(true)
})

test("falls back to the stale server when the newer one cannot start", async () => {
  const state = tempState()
  const workspace = "/wanted"
  const runtime = fakeRuntime(state, "2")
  const stale = { ...record(48203, workspace, Date.now()), version: "1", buildId: "old-build" }
  writeFileSync(join(state, "servers", "cli.json"), JSON.stringify(stale))
  writeFileSync(join(state, "settings.json"), JSON.stringify({ serverToken: "shared-token" }))
  const starts = { count: 0 }
  const testDeps = startableDeps(new Set([stale.port]), starts, new Map([[stale.port, stale]]))
  testDeps.spawn = () => ({ pid: undefined }) // the spawn fails outright

  const result = await resolveChunkyConnection({
    CHUNKY_HOME: state, CHUNKY_WORKSPACE: workspace, CHUNKY_RUNTIME_DIR: runtime.root,
  }, testDeps)

  expect(result.baseUrl).toBe(`http://localhost:${stale.port}`)
  expect(existsSync(join(state, "servers", "cli.json"))).toBe(true)
})

test("skips a server that is draining after being superseded", async () => {
  const state = tempState()
  const retiring = record(48204, "/wanted", Date.now())
  writeFileSync(join(state, "servers", "retiring.json"), JSON.stringify(retiring))
  const testDeps = deps(new Set([retiring.port]), { count: 0 })
  testDeps.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(input.toString())
    if (url.pathname === "/_chunky/server-identity") {
      return new Response(JSON.stringify({ ...retiring, retiring: true }))
    }
    return new Response("{}", { status: 200 })
  }) as typeof fetch

  expect(await selectHealthyRecord(join(state, "servers"), "token", "/wanted", testDeps)).toBeUndefined()
  // Draining is self-cleaning: its record is not ours to delete.
  expect(existsSync(join(state, "servers", "retiring.json"))).toBe(true)
})

test("prunes records whose process is gone, keeping unreachable-but-alive ones", async () => {
  const state = tempState()
  writeFileSync(join(state, "servers", "dead.json"), JSON.stringify(record(48205, "/gone", 1)))
  writeFileSync(join(state, "servers", "hung.json"), JSON.stringify(record(48206, "/hung", 2)))
  const testDeps = deps(new Set(), { count: 0 })
  testDeps.pidAlive = (pid) => pid === 48206 // the hung one is still running

  expect(await selectHealthyRecord(join(state, "servers"), "token", undefined, testDeps, { prune: true })).toBeUndefined()
  expect(existsSync(join(state, "servers", "dead.json"))).toBe(false)
  expect(existsSync(join(state, "servers", "hung.json"))).toBe(true)
})

test("prefers a matching-runtime server over a newer stale one", async () => {
  const state = tempState()
  const matching = { ...record(48207, "/wanted", 1), version: "2", buildId: "build-2" }
  const newerStale = { ...record(48208, "/wanted", 99), version: "1", buildId: "build-1" }
  writeFileSync(join(state, "servers", "matching.json"), JSON.stringify(matching))
  writeFileSync(join(state, "servers", "stale.json"), JSON.stringify(newerStale))
  const live = new Set([matching.port, newerStale.port])
  const testDeps = deps(live, { count: 0 })
  testDeps.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(input.toString())
    const port = Number(url.port)
    if (!live.has(port)) throw new Error("offline")
    if (url.pathname === "/_chunky/server-identity") {
      return new Response(JSON.stringify(port === matching.port ? matching : newerStale))
    }
    return new Response("{}", { status: 200 })
  }) as typeof fetch

  const chosen = await selectHealthyRecord(join(state, "servers"), "token", "/wanted", testDeps, {
    prefer: { version: "2", buildId: "build-2" },
  })
  expect(chosen?.port).toBe(matching.port)
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

test("an upgraded runtime moves the app onto a server built from it", async () => {
  const state = tempState()
  const workspace = "/wanted"
  const runtime = fakeRuntime(state, "2")
  // The server the app is on today, from the runtime we just replaced.
  const stale = { ...record(48301, workspace, Date.now()), version: "1", buildId: "old-build" }
  writeFileSync(join(state, "servers", "cli.json"), JSON.stringify(stale))
  writeFileSync(join(state, "settings.json"), JSON.stringify({ serverToken: "shared-token" }))
  const starts = { count: 0 }
  const testDeps = startableDeps(new Set([stale.port]), starts, new Map([[stale.port, stale]]))
  testDeps.upgradeRuntime = async () => ({ status: "upgraded", version: "2", previousVersion: "1" })

  const result = await upgradeRuntimeAndReconnect({
    CHUNKY_HOME: state, CHUNKY_WORKSPACE: workspace, CHUNKY_RUNTIME_DIR: runtime.root,
  }, testDeps)

  expect(result.upgraded).toBe(true)
  expect(result.version).toBe("2")
  expect(result.connection?.baseUrl).toBe("http://localhost:43210")
  expect(starts.count).toBe(1)
  // The superseded server is retired through its record, so it drains and exits.
  expect(existsSync(join(state, "servers", "cli.json"))).toBe(false)
})

test("no runtime update means no reconnect", async () => {
  const state = tempState()
  const runtime = fakeRuntime(state, "2")
  const starts = { count: 0 }
  const testDeps = startableDeps(new Set(), starts, new Map())
  testDeps.upgradeRuntime = async () => ({ status: "current", version: "2" })

  const result = await upgradeRuntimeAndReconnect({
    CHUNKY_HOME: state, CHUNKY_RUNTIME_DIR: runtime.root,
  }, testDeps)

  expect(result).toEqual({ upgraded: false, version: "2" })
  expect(starts.count).toBe(0)
})

test("a failed runtime update is reported, not thrown, and changes nothing", async () => {
  const state = tempState()
  const runtime = fakeRuntime(state, "2")
  const starts = { count: 0 }
  const messages: string[] = []
  const testDeps = startableDeps(new Set(), starts, new Map())
  testDeps.log = (message) => messages.push(message)
  testDeps.upgradeRuntime = async () => { throw new Error("release lookup unavailable") }

  const result = await upgradeRuntimeAndReconnect({
    CHUNKY_HOME: state, CHUNKY_RUNTIME_DIR: runtime.root,
  }, testDeps)

  expect(result).toEqual({ upgraded: false })
  expect(starts.count).toBe(0)
  expect(messages.join("\n")).toContain("update skipped: release lookup unavailable")
})
