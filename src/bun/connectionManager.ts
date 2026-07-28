import { createHash, randomBytes, randomUUID } from "node:crypto"
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"

const SERVER_IDENTITY_PATH = "/_chunky/server-identity"
const SERVER_LEASES_PATH = "/_chunky/server-leases"
const INFO_PATH = "/api/info"
const STARTUP_TIMEOUT_MS = 15_000

type RecordFile = {
  schema: 1
  id: string
  workspace: string
  version: string
  buildId: string
  nonce: string
  port: number
  pid: number
  startedAt: number
}

type Identity = Pick<RecordFile, "id" | "workspace" | "version" | "buildId" | "nonce" | "port">

export type RuntimeConnection = {
  baseUrl: string
  workspace: string
  serverToken?: string
  /** A safe user-facing reason when no server could be resolved or started. */
  connectionError?: string
}

export type ConnectionDependencies = {
  fetch: typeof fetch
  now(): number
  sleep(ms: number): Promise<void>
  spawn(command: string[], options: { cwd: string; env: Record<string, string | undefined> }): { pid?: number }
  allocatePort?(): Promise<number>
}

const defaults: ConnectionDependencies = {
  fetch,
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  spawn: (command, options) => Bun.spawn(command, { ...options, stdout: "ignore", stderr: "ignore" }),
}

function canonicalWorkspace(path: string): string {
  const absolute = resolve(path)
  try { return realpathSync.native(absolute) } catch { return absolute }
}

function stateDir(env: NodeJS.ProcessEnv): string {
  return env.CHUNKY_HOME || join(homedir(), ".chunky", "state")
}

function settingsPath(env: NodeJS.ProcessEnv, state: string): string {
  return env.CHUNKY_SETTINGS || join(state, "settings.json")
}

function desktopWorkspace(env: NodeJS.ProcessEnv, state: string): string | undefined {
  if (env.CHUNKY_WORKSPACE?.trim()) return canonicalWorkspace(env.CHUNKY_WORKSPACE)
  try {
    const saved = JSON.parse(readFileSync(join(state, "desktop.json"), "utf8")) as { workspace?: unknown }
    return typeof saved.workspace === "string" && saved.workspace ? canonicalWorkspace(saved.workspace) : undefined
  } catch {
    return undefined
  }
}

function persistDesktopWorkspace(state: string, workspace: string): void {
  try {
    mkdirSync(state, { recursive: true })
    writeFileSync(join(state, "desktop.json"), JSON.stringify({ workspace }, null, 2), { mode: 0o600 })
  } catch {}
}

function loadToken(path: string): string | undefined {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as { serverToken?: unknown }
    return typeof value.serverToken === "string" && value.serverToken ? value.serverToken : undefined
  } catch {
    return undefined
  }
}

// Mirrors Chunky's getServerToken(): create one only when this app is starting
// the canonical server and settings did not yet exist.
function ensureToken(path: string): string {
  const existing = loadToken(path)
  if (existing) return existing
  let settings: Record<string, unknown> = {}
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"))
    if (parsed && typeof parsed === "object") settings = parsed as Record<string, unknown>
  } catch {}
  const token = randomBytes(32).toString("hex")
  mkdirSync(resolve(path, ".."), { recursive: true })
  writeFileSync(path, JSON.stringify({ ...settings, serverToken: token }, null, 2), { mode: 0o600 })
  return token
}

function validRecord(value: unknown): value is RecordFile {
  if (!value || typeof value !== "object") return false
  const x = value as Partial<RecordFile>
  return x.schema === 1 && typeof x.id === "string" && typeof x.workspace === "string"
    && typeof x.version === "string" && typeof x.buildId === "string" && typeof x.nonce === "string"
    && Number.isInteger(x.port) && (x.port ?? 0) > 0 && Number.isInteger(x.pid)
    && typeof x.startedAt === "number"
}

function records(dir: string): RecordFile[] {
  try {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      if (!entry.isFile() || !entry.name.endsWith(".json")) return []
      try {
        const value: unknown = JSON.parse(readFileSync(join(dir, entry.name), "utf8"))
        return validRecord(value) ? [value] : []
      } catch { return [] }
    })
  } catch { return [] }
}

async function healthy(record: RecordFile, token: string | undefined, deps: ConnectionDependencies): Promise<boolean> {
  const baseUrl = `http://127.0.0.1:${record.port}`
  try {
    const identityResponse = await deps.fetch(baseUrl + SERVER_IDENTITY_PATH, { signal: AbortSignal.timeout(1_000) })
    if (!identityResponse.ok) return false
    const identity = await identityResponse.json() as Partial<Identity>
    if (identity.id !== record.id || identity.workspace !== record.workspace || identity.version !== record.version
      || identity.buildId !== record.buildId || identity.nonce !== record.nonce || identity.port !== record.port) return false
    const info = await deps.fetch(baseUrl + INFO_PATH, {
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      signal: AbortSignal.timeout(1_000),
    })
    return info.ok
  } catch { return false }
}

