import { afterEach, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { hasRuntime, installRuntime, type RuntimeInstallerDependencies } from "./runtimeInstaller"

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
