import { afterEach, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  compareVersions,
  hasRuntime,
  installedRuntimeVersion,
  installRuntime,
  upgradeRuntime,
  type RuntimeInstallerDependencies,
} from "./runtimeInstaller"

const cleanup: string[] = []
afterEach(() => {
  for (const path of cleanup.splice(0)) Bun.spawnSync(["rm", "-rf", path])
})

function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), "chunky-runtime-installer-"))
  cleanup.push(home)
  return home
}

function response(body: unknown, status = 200): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), { status })
}

function installerDeps(home: string, calls: string[], failInstall = false): Partial<RuntimeInstallerDependencies> {
  return {
    homeDir: home,
    platform: "darwin",
    arch: "arm64",
    log: (message) => calls.push(message),
    fetch: (async (input: RequestInfo | URL) => {
      const url = input.toString()
      if (url.includes("releases/latest")) return response({
        tag_name: "v1.2.3",
        assets: [{ name: "chunky.tar.gz", browser_download_url: "https://downloads.example/chunky.tar.gz" }],
      })
      if (url.includes("downloads.example")) return response("archive")
      throw new Error(`unexpected URL ${url}`)
    }) as typeof fetch,
    exec: (command, options) => {
      calls.push(command.join(" "))
      if (command[0] === "tar") {
        mkdirSync(join(options.cwd, "app.new", "packages", "server", "src"), { recursive: true })
        writeFileSync(join(options.cwd, "app.new", "packages", "server", "src", "index.ts"), "")
        writeFileSync(join(options.cwd, "app.new", "package.json"), JSON.stringify({ version: "1.2.3" }))
      }
      if (command.includes("install")) {
        if (failInstall) return { exitCode: 1, stderr: "dependency failure" }
        const binary = join(options.cwd, "node_modules", "@anthropic-ai", "claude-agent-sdk-darwin-arm64", "bin")
        mkdirSync(binary, { recursive: true })
        writeFileSync(join(binary, "claude"), "binary")
      }
      return { exitCode: 0 }
    },
  }
}

test("downloads, installs, verifies, and atomically activates the latest runtime", async () => {
  const home = tempHome()
  const calls: string[] = []
  await installRuntime({}, installerDeps(home, calls))
  const root = join(home, ".chunky", "app")
  expect(hasRuntime(root)).toBe(true)
  expect(existsSync(join(root, "node_modules", "@anthropic-ai", "claude-agent-sdk-darwin-arm64", "bin", "claude"))).toBe(true)
  expect(calls.some((call) => call.includes("install --ignore-scripts"))).toBe(true)
  expect(calls).toContain("Installing Chunky server…")
})

test("skips installation when a valid runtime already exists", async () => {
  const home = tempHome()
  const root = join(home, ".chunky", "app")
  mkdirSync(join(root, "packages", "server", "src"), { recursive: true })
  writeFileSync(join(root, "packages", "server", "src", "index.ts"), "")
  writeFileSync(join(root, "package.json"), JSON.stringify({ version: "1" }))
  const calls: string[] = []
  await installRuntime({}, installerDeps(home, calls))
  expect(calls).toEqual([])
})

test("propagates actionable dependency installation failures", async () => {
  const home = tempHome()
  await expect(installRuntime({}, installerDeps(home, [], true))).rejects.toThrow("Could not install Chunky runtime dependencies: dependency failure")
})

/** A usable runtime already sitting at ~/.chunky/app. */
function seedRuntime(home: string, version: string): string {
  const root = join(home, ".chunky", "app")
  mkdirSync(join(root, "packages", "server", "src"), { recursive: true })
  writeFileSync(join(root, "packages", "server", "src", "index.ts"), "")
  writeFileSync(join(root, "package.json"), JSON.stringify({ version }))
  return root
}

/** installerDeps, but the archive unpacks a runtime whose version does not
 *  match the release tag (a corrupt/mislabelled download). */
