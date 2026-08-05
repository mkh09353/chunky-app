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
import {
  mergeDesktopState,
  readDesktopState,
  stateDir as desktopStateDir,
} from "./desktopState"
import {
  hasRuntime,
  installRuntime,
  resolveBun,
  runtimeRoot,
  upgradeRuntime,
  type RuntimeUpgrade,
} from "./runtimeInstaller"
import { ensureChunkyServerLauncher } from "./launcherSymlink"
import { reportSetupStage, type SetupStage } from "./setupStatus"

const SERVER_IDENTITY_PATH = "/_chunky/server-identity"
const SERVER_LEASES_PATH = "/_chunky/server-leases"
const INFO_PATH = "/api/info"
const STARTUP_TIMEOUT_MS = 15_000

export type RecordFile = {
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

export type Identity = Pick<RecordFile, "id" | "workspace" | "version" | "buildId" | "nonce" | "port"> & {
  /** Set by servers that are draining after being superseded (additive: older
   *  servers simply omit it). Such a server must not be handed new clients. */
  retiring?: boolean
}

/** The runtime this app would start a server from. */
type RuntimeIdentity = { version: string; buildId: string }

/** A discovery record plus the file it came from, so it can be retired. */
type RecordEntry = { path: string; record: RecordFile }

interface SelectOptions {
  /** Prefer servers built from this runtime over older ones. */
  prefer?: RuntimeIdentity
  /** Delete records whose server is gone (dead pid and unreachable port). */
  prune?: boolean
}

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
  log?(message: string): void
  allocatePort?(): Promise<number>
  installRuntime?(env: NodeJS.ProcessEnv): Promise<void>
  upgradeRuntime?(env: NodeJS.ProcessEnv): Promise<RuntimeUpgrade>
  /** Best-effort first-run progress sink; failures never affect resolution. */
  report?(stage: SetupStage): void
  /** Whether a recorded process still exists (guards record pruning). */
  pidAlive?(pid: number): boolean
  launcherFs?: import("./launcherSymlink").LauncherSymlinkFs
}

const defaults: ConnectionDependencies = {
  fetch,
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  spawn: (command, options) => Bun.spawn(command, { ...options, stdout: "ignore", stderr: "ignore" }),
  log: (message) => console.log(message),
  report: reportSetupStage,
  installRuntime,
  pidAlive: (pid) => {
    if (!Number.isInteger(pid) || pid <= 0) return false
    try {
      process.kill(pid, 0)
      return true
    } catch (error) {
      // EPERM means the process exists but belongs to somebody else.
      return (error as NodeJS.ErrnoException).code === "EPERM"
    }
  },
}

function canonicalWorkspace(path: string): string {
  const absolute = resolve(path)
  try { return realpathSync.native(absolute) } catch { return absolute }
}

/** Desktop-owned persistent state. Do not use the replaceable runtime directory. */
export function stateDir(env: NodeJS.ProcessEnv = process.env): string {
  return desktopStateDir(env)
}

function settingsPath(env: NodeJS.ProcessEnv, state: string): string {
  return env.CHUNKY_SETTINGS || join(state, "settings.json")
}

function desktopWorkspace(env: NodeJS.ProcessEnv): string | undefined {
  if (env.CHUNKY_WORKSPACE?.trim()) return canonicalWorkspace(env.CHUNKY_WORKSPACE)
  const saved = readDesktopState(env).workspace
  return saved ? canonicalWorkspace(saved) : undefined
}

/** desktop.json also holds renderer UI state (open tab, per-tab thread), so the
 *  workspace must be merged in, never written over the whole document. */
function persistDesktopWorkspace(env: NodeJS.ProcessEnv, workspace: string): void {
  mergeDesktopState({ workspace }, env)
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

export function recordEntries(dir: string): RecordEntry[] {
  try {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      if (!entry.isFile() || !entry.name.endsWith(".json")) return []
      const path = join(dir, entry.name)
      try {
        const value: unknown = JSON.parse(readFileSync(path, "utf8"))
        return validRecord(value) ? [{ path, record: value }] : []
      } catch { return [] }
    })
  } catch { return [] }
}

