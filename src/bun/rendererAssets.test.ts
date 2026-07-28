/**
 * Guards the renderer asset pipeline.
 *
 * v0.1.3 shipped with a broken in-app logo: Vite copies everything in
 * src/mainview/public/ to the *root* of dist/, but electrobun.config.ts only
 * staged `dist/index.html` and `dist/assets`, so `dist/chunky-mark.svg` never
 * entered the app bundle and `views://mainview/chunky-mark.svg` 404'd.
 *
 * These tests fail if the packaged renderer references an asset that the copy
 * map would not place inside the bundle.
 */

import { describe, expect, test } from "bun:test"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import config from "../../electrobun.config.ts"

const ROOT = join(import.meta.dir, "..", "..")
const PUBLIC_DIR = join(ROOT, "src", "mainview", "public")
const DIST = join(ROOT, "dist")
const VIEW_ROOT = "views/mainview"

/** Vite rewrites this dev-only entry into a hashed /assets/* bundle. */
const DEV_ONLY_REFS = new Set(["/main.tsx"])

function walk(dir: string, filter: (p: string) => boolean): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name)
    return e.isDirectory() ? walk(p, filter) : filter(p) ? [p] : []
  })
}

/** Root-absolute asset URLs referenced by renderer source. */
function referencedAssets(): { ref: string; from: string }[] {
  const sources = [
    join(ROOT, "src", "mainview", "index.html"),
    ...walk(join(ROOT, "src", "mainview"), (p) => p.endsWith(".tsx")),
  ].filter(existsSync)

  const out: { ref: string; from: string }[] = []
  for (const file of sources) {
    const text = readFileSync(file, "utf8")
    for (const m of text.matchAll(/(?:src|href)=["'](\/[^"'>]+)["']/g)) {
      const ref = m[1]!
      if (DEV_ONLY_REFS.has(ref) || ref.startsWith("//")) continue
      out.push({ ref, from: relative(ROOT, file) })
    }
  }
  return out
}

/**
 * Where a dist-relative file lands inside Resources/app, per the copy map.
 * Mirrors Electrobun's `cpSync(join(root, src), join(appCode, dest))`.
 */
function packagedPath(distRelative: string): string | null {
  const copy = (config.build?.copy ?? {}) as Record<string, string>
  const source = `dist/${distRelative}`
  for (const [src, dest] of Object.entries(copy)) {
    if (src === source) return dest
    if (source.startsWith(`${src}/`)) return `${dest}/${source.slice(src.length + 1)}`
  }
  return null
}

describe("renderer assets are packaged", () => {
  test("every root-absolute asset reference exists in public/", () => {
    const refs = referencedAssets()
    expect(refs.length).toBeGreaterThan(0)
    for (const { ref, from } of refs) {
      if (ref.startsWith("/assets/")) continue // emitted by the bundler
      const file = join(PUBLIC_DIR, ref.slice(1))
      expect(existsSync(file), `${from} references ${ref}, missing in src/mainview/public/`).toBe(
        true,
      )
    }
  })

  test("every referenced public asset is staged into the app bundle", () => {
    for (const { ref, from } of referencedAssets()) {
      if (ref.startsWith("/assets/")) continue
      const dest = packagedPath(ref.slice(1))
      expect(
        dest,
        `${from} references ${ref}, but electrobun.config.ts copy map does not stage dist${ref} ` +
          `into the bundle — it would 404 under views://mainview${ref}`,
      ).not.toBeNull()
      expect(dest, `${ref} must be staged under ${VIEW_ROOT}/`).toBe(`${VIEW_ROOT}${ref}`)
    }
  })

  test("the whole build output is staged, so future public/ assets cannot be missed", () => {
    for (const name of readdirSync(PUBLIC_DIR)) {
      const dest = packagedPath(name)
      expect(
        dest,
        `src/mainview/public/${name} would not be packaged; it lands at dist/${name}, ` +
          `which no copy rule covers`,
      ).toBe(`${VIEW_ROOT}/${name}`)
    }
  })

  // Only meaningful after `bun run build:web`; skipped on a cold tree.
  test.skipIf(!existsSync(join(DIST, "index.html")))(
    "actual dist output is fully covered by the copy map",
    () => {
      const files = walk(DIST, () => true).filter((p) => statSync(p).isFile())
      expect(files.length).toBeGreaterThan(0)
      for (const file of files) {
        const rel = relative(DIST, file)
        expect(
          packagedPath(rel),
          `dist/${rel} is produced by the build but no copy rule stages it into the bundle`,
        ).not.toBeNull()
      }
    },
  )

  // The in-app mark must stay byte-identical to the approved artwork.
  test("chunky-mark.svg is the approved artwork verbatim", () => {
    const mark = readFileSync(join(PUBLIC_DIR, "chunky-mark.svg"))
    const approved = readFileSync(
      join(ROOT, "assets", "brand", "chunky-minimal-purple-exact.svg"),
    )
    expect(Buffer.compare(mark, approved)).toBe(0)
  })
})
