import { createHash, randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { ZOO_LEDGER_SKILL } from "./zooLedgerSkillContent"

export const ZOO_LEDGER_SKILL_VERSION = 1
const OWNER = "chunky-app:zoo-ledger"
const SKILL_FILE = "SKILL.md"
const OWNER_FILE = ".chunky-owner.json"

export type SkillInstallResult = { ok: true; path: string } | { ok: false; error: string }
type SkillInstallerDeps = { root?: string; rename?: typeof rename }

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

/** Install the app-owned skill where the unchanged Chunky server already looks.
 * The containing directory is replaced as a unit; an existing directory is
 * touched only when its ownership record and content hash both validate. */
export async function ensureZooLedgerSkill(deps: SkillInstallerDeps = {}): Promise<SkillInstallResult> {
  const root = deps.root ?? join(homedir(), ".chunky", "skills")
  const target = join(root, "zoo-ledger")
  const hash = digest(ZOO_LEDGER_SKILL)
  const metadata = JSON.stringify({ owner: OWNER, version: ZOO_LEDGER_SKILL_VERSION, hash }, null, 2) + "\n"
  const move = deps.rename ?? rename
  try {
    if (existsSync(target)) {
      let owner: { owner?: unknown; version?: unknown; hash?: unknown }
      let current: string
      try {
        owner = JSON.parse(await readFile(join(target, OWNER_FILE), "utf8"))
        current = await readFile(join(target, SKILL_FILE), "utf8")
      } catch {
        return { ok: false, error: "A non-app-owned zoo-ledger skill already exists. Rename or remove it, then retry." }
      }
      if (owner.owner !== OWNER || typeof owner.hash !== "string" || owner.hash !== digest(current)) {
        return { ok: false, error: "The existing zoo-ledger skill is not an unmodified app-owned copy. Rename or remove it, then retry." }
      }
      if (owner.version === ZOO_LEDGER_SKILL_VERSION && owner.hash === hash && current === ZOO_LEDGER_SKILL) {
        return { ok: true, path: target }
      }
    }

    await mkdir(root, { recursive: true, mode: 0o700 })
    const nonce = randomUUID()
    const staged = join(root, `.zoo-ledger-${nonce}.tmp`)
    const backup = join(root, `.zoo-ledger-${nonce}.bak`)
    await mkdir(staged, { mode: 0o700 })
    await writeFile(join(staged, SKILL_FILE), ZOO_LEDGER_SKILL, { mode: 0o600 })
    await writeFile(join(staged, OWNER_FILE), metadata, { mode: 0o600 })
    let backedUp = false
    try {
      if (existsSync(target)) {
        await move(target, backup)
        backedUp = true
      }
      await move(staged, target)
      if (backedUp) await rm(backup, { recursive: true, force: true })
    } catch (error) {
      await rm(staged, { recursive: true, force: true }).catch(() => {})
      if (backedUp && !existsSync(target)) await move(backup, target).catch(() => {})
      throw error
    }
    return { ok: true, path: target }
  } catch {
    return { ok: false, error: "Could not install the Zoo setup skill. Check ~/.chunky permissions and retry." }
  }
}

export function zooLedgerSkillPath(root = join(homedir(), ".chunky", "skills")): string {
  return join(root, "zoo-ledger")
}