/** The live identity of a recorded server, or null when it isn't answering as
 *  the server this record describes. */
export async function probe(
  record: RecordFile,
  token: string | undefined,
  deps: ConnectionDependencies,
): Promise<Identity | null> {
  const baseUrl = `http://127.0.0.1:${record.port}`
  try {
    const identityResponse = await deps.fetch(baseUrl + SERVER_IDENTITY_PATH, { signal: AbortSignal.timeout(1_000) })
    if (!identityResponse.ok) return null
    const identity = await identityResponse.json() as Partial<Identity>
    if (identity.id !== record.id || identity.workspace !== record.workspace || identity.version !== record.version
      || identity.buildId !== record.buildId || identity.nonce !== record.nonce || identity.port !== record.port) return null
    const info = await deps.fetch(baseUrl + INFO_PATH, {
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      signal: AbortSignal.timeout(1_000),
    })
    return info.ok ? (identity as Identity) : null
  } catch { return null }
}

async function healthy(record: RecordFile, token: string | undefined, deps: ConnectionDependencies): Promise<boolean> {
  return !!(await probe(record, token, deps))
}

/** Was this server built from the runtime we would start today? */
function matchesRuntime(record: RecordFile, runtime: RuntimeIdentity): boolean {
  return record.version === runtime.version && record.buildId === runtime.buildId
}

/**
 * Retire a server this app did not start, the only safe way: take its discovery
 * record away. Its ownership poller notices and drains (finishing in-flight
 * runs first). We never signal its pid — that process is not ours to kill.
 * Re-reads the file so a record another launcher has already replaced is left
 * alone.
 */
export function supersedeRecord(entry: RecordEntry): boolean {
  try {
    const current: unknown = JSON.parse(readFileSync(entry.path, "utf8"))
    if (!validRecord(current) || current.id !== entry.record.id) return false
    rmSync(entry.path, { force: true })
    return true
  } catch { return false }
}

/**
 * Pick only authenticated, identity-verified launcher records. A requested
 * workspace wins, then a server built from the installed runtime, then the
 * newest. This lets Finder launches reuse a live CLI server without assuming a
 * fixed development port, while never preferring a build we have replaced.
 *
 * A server that reports `retiring` is skipped: it is draining and will not take
 * new work. Records whose server is gone (unreachable AND no live pid) are
 * pruned when asked, so discovery does not accumulate dead entries forever.
 */
export async function selectHealthyEntry(
  serverDir: string,
  token: string | undefined,
  preferredWorkspace: string | undefined,
  deps: ConnectionDependencies = defaults,
  options: SelectOptions = {},
): Promise<RecordEntry | undefined> {
  const pidAlive = deps.pidAlive ?? defaults.pidAlive!
  const verified = (await Promise.all(recordEntries(serverDir).map(async (entry) => {
    const identity = await probe(entry.record, token, deps)
    if (!identity) {
      // Only prune what is provably gone: a live process that merely failed to
      // answer in time keeps its record (deleting it would retire it).
      if (options.prune && !pidAlive(entry.record.pid)) rmSync(entry.path, { force: true })
      return undefined
    }
    return identity.retiring === true ? undefined : entry
  }))).filter((entry): entry is RecordEntry => !!entry)
  const prefer = options.prefer
  verified.sort((a, b) => {
    const workspaceOrder = Number(b.record.workspace === preferredWorkspace) - Number(a.record.workspace === preferredWorkspace)
    if (workspaceOrder) return workspaceOrder
    const runtimeOrder = prefer
      ? Number(matchesRuntime(b.record, prefer)) - Number(matchesRuntime(a.record, prefer))
      : 0
    return runtimeOrder || b.record.startedAt - a.record.startedAt || b.record.port - a.record.port
  })
  return verified[0]
}