function mismatchedDeps(home: string, calls: string[]): Partial<RuntimeInstallerDependencies> {
  const base = installerDeps(home, calls)
  return {
    ...base,
    exec: (command, options) => {
      const result = base.exec!(command, options)
      if (command[0] === "tar") {
        writeFileSync(join(options.cwd, "app.new", "package.json"), JSON.stringify({ version: "0.0.9" }))
      }
      return result
    },
  }
}

test("compareVersions orders releases, equal versions, and prereleases", () => {
  expect(compareVersions("1.2.3", "1.2.4")).toBe(-1)
  expect(compareVersions("1.3.0", "1.2.9")).toBe(1)
  expect(compareVersions("1.2.3", "1.2.3")).toBe(0)
  expect(compareVersions("v1.2.3", "1.2.3")).toBe(0)
  expect(compareVersions("1.10.0", "1.9.0")).toBe(1)
  // A prerelease is older than the release it precedes.
  expect(compareVersions("1.2.3-beta.1", "1.2.3")).toBe(-1)
  expect(compareVersions("1.2.3", "1.2.3-beta.1")).toBe(1)
})

test("upgrades an installed runtime that is older than the release", async () => {
  const home = tempHome()
  const calls: string[] = []
  const root = seedRuntime(home, "1.0.0")

  const result = await upgradeRuntime({}, installerDeps(home, calls))

  expect(result).toEqual({ status: "upgraded", version: "1.2.3", previousVersion: "1.0.0" })
  expect(installedRuntimeVersion(root)).toBe("1.2.3")
  expect(hasRuntime(root)).toBe(true)
  // The replaced runtime is kept for recovery.
  expect(installedRuntimeVersion(join(home, ".chunky", "app.old"))).toBe("1.0.0")
})

test("leaves an up-to-date runtime untouched and downloads nothing", async () => {
  const home = tempHome()
  const calls: string[] = []
  seedRuntime(home, "1.2.3")

  const result = await upgradeRuntime({}, installerDeps(home, calls))

  expect(result).toEqual({ status: "current", version: "1.2.3" })
  expect(calls.some((call) => call.startsWith("tar"))).toBe(false)
  expect(existsSync(join(home, ".chunky", "app.old"))).toBe(false)
})

test("never downgrades a runtime newer than the published release", async () => {
  const home = tempHome()
  const calls: string[] = []
  const root = seedRuntime(home, "2.0.0")

  const result = await upgradeRuntime({}, installerDeps(home, calls))

  expect(result).toEqual({ status: "current", version: "2.0.0" })
  expect(installedRuntimeVersion(root)).toBe("2.0.0")
  expect(calls.some((call) => call.startsWith("tar"))).toBe(false)
})

test("installs from scratch when no runtime is present", async () => {
  const home = tempHome()
  const calls: string[] = []

  const result = await upgradeRuntime({}, installerDeps(home, calls))

  expect(result).toEqual({ status: "installed", version: "1.2.3" })
  expect(hasRuntime(join(home, ".chunky", "app"))).toBe(true)
})

test("a download that fails verification leaves the working runtime in place", async () => {
  const home = tempHome()
  const calls: string[] = []
  const root = seedRuntime(home, "1.0.0")

  await expect(upgradeRuntime({}, mismatchedDeps(home, calls))).rejects.toThrow("Expected Chunky release v1.2.3")

  // Still serving the old runtime, and nothing was swapped out from under it.
  expect(installedRuntimeVersion(root)).toBe("1.0.0")
  expect(hasRuntime(root)).toBe(true)
  expect(existsSync(join(home, ".chunky", "app.old"))).toBe(false)
})

test("a failed dependency install leaves the working runtime in place", async () => {
  const home = tempHome()
  const calls: string[] = []
  const root = seedRuntime(home, "1.0.0")

  await expect(upgradeRuntime({}, installerDeps(home, calls, true))).rejects.toThrow("dependency failure")

  expect(installedRuntimeVersion(root)).toBe("1.0.0")
  expect(hasRuntime(root)).toBe(true)
})