/**
 * Pick only authenticated, identity-verified launcher records. A requested
 * workspace wins; otherwise the newest healthy record wins. This lets Finder
 * launches reuse a live CLI server without assuming a fixed development port.
 */
export async function selectHealthyRecord(
  serverDir: string,
  token: string | undefined,
  preferredWorkspace: string | undefined,
  deps: ConnectionDependencies = defaults,
): Promise<RecordFile | undefined> {
  const verified = (await Promise.all(records(serverDir).map(async (record) =>
    (await healthy(record, token, deps)) ? record : undefined,
  ))).filter((record): record is RecordFile => !!record)
  verified.sort((a, b) => {
    const workspaceOrder = Number(b.workspace === preferredWorkspace) - Number(a.workspace === preferredWorkspace)
    return workspaceOrder || b.startedAt - a.startedAt || b.port - a.port
  })
  return verified[0]
}

function buildId(runtime: string): string {
  const files = ["chunky.ts", "package.json", "bun.lock"]
  for (const sourceRoot of ["packages/protocol/src", "packages/server/src", "packages/tui/src"]) {
    const root = join(runtime, sourceRoot)
    if (!existsSync(root)) continue
    const visit = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) visit(path)
        else if (!/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(entry.name) && !entry.name.endsWith(".manual.ts")) {
          files.push(path.slice(runtime.length + 1))
        }
      }
    }
    visit(root)
  }
  const hash = createHash("sha256")
  for (const relative of [...new Set(files)].sort()) {
    const path = join(runtime, relative)
    if (existsSync(path)) hash.update(relative).update("\0").update(readFileSync(path)).update("\0")
  }
  return hash.digest("hex").slice(0, 24)
}

function runtime(env: NodeJS.ProcessEnv): { root: string; bun: string; version: string } | undefined {
  const root = env.CHUNKY_RUNTIME_DIR || join(homedir(), ".chunky", "app")
  // Finder does not inherit a shell PATH. Prefer an explicit override, then
  // the standard Bun install, then Electrobun's own Bun executable.
  const bundledBun = process.execPath
  const bun = env.CHUNKY_BUN_PATH
    || (existsSync(join(homedir(), ".bun", "bin", "bun")) ? join(homedir(), ".bun", "bin", "bun") : bundledBun)
  if (!existsSync(join(root, "packages", "server", "src", "index.ts")) || !existsSync(join(root, "package.json"))) return undefined
  try {
    const version = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version?: unknown }).version
    if (typeof version !== "string" || !version) return undefined
    return { root, bun: existsSync(bun) ? bun : "bun", version }
  } catch { return undefined }
}

async function freePort(): Promise<number> {
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } })
  const port = listener.port
  listener.stop()
  return port
}

function recordKey(workspace: string, version: string, id: string): string {
  return createHash("sha256").update(`${workspace}\0${version}\0${id}`).digest("hex").slice(0, 24)
}

async function acquireLock(lock: string, deps: ConnectionDependencies): Promise<() => void> {
  const deadline = deps.now() + STARTUP_TIMEOUT_MS
  while (deps.now() < deadline) {
    try {
      mkdirSync(lock)
      return () => rmSync(lock, { recursive: true, force: true })
    } catch {
      try {
        if (deps.now() - statSync(lock).mtimeMs > 30_000) rmSync(lock, { recursive: true, force: true })
      } catch {}
      await deps.sleep(100)
    }
  }
  throw new Error("Timed out waiting for another Chunky server startup")
}

async function startServer(
  state: string,
  settings: string,
  workspace: string,
  token: string,
  env: NodeJS.ProcessEnv,
  deps: ConnectionDependencies,
): Promise<RecordFile> {
  const installed = runtime(env)
  if (!installed) throw new Error("Chunky CLI runtime was not found. Install it with the Chunky CLI, then reopen Chunky.app.")
  const targetWorkspace = canonicalWorkspace(workspace)
  const id = buildId(installed.root)
  const serverDir = join(state, "servers")
  mkdirSync(serverDir, { recursive: true })
  const lock = join(serverDir, `${recordKey(targetWorkspace, installed.version, id)}.lock`)
  const release = await acquireLock(lock, deps)
  try {
    const existing = await selectHealthyRecord(serverDir, token, targetWorkspace, deps)
    if (existing && existing.workspace === targetWorkspace && existing.version === installed.version && existing.buildId === id) return existing
    const port = deps.allocatePort ? await deps.allocatePort() : await freePort()
    const nonce = randomUUID()
    const record: RecordFile = {
      schema: 1, id: randomUUID(), workspace: targetWorkspace, version: installed.version, buildId: id,
      nonce, port, pid: 0, startedAt: deps.now(),
    }
    const child = deps.spawn([installed.bun, "run", join(installed.root, "packages/server/src/index.ts")], {
      cwd: state,
      env: {
        ...env,
        CHUNKY_PORT: String(port), CHUNKY_WORKSPACE: targetWorkspace, CHUNKY_VERSION: installed.version,
        CHUNKY_BUILD_ID: id, CHUNKY_SERVER_NONCE: nonce, CHUNKY_SERVER_ID: record.id,
        CHUNKY_DISCOVERY_RECORD: join(serverDir, `${recordKey(targetWorkspace, installed.version, id)}.json`),
        CHUNKY_DB: join(state, "chunky.db"), CHUNKY_GRAPH_DB: join(state, "chunky-graph.db"),
        CHUNKY_SETTINGS: settings, CHUNKY_AUTH: join(state, "auth.json"),
      },
    })
    if (!child.pid) throw new Error("Chunky server could not be started")
    record.pid = child.pid
    const recordPath = join(serverDir, `${recordKey(targetWorkspace, installed.version, id)}.json`)
    writeFileSync(recordPath, JSON.stringify(record, null, 2), { mode: 0o600 })
    const deadline = deps.now() + STARTUP_TIMEOUT_MS
    while (deps.now() < deadline) {
      if (await healthy(record, token, deps)) return record
      await deps.sleep(100)
    }
    rmSync(recordPath, { force: true })
    throw new Error("Chunky server did not become ready within 15 seconds")
  } finally { release() }
}

