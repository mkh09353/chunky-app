import { expect, test } from "bun:test"
import { createDirectory, folderNameError, nativeFsAvailable } from "./fsOps"

test("folderNameError accepts ordinary folder names", () => {
  expect(folderNameError("my-app")).toBe(null)
  expect(folderNameError("  My App 2  ")).toBe(null)
  expect(folderNameError(".dotfiles")).toBe(null)
})

test("folderNameError rejects empty, traversal, and separator names", () => {
  expect(folderNameError("")).toContain("folder name")
  expect(folderNameError("   ")).toContain("folder name")
  expect(folderNameError(".")).toContain("real folder name")
  expect(folderNameError("..")).toContain("real folder name")
  expect(folderNameError("a/b")).toContain("slashes")
  expect(folderNameError("a\\b")).toContain("slashes")
  expect(folderNameError("x".repeat(256))).toContain("too long")
})

test("folderNameError measures BYTES, matching Bun's limit", () => {
  // 255 UTF-16 units but 510 UTF-8 bytes: a character count would wave this
  // through and Bun would then reject it (ENAMETOOLONG / its own guard).
  const multibyte = "é".repeat(255)
  expect(multibyte.length).toBe(255)
  expect(new TextEncoder().encode(multibyte).length).toBe(510)
  expect(folderNameError(multibyte)).toContain("too long")

  // Emoji are 4 bytes each: 63 fit, 64 do not.
  expect(folderNameError("🚀".repeat(63))).toBe(null)
  expect(folderNameError("🚀".repeat(64))).toContain("too long")

  // Exactly at the byte limit is still fine.
  expect(folderNameError("x".repeat(255))).toBe(null)
})

test("createDirectory validates before reaching for RPC", async () => {
  expect(await createDirectory({ parentDir: "relative", name: "x" })).toEqual({
    ok: false,
    path: null,
    error: "Choose an absolute parent folder.",
  })
  const bad = await createDirectory({ parentDir: "/tmp", name: "a/b" })
  expect(bad.ok).toBe(false)
  expect(bad.error).toContain("slashes")
})

test("createDirectory fails gracefully with no native bridge", async () => {
  // No __electrobunRpcSocketPort in the test env → the web build path.
  expect(nativeFsAvailable()).toBe(false)
  const res = await createDirectory({ parentDir: "/tmp", name: "chunky-test-folder" })
  expect(res.ok).toBe(false)
  expect(res.error).toContain("desktop app")
})
