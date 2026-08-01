import { afterAll, expect, test } from "bun:test"
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createDirectory, validFolderName, validParentDir } from "./fsOps"

const root = mkdtempSync(join(tmpdir(), "chunky-fsops-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))

test("creates a folder inside an existing parent", async () => {
  const res = await createDirectory({ parentDir: root, name: "my-app" })
  expect(res.ok).toBe(true)
  expect(res.path).toBe(join(root, "my-app"))
  expect(statSync(join(root, "my-app")).isDirectory()).toBe(true)
})

test("trims the name and tolerates a trailing slash on the parent", async () => {
  const res = await createDirectory({ parentDir: `${root}/`, name: "  spaced name  " })
  expect(res.ok).toBe(true)
  expect(res.path).toBe(join(root, "spaced name"))
})

test("refuses to reuse an existing directory, but reports its path", async () => {
  await createDirectory({ parentDir: root, name: "twice" })
  const again = await createDirectory({ parentDir: root, name: "twice" })
  expect(again.ok).toBe(false)
  expect(again.existed).toBe(true)
  expect(again.path).toBe(join(root, "twice"))
  expect(again.error).toContain("already exists")
})

test("refuses when a file already occupies the name", async () => {
  writeFileSync(join(root, "afile"), "x")
  const res = await createDirectory({ parentDir: root, name: "afile" })
  expect(res.ok).toBe(false)
  expect(res.existed).toBe(true)
  expect(res.path).toBe(join(root, "afile"))
  expect(res.error).toContain("already here")
})

test("reports a DANGLING SYMLINK as occupied (atomic mkdir, not an exists() probe)", async () => {
  // existsSync() follows the link and answers false, so a pre-check would have
  // called this name free and then failed with a raw errno. A plain mkdir sees
  // the truth: EEXIST.
  const link = join(root, "dangling")
  symlinkSync(join(root, "definitely-not-here"), link)
  expect(existsSync(link)).toBe(false)
  expect(lstatSync(link).isSymbolicLink()).toBe(true)

  const res = await createDirectory({ parentDir: root, name: "dangling" })
  expect(res.ok).toBe(false)
  expect(res.existed).toBe(true)
  expect(res.path).toBe(link)
  expect(res.error).toContain("already here")
  // Nothing was created through the link.
  expect(existsSync(join(root, "definitely-not-here"))).toBe(false)
})

test("never adopts or overwrites an existing directory's contents", async () => {
  const res1 = await createDirectory({ parentDir: root, name: "keepme" })
  expect(res1.ok).toBe(true)
  writeFileSync(join(root, "keepme", "file.txt"), "precious")

  const res2 = await createDirectory({ parentDir: root, name: "keepme" })
  expect(res2.ok).toBe(false)
  expect(res2.existed).toBe(true)
  // The mkdir must not have touched what was already there.
  expect(existsSync(join(root, "keepme", "file.txt"))).toBe(true)
})

test("rejects names that could escape the parent", async () => {
  for (const name of ["../evil", "a/b", "..", ".", "back\\slash"]) {
    const res = await createDirectory({ parentDir: root, name })
    expect(res.ok).toBe(false)
    expect(res.path).toBe(null)
  }
  expect(existsSync(join(root, "evil"))).toBe(false)
})

test("never creates intermediate parents (mkdir is non-recursive)", async () => {
  const missingParent = join(root, "no-such-parent")
  const res = await createDirectory({ parentDir: missingParent, name: "child" })
  expect(res.ok).toBe(false)
  // Neither the parent nor the child may be conjured into existence.
  expect(existsSync(missingParent)).toBe(false)
  expect(existsSync(join(missingParent, "child"))).toBe(false)
})

test("rejects a missing, relative, or non-directory parent", async () => {
  const missing = await createDirectory({ parentDir: join(root, "nope"), name: "x" })
  expect(missing.ok).toBe(false)
  expect(missing.error).toContain("existing folder")

  expect((await createDirectory({ parentDir: "relative/path", name: "x" })).ok).toBe(false)
  expect((await createDirectory({ parentDir: join(root, "afile"), name: "x" })).ok).toBe(false)
  expect((await createDirectory({ parentDir: 42, name: "x" })).ok).toBe(false)
  expect((await createDirectory({})).ok).toBe(false)
})

test("requires a name", async () => {
  const res = await createDirectory({ parentDir: root, name: "   " })
  expect(res.ok).toBe(false)
  expect(res.error).toContain("folder name")
})

test("surfaces permission denied instead of throwing", async () => {
  const locked = join(root, "locked")
  const first = await createDirectory({ parentDir: root, name: "locked" })
  expect(first.ok).toBe(true)
  chmodSync(locked, 0o500)
  try {
    const res = await createDirectory({ parentDir: locked, name: "child" })
    // Running as root would defeat the chmod; only assert when it took.
    if (!res.ok) expect(res.error).toContain("Permission denied")
  } finally {
    chmodSync(locked, 0o700)
  }
})

test("validators are exported for reuse", () => {
  expect(validParentDir(root)).toBe(root)
  expect(validParentDir("/definitely/not/here")).toBe(null)
  expect(validFolderName("ok-name")).toEqual({ name: "ok-name" })
  expect("error" in validFolderName("a/b")).toBe(true)
  expect("error" in validFolderName("x".repeat(300))).toBe(true)
})
