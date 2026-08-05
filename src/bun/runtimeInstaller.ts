import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, join } from "node:path"
import { reportSetupStage, type SetupStage } from "./setupStatus"

const RELEASE_URL = "https://api.github.com/repos/mkh09353/chunky/releases/latest"
// A real install (release download + bun install) can take minutes; wait
// generously and only reap locks that are clearly abandoned.
const INSTALL_TIMEOUT_MS = 10 * 60_000
const STALE_LOCK_MS = 15 * 60_000

type Release = {
  tag_name?: unknown
  assets?: Array<{ name?: unknown; browser_download_url?: unknown }>
}

type ExecResult = { exitCode: number; stderr?: string }

export type RuntimeInstallerDependencies = {
  fetch: typeof fetch
  now(): number
  sleep(ms: number): Promise<void>
  exec(command: string[], options: { cwd: string }): ExecResult
  /** Allows tests to isolate filesystem locations without mutating process.env. */
  homeDir: string
  platform: NodeJS.Platform
  arch: string
  log(message: string): void
  /** Best-effort progress sink; failures here never affect the install. */
  report(stage: SetupStage): void
}

const defaults: RuntimeInstallerDependencies = {
  fetch,
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  exec: (command, options) => {
    const result = Bun.spawnSync(command, { cwd: options.cwd, stdout: "ignore", stderr: "pipe" })
    return { exitCode: result.exitCode, stderr: new TextDecoder().decode(result.stderr) }
  },
  homeDir: homedir(),
  platform: process.platform,
  arch: process.arch,
  log: (message) => console.log(message),
  report: reportSetupStage,
}

export function runtimeRoot(env: NodeJS.ProcessEnv, home = homedir()): string {
  return env.CHUNKY_RUNTIME_DIR || join(home, ".chunky", "app")
}

/** The version of the runtime installed at `root`, if it has one. */
export function installedRuntimeVersion(root: string): string | undefined {
  try {
    const version = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version?: unknown }).version
    return typeof version === "string" && version ? version : undefined
  } catch {
    return undefined
  }
}

/**
 * Compare dotted versions: -1 when `a` is older, 1 when newer, 0 when the same.
 * A prerelease suffix (1.2.3-beta.1) ranks BELOW the release it precedes, which
 * is what keeps a local prerelease from being "upgraded" in a loop.
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const split = (value: string) => {
    const [core = "", pre = ""] = value.replace(/^v/, "").split("-", 2)
    return { parts: core.split(".").map((part) => Number.parseInt(part, 10) || 0), pre }
  }
  const left = split(a)
  const right = split(b)
  const length = Math.max(left.parts.length, right.parts.length)
  for (let index = 0; index < length; index++) {
    const one = left.parts[index] ?? 0
    const other = right.parts[index] ?? 0
    if (one !== other) return one > other ? 1 : -1
  }
  if (left.pre === right.pre) return 0
  if (!left.pre) return 1
  if (!right.pre) return -1
  return left.pre > right.pre ? 1 : -1
}

export function hasRuntime(root: string): boolean {
  if (!existsSync(join(root, "packages", "server", "src", "index.ts")) || !existsSync(join(root, "package.json"))) return false
  try {
    const version = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version?: unknown }).version
    return typeof version === "string" && version.length > 0
  } catch {
    return false
  }
}

export function resolveBun(env: NodeJS.ProcessEnv, home = homedir()): string {
  if (env.CHUNKY_BUN_PATH) return env.CHUNKY_BUN_PATH
  const userBun = join(home, ".bun", "bin", "bun")
  if (existsSync(userBun)) return userBun
  const chunkyBun = join(home, ".chunky", "bun", "bin", "bun")
  if (existsSync(chunkyBun)) return chunkyBun
  return process.execPath
}

function platformId(platform: NodeJS.Platform, arch: string): string | undefined {
  if (platform === "darwin" && arch === "arm64") return "darwin-arm64"
  if (platform === "darwin" && arch === "x64") return "darwin-x64"
  if (platform === "linux" && (arch === "arm64" || arch === "aarch64")) return "linux-arm64"
  if (platform === "linux" && arch === "x64") return "linux-x64"
  return undefined
}

function findClaudeBinary(root: string, platform: string): string | undefined {
  const nodeModules = join(root, "node_modules")
  const visit = (dir: string): string | undefined => {
    let entries: import("node:fs").Dirent[]
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return undefined }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        const found = visit(path)
        if (found) return found
      } else if (entry.name === "claude" && path.includes(`claude-agent-sdk-${platform}`)) return path
    }
    return undefined
  }
  return visit(nodeModules)
}

async function acquireInstallLock(lock: string, deps: RuntimeInstallerDependencies): Promise<() => void> {
  const deadline = deps.now() + INSTALL_TIMEOUT_MS
  while (deps.now() < deadline) {
    try {
      mkdirSync(lock)
      return () => rmSync(lock, { recursive: true, force: true })
    } catch {
      try {
        if (deps.now() - statSync(lock).mtimeMs > STALE_LOCK_MS) rmSync(lock, { recursive: true, force: true })
      } catch {}
      await deps.sleep(100)
    }
  }
  throw new Error("Timed out waiting for another Chunky runtime installation")
}

function run(command: string[], cwd: string, deps: RuntimeInstallerDependencies, description: string): void {
  const result = deps.exec(command, { cwd })
  if (result.exitCode !== 0) throw new Error(`${description}${result.stderr?.trim() ? `: ${result.stderr.trim()}` : ""}`)
}

interface LatestRelease {
  tag: string
  downloadUrl: string
}

/** Never let a progress push break the thing it is describing. */
function announce(deps: RuntimeInstallerDependencies, stage: SetupStage): void {
  try {
    deps.report(stage)
  } catch {
    /* best-effort by design */
  }
}

