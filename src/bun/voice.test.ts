import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { mergeGrokOAuth } from "./voice"

const paths: string[] = []
afterEach(() => { for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true }) })

test("mergeGrokOAuth atomically updates Grok without dropping other auth providers", () => {
  const state = mkdtempSync(join(tmpdir(), "chunky-voice-")); paths.push(state)
  const auth = join(state, "auth.json")
  writeFileSync(auth, JSON.stringify({ codex: { type: "oauth", access: "codex-token" }, custom: { type: "api", key: "keep" }, grok: { type: "oauth", access: "old", refresh: "old-refresh", expires: 1 } }))
  mergeGrokOAuth({ type: "oauth", access: "fresh", refresh: "rotated", expires: 2 }, { CHUNKY_HOME: state })
  expect(JSON.parse(readFileSync(auth, "utf8"))).toEqual({
    codex: { type: "oauth", access: "codex-token" },
    custom: { type: "api", key: "keep" },
    grok: { type: "oauth", access: "fresh", refresh: "rotated", expires: 2 },
  })
})