async function updateLease(record: RecordFile, serverToken: string, leaseToken: string, action: "attach" | "release", deps: ConnectionDependencies): Promise<void> {
  try {
    await deps.fetch(`http://127.0.0.1:${record.port}${SERVER_LEASES_PATH}`, {
      method: action === "attach" ? "POST" : "DELETE",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${serverToken}` },
      body: JSON.stringify({ token: leaseToken }),
      signal: AbortSignal.timeout(1_000),
    })
  } catch {}
}

let resolving: Promise<RuntimeConnection> | undefined
let activeLease: { record: RecordFile; serverToken: string; leaseToken: string; deps: ConnectionDependencies; timer: ReturnType<typeof setInterval> } | undefined

function maintainLease(record: RecordFile, serverToken: string, deps: ConnectionDependencies): void {
  if (activeLease?.record.port === record.port) return
  if (activeLease) void releaseChunkyConnection()
  const leaseToken = randomUUID()
  void updateLease(record, serverToken, leaseToken, "attach", deps)
  const timer = setInterval(() => void updateLease(record, serverToken, leaseToken, "attach", deps), 10_000)
  timer.unref?.()
  activeLease = { record, serverToken, leaseToken, deps, timer }
}

/** Release only this app's launcher lease; never terminate a shared server. */
export async function releaseChunkyConnection(): Promise<void> {
  const lease = activeLease
  activeLease = undefined
  if (!lease) return
  clearInterval(lease.timer)
  await updateLease(lease.record, lease.serverToken, lease.leaseToken, "release", lease.deps)
}

/** Test-only reset for isolated resolver tests. Not used by the app runtime. */
export async function resetChunkyConnectionForTest(): Promise<void> {
  resolving = undefined
  await releaseChunkyConnection()
}

/** Persist the workspace selected in the desktop UI for deterministic reuse. */
export function rememberChunkyWorkspace(path: string, env = process.env): void {
  if (!path.trim()) return
  persistDesktopWorkspace(stateDir(env), canonicalWorkspace(path))
  resolving = undefined
}

export function resolveChunkyConnection(env = process.env, deps: ConnectionDependencies = defaults): Promise<RuntimeConnection> {
  if (env.CHUNKY_URL) {
    const state = stateDir(env)
    return Promise.resolve({
      baseUrl: env.CHUNKY_URL,
      workspace: env.CHUNKY_WORKSPACE || "",
      serverToken: loadToken(settingsPath(env, state)),
    })
  }
  if (env.CHUNKY_PORT) {
    const state = stateDir(env)
    return Promise.resolve({
      baseUrl: `http://localhost:${env.CHUNKY_PORT}`,
      workspace: env.CHUNKY_WORKSPACE || "",
      serverToken: loadToken(settingsPath(env, state)),
    })
  }
  if (!resolving) resolving = (async () => {
    const state = stateDir(env)
    const settings = settingsPath(env, state)
    const workspace = desktopWorkspace(env, state)
    const token = loadToken(settings)
    const found = await selectHealthyRecord(join(state, "servers"), token, workspace, deps)
    if (found) {
      if (token) maintainLease(found, token, deps)
      return { baseUrl: `http://localhost:${found.port}`, workspace: found.workspace, serverToken: token }
    }
    try {
      const startedToken = ensureToken(settings)
      const started = await startServer(state, settings, workspace || homedir(), startedToken, env, deps)
      maintainLease(started, startedToken, deps)
      return { baseUrl: `http://localhost:${started.port}`, workspace: started.workspace, serverToken: startedToken }
    } catch (error) {
      return { baseUrl: "", workspace: workspace || "", connectionError: error instanceof Error ? error.message : "Chunky server is unavailable" }
    }
  })()
  return resolving
}
