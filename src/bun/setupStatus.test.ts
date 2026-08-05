// First-run setup progress: the installer and the connection manager must emit
// stages in a sensible order, must report download percentage when the archive
// size is known, and must be completely unaffected when reporting fails.
import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  resetChunkyConnectionForTest,
  resolveChunkyConnection,
  installedRuntimeIdentity,
  type ConnectionDependencies,
} from "./connectionManager"
import { hasRuntime, installRuntime, type RuntimeInstallerDependencies } from "./runtimeInstaller"
import {
  reportSetupStage,
  resetSetupStageReporterForTest,
  setSetupStageReporter,
  type SetupStage,
} from "./setupStatus"

const cleanup: string[] = []
afterEach(async () => {
  resetSetupStageReporterForTest()
  await resetChunkyConnectionForTest()
  for (const path of cleanup.splice(0)) Bun.spawnSync(["rm", "-rf", path])
})

function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), "chunky-setup-status-"))
  cleanup.push(home)
  return home
}

interface InstallerOptions {
  /** Body of the release archive response (defaults to a small buffered one). */
  archive?: () => Response
  /** Number of `bun install` runs before the native binary appears. */
  installsBeforeBinary?: number
  report?(stage: SetupStage): void
  onTar?(archivePath: string): void
}

function installerDeps(home: string, options: InstallerOptions = {}): Partial<RuntimeInstallerDependencies> {
  let installs = 0
  const installsBeforeBinary = options.installsBeforeBinary ?? 1
  return {
    homeDir: home,
    platform: "darwin",
    arch: "arm64",
    log: () => {},
    report: options.report ?? (() => {}),
    fetch: (async (input: RequestInfo | URL) => {
      const url = input.toString()
      if (url.includes("releases/latest")) {
        return new Response(
          JSON.stringify({
            tag_name: "v1.2.3",
            assets: [{ name: "chunky.tar.gz", browser_download_url: "https://downloads.example/chunky.tar.gz" }],
          }),
        )
      }
      if (url.includes("downloads.example")) return options.archive ? options.archive() : new Response("archive")
      throw new Error(`unexpected URL ${url}`)
    }) as typeof fetch,
    exec: (command, execOptions) => {
      if (command[0] === "tar") {
        options.onTar?.(join(execOptions.cwd, "app.update.tar.gz"))
        mkdirSync(join(execOptions.cwd, "app.new", "packages", "server", "src"), { recursive: true })
        writeFileSync(join(execOptions.cwd, "app.new", "packages", "server", "src", "index.ts"), "")
        writeFileSync(join(execOptions.cwd, "app.new", "package.json"), JSON.stringify({ version: "1.2.3" }))
      }
      if (command.includes("install")) {
        installs += 1
        if (installs >= installsBeforeBinary) {
          const binary = join(execOptions.cwd, "node_modules", "@anthropic-ai", "claude-agent-sdk-darwin-arm64", "bin")
          mkdirSync(binary, { recursive: true })
          writeFileSync(join(binary, "claude"), "binary")
        }
      }
      return { exitCode: 0 }
    },
  }
}

test("a fresh install reports its stages in order", async () => {
  const home = tempHome()
  const stages: SetupStage[] = []

  await installRuntime({}, installerDeps(home, { report: (stage) => stages.push(stage) }))

  expect(hasRuntime(join(home, ".chunky", "app"))).toBe(true)
  expect(stages.map((stage) => stage.kind)).toEqual([
    "checking",
    "downloading",
    "extracting",
    "installing",
    "verifying",
  ])
  // Everything after the release lookup names the version being installed.
  expect(stages.slice(1).every((stage) => stage.version === "1.2.3")).toBe(true)
  expect(stages.find((stage) => stage.kind === "installing")?.attempt).toBe(1)
})

test("reports whole-percent download progress when the archive size is known", async () => {
  const home = tempHome()
  const stages: SetupStage[] = []
  const chunk = new Uint8Array(100).fill(65)
  const total = chunk.byteLength * 10
  let archiveBytes = 0

  await installRuntime(
    {},
    installerDeps(home, {
      report: (stage) => stages.push(stage),
      onTar: (archivePath) => {
        archiveBytes = statSync(archivePath).size
      },
      archive: () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              for (let index = 0; index < 10; index++) controller.enqueue(chunk)
              controller.close()
            },
          }),
          { headers: { "content-length": String(total) } },
        ),
    }),
  )

  const percents = stages.filter((stage) => stage.kind === "downloading").map((stage) => stage.percent)
  expect(percents[0]).toBe(0)
  expect(percents.length).toBeGreaterThan(2)
  // Strictly increasing whole percents, never past 99 (100 belongs to the
  // stages that follow the download).
  for (let index = 1; index < percents.length; index++) {
    expect(percents[index]!).toBeGreaterThan(percents[index - 1]!)
    expect(percents[index]!).toBeLessThanOrEqual(99)
  }
  // The streamed body is reassembled byte-for-byte before it is written.
  expect(archiveBytes).toBe(total)
  expect(hasRuntime(join(home, ".chunky", "app"))).toBe(true)
})

test("omits the percentage when the archive size is unknown", async () => {
  const home = tempHome()
  const stages: SetupStage[] = []

  await installRuntime({}, installerDeps(home, { report: (stage) => stages.push(stage) }))

  const download = stages.find((stage) => stage.kind === "downloading")
  expect(download).toBeDefined()
  expect(download?.percent).toBeUndefined()
})