/**
 * Read the archive body, reporting whole-percent progress when the server told
 * us how big it is. Falls back to the plain buffered read when the response has
 * no readable stream (older runtimes, test doubles) — the bytes written are the
 * same either way, so this stays pure instrumentation.
 */
async function readArchive(
  response: Response,
  tag: string,
  deps: RuntimeInstallerDependencies,
): Promise<Uint8Array> {
  // One reader for the whole body: acquiring a second one locks the stream.
  const reader = typeof response.body?.getReader === "function" ? response.body.getReader() : null
  if (!reader) {
    announce(deps, { kind: "downloading", version: tag })
    return new Uint8Array(await response.arrayBuffer())
  }

  const declared = Number(response.headers.get("content-length") ?? "")
  const total = Number.isFinite(declared) && declared > 0 ? declared : undefined
  announce(deps, { kind: "downloading", version: tag, percent: total ? 0 : undefined })

  const chunks: Uint8Array[] = []
  let received = 0
  let lastPercent = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    chunks.push(value)
    received += value.byteLength
    if (!total) continue
    // Whole percents only: a chunk-per-message stream would otherwise push
    // thousands of RPC messages across a multi-megabyte download.
    const percent = Math.min(99, Math.floor((received / total) * 100))
    if (percent > lastPercent) {
      lastPercent = percent
      announce(deps, { kind: "downloading", version: tag, percent })
    }
  }

  const bytes = new Uint8Array(received)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

/** The newest published runtime release (tag + tarball URL). */
async function fetchLatestRelease(deps: RuntimeInstallerDependencies): Promise<LatestRelease> {
  announce(deps, { kind: "checking" })
  let response: Response
  try {
    response = await deps.fetch(RELEASE_URL, { headers: { Accept: "application/vnd.github+json" } })
  } catch (error) {
    throw new Error(`Could not check GitHub for the latest Chunky release. Check your network connection or GitHub API rate limit and retry. (${error instanceof Error ? error.message : "request failed"})`)
  }
  if (!response.ok) throw new Error(`Could not check GitHub for the latest Chunky release (HTTP ${response.status}). GitHub may be rate limiting unauthenticated requests; wait and retry.`)

  let latest: Release
  try { latest = await response.json() as Release } catch { throw new Error("GitHub returned an invalid latest-release response. Please retry.") }
  const asset = latest.assets?.find((candidate) => typeof candidate.name === "string" && /\.tar\.gz$|\.tgz$/.test(candidate.name) && typeof candidate.browser_download_url === "string")
  const tag = typeof latest.tag_name === "string" ? latest.tag_name.replace(/^v/, "") : ""
  if (!asset || !tag) throw new Error("The latest Chunky release did not include a versioned .tar.gz or .tgz runtime archive.")
  return { tag, downloadUrl: asset.browser_download_url as string }
}