export async function selectHealthyRecord(
  serverDir: string,
  token: string | undefined,
  preferredWorkspace: string | undefined,
  deps: ConnectionDependencies = defaults,
  options: SelectOptions = {},
): Promise<RecordFile | undefined> {
  return (await selectHealthyEntry(serverDir, token, preferredWorkspace, deps, options))?.record
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
  const root = runtimeRoot(env)
  if (!hasRuntime(root)) return undefined
  try {
    const version = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version?: unknown }).version
    if (typeof version !== "string" || !version) return undefined
    return { root, bun: resolveBun(env), version }
  } catch { return undefined }
}

/** {version, buildId} of the runtime this app would start a server from, or
 *  undefined when no runtime is installed yet. Exported so callers (and tests)
 *  can tell an up-to-date server from one built by a replaced runtime. */
export function installedRuntimeIdentity(env: NodeJS.ProcessEnv = process.env): RuntimeIdentity | undefined {
  const installed = runtime(env)
  if (!installed) return undefined
  try {
    return { version: installed.version, buildId: buildId(installed.root) }
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

/** Never let a progress push break connection resolution. */
function announce(deps: ConnectionDependencies, stage: SetupStage): void {
  try {
    deps.report?.(stage)
  } catch {
    /* best-effort by design */
  }
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
  let installed = runtime(env)
  if (!installed) {
    try {
      await (deps.installRuntime || installRuntime)(env)
    } catch (error) {
      throw new Error(`Failed to install the Chunky server automatically: ${error instanceof Error ? error.message : "unknown error"}`)
    }
    installed = runtime(env)
    if (!installed) throw new Error("Failed to install the Chunky server automatically: the installed runtime could not be resolved.")
  }
  const targetWorkspace = canonicalWorkspace(workspace)
  const id = buildId(installed.root)
  const serverDir = join(state, "servers")
  mkdirSync(serverDir, { recursive: true })
  const lock = join(serverDir, `${recordKey(targetWorkspace, installed.version, id)}.lock`)
  const release = await acquireLock(lock, deps)
  try {
    // Reuse only a server built from THIS runtime: a healthy older build is
    // superseded by the caller, not adopted.
    const existing = await selectHealthyRecord(serverDir, token, targetWorkspace, deps, {
      prefer: { version: installed.version, buildId: id },
    })
    if (existing && existing.workspace === targetWorkspace
      && existing.version === installed.version && existing.buildId === id) {
      return existing
    }
    announce(deps, { kind: "starting" })
    const port = deps.allocatePort ? await deps.allocatePort() : await freePort()
    const nonce = randomUUID()
    const record: RecordFile = {
      schema: 1, id: randomUUID(), workspace: targetWorkspace, version: installed.version, buildId: id,
      nonce, port, pid: 0, startedAt: deps.now(),
    }
    const launcher = ensureChunkyServerLauncher(installed.root, installed.bun, deps.launcherFs)
    const serverArgs = ["run", join(installed.root, "packages/server/src/index.ts")]
    let child: { pid?: number }
    try {
      child = deps.spawn([launcher || installed.bun, ...serverArgs], {
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
    } catch (error) {
      if (!launcher) throw error
      child = deps.spawn([installed.bun, ...serverArgs], {
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
    }
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

/**
 * Forget the memoized resolution and resolve again. Used when a client can no
 * longer reach its server (it was superseded by a newer runtime, or died): the
 * next resolve prunes dead records, prefers a server built from the installed
 * runtime, and may start one.
 */
export function refreshChunkyConnection(
  env = process.env,
  deps: ConnectionDependencies = defaults,
): Promise<RuntimeConnection> {
  resolving = undefined
  return resolveChunkyConnection(env, deps)
}

let upgrading: Promise<RuntimeUpgradeResult> | undefined

export interface RuntimeUpgradeResult {
  upgraded: boolean
  version?: string
  /** The connection to use after an upgrade (a server built from it). */
  connection?: RuntimeConnection
}

/**
 * Replace a stale installed runtime and move onto a server built from it.
 *
 * The handover is the phase-1 mechanism, not something special-cased here:
 * re-resolving prefers a server matching the freshly installed runtime, starts
 * one, and retires the superseded server through its discovery record — which
 * drains its in-flight runs before exiting.
 *
 * Never throws: a failed upgrade leaves the working runtime (and its server)
 * exactly as they were.
 */
export function upgradeRuntimeAndReconnect(
  env = process.env,
  deps: ConnectionDependencies = defaults,
): Promise<RuntimeUpgradeResult> {
  // One upgrade at a time; a second trigger joins the first.
  if (upgrading) return upgrading
  upgrading = (async () => {
    try {
      const upgrade = await (deps.upgradeRuntime || upgradeRuntime)(env)
      if (upgrade.status !== "upgraded") return { upgraded: false, version: upgrade.version }
      deps.log?.(`[@chunky/app] Chunky server updated to v${upgrade.version}${upgrade.previousVersion ? ` (from v${upgrade.previousVersion})` : ""}`)
      const connection = await refreshChunkyConnection(env, deps)
      return { upgraded: true, version: upgrade.version, connection }
    } catch (error) {
      deps.log?.(`[@chunky/app] Chunky server update skipped: ${error instanceof Error ? error.message : "unknown error"}`)
      return { upgraded: false }
    } finally {
      upgrading = undefined
    }
  })()
  return upgrading
}

/** Persist the workspace selected in the desktop UI for deterministic reuse. */
export function rememberChunkyWorkspace(path: string, env = process.env): void {
  if (!path.trim()) return
  persistDesktopWorkspace(env, canonicalWorkspace(path))
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
    const workspace = desktopWorkspace(env)
    const token = loadToken(settings)
    const installed = installedRuntimeIdentity(env)
    // Pruning happens here (once per launch), so dead records from crashed or
    // long-superseded servers do not pile up in the discovery directory.
    const found = await selectHealthyEntry(join(state, "servers"), token, workspace, deps, {
      prefer: installed,
      prune: true,
    })
    const stale = !!found && !!installed && !matchesRuntime(found.record, installed)
    if (found && !stale) {
      if (token) maintainLease(found.record, token, deps)
      return { baseUrl: `http://localhost:${found.record.port}`, workspace: found.record.workspace, serverToken: token }
    }
    if (found && stale) {
      deps.log?.(`[@chunky/app] Chunky v${found.record.version} server for ${found.record.workspace} predates runtime v${installed!.version}; starting a v${installed!.version} server`)
    }
    try {
      const startedToken = ensureToken(settings)
      const started = await startServer(state, settings, workspace || homedir(), startedToken, env, deps)
      // Retire the superseded server only once its replacement is serving, and
      // only for the workspace we just took over.
      if (found && stale && found.record.workspace === started.workspace) {
        if (activeLease?.record.port === found.record.port) await releaseChunkyConnection()
        if (supersedeRecord(found)) {
          deps.log?.(`[@chunky/app] retiring superseded Chunky v${found.record.version} server on port ${found.record.port}`)
        }
      }
      maintainLease(started, startedToken, deps)
      return { baseUrl: `http://localhost:${started.port}`, workspace: started.workspace, serverToken: startedToken }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Chunky server is unavailable"
      // A stale-but-healthy server beats no server at all: keep the user
      // working on the old build rather than failing the launch.
      if (found) {
        deps.log?.(`[@chunky/app] could not start a newer Chunky server (${message}); using the existing v${found.record.version} server`)
        if (token) maintainLease(found.record, token, deps)
        return { baseUrl: `http://localhost:${found.record.port}`, workspace: found.record.workspace, serverToken: token }
      }
      return { baseUrl: "", workspace: workspace || "", connectionError: message }
    }
  })()
  return resolving
}
