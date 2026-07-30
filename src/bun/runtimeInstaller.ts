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
}

export function runtimeRoot(env: NodeJS.ProcessEnv, home = homedir()): string {
  return env.CHUNKY_RUNTIME_DIR || join(home, ".chunky", "app")
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

/** Download and atomically install the latest released Chunky runtime. */
export async function installRuntime(
  env: NodeJS.ProcessEnv = process.env,
  injected: Partial<RuntimeInstallerDependencies> = {},
): Promise<void> {
  const deps = { ...defaults, ...injected }
  const root = runtimeRoot(env, deps.homeDir)
  const parent = dirname(root)
  const name = basename(root)
  const temporary = join(parent, `${name}.new`)
  const previous = join(parent, `${name}.old`)
  const archive = join(parent, `${name}.update.tar.gz`)
  mkdirSync(parent, { recursive: true })
  const release = await acquireInstallLock(join(parent, `.${name}.install.lock`), deps)
  try {
    // Another desktop instance may have completed its install while we waited.
    if (hasRuntime(root)) return
    deps.log("Installing Chunky server…")

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

    let archiveResponse: Response
    try { archiveResponse = await deps.fetch(asset.browser_download_url as string) } catch (error) {
      throw new Error(`Could not download the Chunky runtime archive. Check your network connection and retry. (${error instanceof Error ? error.message : "request failed"})`)
    }
    if (!archiveResponse.ok) throw new Error(`Could not download the Chunky runtime archive (HTTP ${archiveResponse.status}). Please retry.`)
    writeFileSync(archive, new Uint8Array(await archiveResponse.arrayBuffer()))

    rmSync(temporary, { recursive: true, force: true })
    mkdirSync(temporary, { recursive: true })
    run(["tar", "-xzf", archive, "--strip-components=1", "-C", temporary], parent, deps, "Could not extract the Chunky runtime archive")
    const bun = resolveBun(env, deps.homeDir)
    run([bun, "install", "--ignore-scripts"], temporary, deps, "Could not install Chunky runtime dependencies")

    const platform = platformId(deps.platform, deps.arch)
    if (platform) {
      let binary = findClaudeBinary(temporary, platform)
      if (!binary) {
        deps.log("Chunky native agent binary missing; retrying dependency installation…")
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

    const installedVersion = (JSON.parse(readFileSync(join(temporary, "package.json"), "utf8")) as { version?: unknown }).version
    if (installedVersion !== tag) throw new Error(`Expected Chunky release v${tag}, but its package.json reports v${typeof installedVersion === "string" ? installedVersion : "unknown"}.`)
    rmSync(previous, { recursive: true, force: true })
    if (existsSync(root)) renameSync(root, previous)
    // rename is atomic when source and destination are on this filesystem.
    try { renameSync(temporary, root) } catch (error) {
      throw new Error(`Could not activate the installed Chunky runtime: ${error instanceof Error ? error.message : "rename failed"}`)
    }
    const activeVersion = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version?: unknown }).version
    if (activeVersion !== tag || !hasRuntime(root)) throw new Error(`Installed Chunky runtime verification failed: expected v${tag}.`)
    rmSync(archive, { force: true })
  } finally {
    release()
  }
}
