import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ensureZooLedgerSkill, ZOO_LEDGER_SKILL_VERSION } from "./zooLedgerSkill"
import { ZOO_LEDGER_SKILL } from "./zooLedgerSkillContent"

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) Bun.spawnSync(["rm", "-rf", root]) })
function root() { const path = mkdtempSync(join(tmpdir(), "chunky-skill-")); roots.push(path); return path }

test("atomically installs a packaged zoo-ledger skill with ownership metadata", async () => {
  const targetRoot = root()
  const result = await ensureZooLedgerSkill({ root: targetRoot })
  expect(result).toEqual({ ok: true, path: join(targetRoot, "zoo-ledger") })
  expect(readFileSync(join(targetRoot, "zoo-ledger", "SKILL.md"), "utf8")).toBe(ZOO_LEDGER_SKILL)
  expect(JSON.parse(readFileSync(join(targetRoot, "zoo-ledger", ".chunky-owner.json"), "utf8"))).toMatchObject({ owner: "chunky-app:zoo-ledger", version: ZOO_LEDGER_SKILL_VERSION, hash: expect.stringMatching(/^[a-f0-9]{64}$/) })
  expect(readFileSync(join(targetRoot, "zoo-ledger", "SKILL.md"), "utf8")).toContain("Never ask the user to paste")
  expect(readFileSync(join(targetRoot, "zoo-ledger", "SKILL.md"), "utf8")).toContain("unsupported connectors")
})

test("is idempotent and safely updates an unmodified app-owned copy", async () => {
  const targetRoot = root(); expect((await ensureZooLedgerSkill({ root: targetRoot })).ok).toBe(true)
  expect((await ensureZooLedgerSkill({ root: targetRoot })).ok).toBe(true)
  const metaPath = join(targetRoot, "zoo-ledger", ".chunky-owner.json")
  const meta = JSON.parse(readFileSync(metaPath, "utf8")); meta.version = 0; writeFileSync(metaPath, JSON.stringify(meta))
  expect((await ensureZooLedgerSkill({ root: targetRoot })).ok).toBe(true)
  expect(JSON.parse(readFileSync(metaPath, "utf8")).version).toBe(ZOO_LEDGER_SKILL_VERSION)
})

test("refuses unowned and modified collisions without overwriting them", async () => {
  for (const owned of [false, true]) {
    const targetRoot = root(); const target = join(targetRoot, "zoo-ledger"); mkdirSync(target)
    writeFileSync(join(target, "SKILL.md"), "user content")
    if (owned) writeFileSync(join(target, ".chunky-owner.json"), JSON.stringify({ owner: "chunky-app:zoo-ledger", version: 1, hash: "wrong" }))
    const result = await ensureZooLedgerSkill({ root: targetRoot })
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining(owned ? "unmodified" : "non-app-owned") })
    expect(readFileSync(join(target, "SKILL.md"), "utf8")).toBe("user content")
  }
})

test("restores the prior app-owned copy when the atomic replacement fails", async () => {
  const targetRoot = root(); expect((await ensureZooLedgerSkill({ root: targetRoot })).ok).toBe(true)
  const metaPath = join(targetRoot, "zoo-ledger", ".chunky-owner.json"); const meta = JSON.parse(readFileSync(metaPath, "utf8")); meta.version = 0; writeFileSync(metaPath, JSON.stringify(meta))
  let moves = 0
  const result = await ensureZooLedgerSkill({ root: targetRoot, rename: async (from, to) => { moves++; if (moves === 2) throw new Error("simulated"); return (await import("node:fs/promises")).rename(from, to) } })
  expect(result).toMatchObject({ ok: false })
  expect(readFileSync(join(targetRoot, "zoo-ledger", "SKILL.md"), "utf8")).toBe(ZOO_LEDGER_SKILL)
})
