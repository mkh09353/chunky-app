// Bun-main-only FFF directory discovery for the Add Repository UI.
// Never import this module from the webview / Vite graph.
import { existsSync, mkdirSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, isAbsolute, join, normalize, resolve } from "node:path"
import { FileFinder } from "@ff-labs/fff-bun"

export type DirHit = { name: string; path: string }

const SKIP_NAME =
  /^(node_modules|\.git|\.hg|\.svn|\.turbo|\.next|dist|build|coverage|\.cache|\.chunky-fff|Library|Applications)$/i

type FinderEntry = { base: string; finder: FileFinder }

const finders: FinderEntry[] = []
let initPromise: Promise<void> | null = null
let destroyed = false

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

/** Bounded search roots — never `/` or unrestricted home scan flags. */
export function candidateRoots(extra: string[] = []): string[] {
  const home = homedir()
  const seeds = [
    join(home, "Downloads"),
    join(home, "Projects"),
    join(home, "Developer"),
    join(home, "code"),
    join(home, "src"),
    ...extra,
  ]
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of seeds) {
    if (!raw || typeof raw !== "string") continue
    let p: string
    try {
      p = resolve(normalize(raw))
    } catch {
      continue
    }
    if (p === "/" || p === home) continue // too broad as an index root
    if (!isAbsolute(p) || !existsSync(p) || !isDir(p)) continue
    if (seen.has(p)) continue
    seen.add(p)
    out.push(p)
  }
  return out
}

function createFinder(basePath: string): FileFinder | null {
  const stateDir = join(homedir(), ".chunky", "state", "fff-app", slug(basePath))
  try {
    mkdirSync(stateDir, { recursive: true })
  } catch {
    /* ignore */
  }

  const result = FileFinder.create({
    basePath,
    frecencyDbPath: join(stateDir, "frecency.mdb"),
    historyDbPath: join(stateDir, "history.mdb"),
    aiMode: true,
    enableHomeDirScanning: false,
    enableFsRootScanning: false,
  })
  if (!result.ok) {
    console.warn(`[chunky] FFF init failed for ${basePath}: ${result.error}`)
    return null
  }
  return result.value
}

function slug(path: string): string {
  let h = 5381
  for (let i = 0; i < path.length; i++) h = ((h << 5) + h + path.charCodeAt(i)) | 0
  return "b" + (h >>> 0).toString(36)
}

export async function ensureFinders(extraRoots: string[] = []): Promise<void> {
  if (destroyed) return
  if (!initPromise) {
    initPromise = (async () => {
      const roots = candidateRoots(extraRoots)
      for (const base of roots) {
        if (destroyed) return
        if (finders.some((f) => f.base === base)) continue
        const finder = createFinder(base)
        if (!finder) continue
        finders.push({ base, finder })
        // Don't block forever on huge trees.
        await finder.waitForScan(8_000).catch(() => {})
      }
    })()
  }
  await initPromise
  // Allow late extra roots (e.g. workspace parent) after first init.
  for (const base of candidateRoots(extraRoots)) {
    if (finders.some((f) => f.base === base)) continue
    const finder = createFinder(base)
    if (!finder) continue
    finders.push({ base, finder })
    void finder.waitForScan(8_000).catch(() => {})
  }
}

function cleanName(dirName: string, relativePath: string): string {
  const raw = (dirName || relativePath || "").replace(/\/+$/, "")
  const leaf = basename(raw)
  return leaf || raw || "folder"
}

function absFrom(base: string, relativePath: string): string {
  const rel = relativePath.replace(/\/+$/, "")
  return resolve(base, rel)
}

export async function searchDirectories(
  query: string,
  limit = 12,
  extraRoots: string[] = [],
): Promise<DirHit[]> {
  const q = query.trim()
  if (!q) return []
  const clamped = Math.max(1, Math.min(Math.floor(limit) || 12, 30))

  await ensureFinders(extraRoots)
  if (destroyed || finders.length === 0) return []

  // Pull a full page from EVERY root, then merge by FFF score. Early-exit after
  // the first root's `limit` starved later roots (e.g. ~/code) whenever
  // ~/Downloads alone could fill the page.
  type Ranked = DirHit & { score: number; depth: number }
  const ranked: Ranked[] = []
  const seen = new Set<string>()
  const qLower = q.toLowerCase()

  for (const { base, finder } of finders) {
    if (finder.isDestroyed) continue
    let result: ReturnType<FileFinder["directorySearch"]>
    try {
      result = finder.directorySearch(q, { pageSize: clamped })
    } catch (err) {
      console.warn(`[chunky] directorySearch failed (${base}):`, err)
      continue
    }
    if (!result.ok) continue
    const { items, scores } = result.value
    for (let i = 0; i < items.length; i++) {
      const item = items[i]!
      const name = cleanName(item.dirName, item.relativePath)
      if (SKIP_NAME.test(name)) continue
      // Skip deep junk segments in relative path
      const parts = item.relativePath.split("/").filter(Boolean)
      if (parts.some((p) => SKIP_NAME.test(p))) continue

      const path = absFrom(base, item.relativePath)
      if (seen.has(path)) continue
      // Prefer project-ish depth (not the index root itself)
      if (path === base) continue
      seen.add(path)

      const score = scores[i]?.total ?? 0
      // Small tie-break: exact / prefix name match outranks deep path noise.
      const nameLower = name.toLowerCase()
      let boost = 0
      if (nameLower === qLower) boost += 50
      else if (nameLower.startsWith(qLower)) boost += 20
      ranked.push({
        name,
        path,
        score: score + boost,
        depth: parts.length,
      })
    }
  }

  ranked.sort((a, b) => b.score - a.score || a.depth - b.depth || a.path.localeCompare(b.path))
  return ranked.slice(0, clamped).map(({ name, path }) => ({ name, path }))
}

export function destroyFinders(): void {
  destroyed = true
  for (const { finder } of finders) {
    try {
      if (!finder.isDestroyed) finder.destroy()
    } catch {
      /* ignore */
    }
  }
  finders.length = 0
  initPromise = null
}

/** Parent of a workspace path, if it is a sensible bounded root. */
export function parentRoot(workspace: string | undefined): string | null {
  if (!workspace || typeof workspace !== "string") return null
  try {
    const p = resolve(workspace)
    if (!isAbsolute(p)) return null
    const parent = dirname(p)
    if (!parent || parent === "/" || parent === homedir()) return null
    return isDir(parent) ? parent : null
  } catch {
    return null
  }
}