/**
 * Download `release` into `<root>.new`, install its dependencies and verify it.
 * Nothing touches the live runtime, so any failure in here leaves the installed
 * one exactly as it was.
 */
async function stageRelease(
  release: LatestRelease,
  env: NodeJS.ProcessEnv,
  paths: { root: string; parent: string; temporary: string; archive: string },
  deps: RuntimeInstallerDependencies,
): Promise<void> {
  const { parent, temporary, archive } = paths
  const tag = release.tag
  {
    let archiveResponse: Response
    try { archiveResponse = await deps.fetch(release.downloadUrl) } catch (error) {
      throw new Error(`Could not download the Chunky runtime archive. Check your network connection and retry. (${error instanceof Error ? error.message : "request failed"})`)
    }
    if (!archiveResponse.ok) throw new Error(`Could not download the Chunky runtime archive (HTTP ${archiveResponse.status}). Please retry.`)
    let bytes: Uint8Array
    try { bytes = await readArchive(archiveResponse, tag, deps) } catch (error) {
      throw new Error(`Could not download the Chunky runtime archive. Check your network connection and retry. (${error instanceof Error ? error.message : "read failed"})`)
    }
    writeFileSync(archive, bytes)

    announce(deps, { kind: "extracting", version: tag })
    rmSync(temporary, { recursive: true, force: true })
    mkdirSync(temporary, { recursive: true })
    run(["tar", "-xzf", archive, "--strip-components=1", "-C", temporary], parent, deps, "Could not extract the Chunky runtime archive")
    const bun = resolveBun(env, deps.homeDir)
    announce(deps, { kind: "installing", version: tag, attempt: 1 })
    run([bun, "install", "--ignore-scripts"], temporary, deps, "Could not install Chunky runtime dependencies")

    const platform = platformId(deps.platform, deps.arch)
    if (platform) {
      let binary = findClaudeBinary(temporary, platform)
      if (!binary) {
        deps.log("Chunky native agent binary missing; retrying dependency installation…")
        announce(deps, { kind: "installing", version: tag, attempt: 2 })
        rmSync(join(temporary, "node_modules"), { recursive: true, force: true })
        for (const entry of readdirSync(join(temporary, "packages"), { withFileTypes: true })) {
          if (entry.isDirectory()) rmSync(join(temporary, "packages", entry.name, "node_modules"), { recursive: true, force: true })
        }
        run([bun, "install", "--ignore-scripts"], temporary, deps, "Could not reinstall Chunky runtime dependencies")
        binary = findClaudeBinary(temporary, platform)
      }
      if (!binary) throw new Error(`The native claude-agent-sdk binary for ${platform} was not installed. Check that optional dependencies are enabled in bunfig.toml or .npmrc, then retry.`)
      try { chmodSync(binary, 0o755) } catch {}
    }

    // Verify BEFORE anything is swapped in: a half-downloaded or mislabelled
    // release must never replace a working runtime.
    announce(deps, { kind: "verifying", version: tag })
    const stagedVersion = installedRuntimeVersion(temporary)
    if (stagedVersion !== tag) throw new Error(`Expected Chunky release v${tag}, but its package.json reports v${stagedVersion ?? "unknown"}.`)
    if (!hasRuntime(temporary)) throw new Error(`The downloaded Chunky runtime v${tag} is incomplete.`)
  }
}