test("reports the installer's dependency retry as a second attempt", async () => {
  const home = tempHome()
  const stages: SetupStage[] = []

  await installRuntime(
    {},
    installerDeps(home, { report: (stage) => stages.push(stage), installsBeforeBinary: 2 }),
  )

  expect(stages.filter((stage) => stage.kind === "installing").map((stage) => stage.attempt)).toEqual([1, 2])
  expect(hasRuntime(join(home, ".chunky", "app"))).toBe(true)
})

test("a reporter that throws never breaks the install", async () => {
  const home = tempHome()
  let calls = 0

  await installRuntime(
    {},
    installerDeps(home, {
      report: () => {
        calls += 1
        throw new Error("webview went away")
      },
    }),
  )

  expect(calls).toBeGreaterThan(0)
  expect(hasRuntime(join(home, ".chunky", "app"))).toBe(true)
})

test("reportSetupStage swallows reporter failures and detaches cleanly", () => {
  const seen: SetupStage[] = []
  setSetupStageReporter((stage) => {
    seen.push(stage)
    throw new Error("send failed")
  })
  expect(() => reportSetupStage({ kind: "checking" })).not.toThrow()
  expect(seen).toEqual([{ kind: "checking" }])

  setSetupStageReporter(null)
  expect(() => reportSetupStage({ kind: "starting" })).not.toThrow()
  expect(seen).toHaveLength(1)
})

// ---- Connection manager -----------------------------------------------------

function tempState(): string {
  const state = mkdtempSync(join(tmpdir(), "chunky-setup-connection-"))
  cleanup.push(state)
  mkdirSync(join(state, "servers"))
  return state
}

/** A minimal installed runtime tree plus the identity its servers advertise. */
function fakeRuntime(state: string, version: string) {
  const root = join(state, `runtime-${version}`)
  mkdirSync(join(root, "packages", "server", "src"), { recursive: true })
  writeFileSync(join(root, "packages", "server", "src", "index.ts"), `// v${version}`)
  writeFileSync(join(root, "package.json"), JSON.stringify({ version }))
  const identity = installedRuntimeIdentity({ CHUNKY_RUNTIME_DIR: root } as NodeJS.ProcessEnv)!
  return { root, ...identity }
}

/** deps whose spawn brings the started server's port to life. */
function connectionDeps(records: Map<number, unknown>, live: Set<number>, stages: SetupStage[]): ConnectionDependencies {
  return {
    now: () => Date.now(),
    sleep: async () => {},
    allocatePort: async () => 43210,
    report: (stage) => stages.push(stage),
    spawn: (_command, options) => {
      const port = Number(options.env.CHUNKY_PORT)
      records.set(port, {
        id: options.env.CHUNKY_SERVER_ID, workspace: options.env.CHUNKY_WORKSPACE,
        version: options.env.CHUNKY_VERSION, buildId: options.env.CHUNKY_BUILD_ID,
        nonce: options.env.CHUNKY_SERVER_NONCE, port,
      })
      live.add(port)
      return { pid: 12345 }
    },
    fetch: (async (input: RequestInfo | URL) => {
      const url = new URL(input.toString())
      const port = Number(url.port)
      if (!live.has(port)) throw new Error("offline")
      if (url.pathname === "/_chunky/server-identity") return new Response(JSON.stringify(records.get(port)))
      return new Response("{}", { status: 200 })
    }) as typeof fetch,
  }
}

test("starting a server reports a starting stage", async () => {
  const state = tempState()
  const runtime = fakeRuntime(state, "2")
  const stages: SetupStage[] = []

  const result = await resolveChunkyConnection(
    { CHUNKY_HOME: state, CHUNKY_WORKSPACE: "/wanted", CHUNKY_RUNTIME_DIR: runtime.root },
    connectionDeps(new Map(), new Set(), stages),
  )

  expect(result.baseUrl).toBe("http://localhost:43210")
  expect(stages.map((stage) => stage.kind)).toEqual(["starting"])
})

test("a warm launch that reuses a healthy server reports nothing", async () => {
  const state = tempState()
  const runtime = fakeRuntime(state, "2")
  const existing = {
    schema: 1, id: "id-48201", workspace: "/wanted", version: runtime.version, buildId: runtime.buildId,
    nonce: "nonce", port: 48201, pid: 48201, startedAt: Date.now(),
  }
  writeFileSync(join(state, "servers", "cli.json"), JSON.stringify(existing))
  writeFileSync(join(state, "settings.json"), JSON.stringify({ serverToken: "shared-token" }))
  const stages: SetupStage[] = []

  const result = await resolveChunkyConnection(
    { CHUNKY_HOME: state, CHUNKY_WORKSPACE: "/wanted", CHUNKY_RUNTIME_DIR: runtime.root },
    connectionDeps(new Map([[existing.port, existing]]), new Set([existing.port]), stages),
  )

  expect(result.baseUrl).toBe(`http://localhost:${existing.port}`)
  // No stage at all: the connecting screen must look exactly as it always does.
  expect(stages).toEqual([])
})

test("a reporter that throws never breaks connection resolution", async () => {
  const state = tempState()
  const runtime = fakeRuntime(state, "2")
  const deps = connectionDeps(new Map(), new Set(), [])
  deps.report = () => {
    throw new Error("webview went away")
  }

  const result = await resolveChunkyConnection(
    { CHUNKY_HOME: state, CHUNKY_WORKSPACE: "/wanted", CHUNKY_RUNTIME_DIR: runtime.root },
    deps,
  )

  expect(result.baseUrl).toBe("http://localhost:43210")
  expect(result.connectionError).toBeUndefined()
})