/** Swap the staged runtime in, keeping the replaced one as `<root>.old`. */
function activateStaged(
  tag: string,
  paths: { root: string; temporary: string; previous: string; archive: string },
): void {
  const { root, temporary, previous, archive } = paths
  rmSync(previous, { recursive: true, force: true })
  if (existsSync(root)) renameSync(root, previous)
  // rename is atomic when source and destination are on this filesystem.
  try { renameSync(temporary, root) } catch (error) {
    // Put the previous runtime back rather than leaving the app with none.
    if (!existsSync(root) && existsSync(previous)) {
      try { renameSync(previous, root) } catch { /* nothing better to try */ }
    }
    throw new Error(`Could not activate the installed Chunky runtime: ${error instanceof Error ? error.message : "rename failed"}`)
  }
  const activeVersion = installedRuntimeVersion(root)
  if (activeVersion !== tag || !hasRuntime(root)) throw new Error(`Installed Chunky runtime verification failed: expected v${tag}.`)
  rmSync(archive, { force: true })
}

function runtimePaths(env: NodeJS.ProcessEnv, deps: RuntimeInstallerDependencies) {
  const root = runtimeRoot(env, deps.homeDir)
  const parent = dirname(root)
  const name = basename(root)
  return {
    root,
    parent,
    name,
    temporary: join(parent, `${name}.new`),
    previous: join(parent, `${name}.old`),
    archive: join(parent, `${name}.update.tar.gz`),
    lock: join(parent, `.${name}.install.lock`),
  }
}

/** Download and atomically install the latest released Chunky runtime. Skips
 *  the work when a usable runtime is already installed (see upgradeRuntime for
 *  replacing an OLDER one). */
export async function installRuntime(
  env: NodeJS.ProcessEnv = process.env,
  injected: Partial<RuntimeInstallerDependencies> = {},
): Promise<void> {
  const deps = { ...defaults, ...injected }
  const paths = runtimePaths(env, deps)
  mkdirSync(paths.parent, { recursive: true })
  const releaseLock = await acquireInstallLock(paths.lock, deps)
  try {
    // Another desktop instance may have completed its install while we waited.
    if (hasRuntime(paths.root)) return
    deps.log("Installing Chunky server…")
    const release = await fetchLatestRelease(deps)
    await stageRelease(release, env, paths, deps)
    activateStaged(release.tag, paths)
  } finally {
    releaseLock()
  }
}

export type RuntimeUpgrade =
  /** A runtime was installed where there was none. */
  | { status: "installed"; version: string }
  /** An older runtime was replaced. */
  | { status: "upgraded"; version: string; previousVersion?: string }
  /** Nothing to do: the installed runtime is the latest (or newer). */
  | { status: "current"; version: string }

/**
 * Replace an OLDER installed runtime with the latest release, so the desktop
 * app stops being pinned to whatever it first installed. The swap only happens
 * after the download verifies, and a newer local runtime is never downgraded.
 *
 * Callers treat failures as non-fatal: the existing runtime keeps serving.
 */
export async function upgradeRuntime(
  env: NodeJS.ProcessEnv = process.env,
  injected: Partial<RuntimeInstallerDependencies> = {},
): Promise<RuntimeUpgrade> {
  const deps = { ...defaults, ...injected }
  const paths = runtimePaths(env, deps)
  if (!hasRuntime(paths.root)) {
    await installRuntime(env, injected)
    return { status: "installed", version: installedRuntimeVersion(paths.root) ?? "unknown" }
  }
  const current = installedRuntimeVersion(paths.root)
  const release = await fetchLatestRelease(deps)
  // Never downgrade: a local build ahead of the published release stays.
  if (current && compareVersions(release.tag, current) <= 0) return { status: "current", version: current }

  mkdirSync(paths.parent, { recursive: true })
  const releaseLock = await acquireInstallLock(paths.lock, deps)
  try {
    // Another instance may have upgraded while we waited for the lock.
    const afterLock = installedRuntimeVersion(paths.root)
    if (afterLock && compareVersions(release.tag, afterLock) <= 0) return { status: "current", version: afterLock }
    deps.log(`Updating the Chunky server to v${release.tag}…`)
    await stageRelease(release, env, paths, deps)
    activateStaged(release.tag, paths)
    return { status: "upgraded", version: release.tag, previousVersion: afterLock ?? current }
  } finally {
    releaseLock()
  }
}
