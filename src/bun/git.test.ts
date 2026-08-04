import { afterAll, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { gitIdentity } from "./git"

const root = mkdtempSync(join(tmpdir(), "chunky-git-identity-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))

/** A throwaway repo with a repo-LOCAL user.name, so the assertions never depend
 *  on (or touch) whatever the machine running the tests has configured. */
async function repoWithName(dir: string, name: string | null): Promise<string> {
  const cwd = mkdtempSync(join(root, `${dir}-`))
  await Bun.spawn(["git", "init", "-q", cwd], { stdout: "ignore", stderr: "ignore" }).exited
  if (name !== null) {
    await Bun.spawn(["git", "-C", cwd, "config", "user.name", name], {
      stdout: "ignore",
      stderr: "ignore",
    }).exited
  }
  return cwd
}

test("reads the repository's git user.name", async () => {
  const cwd = await repoWithName("plain", "Ada Lovelace")
  expect(await gitIdentity({ cwd })).toEqual({ name: "Ada Lovelace" })
})

test("surrounding whitespace is stripped", async () => {
  const cwd = await repoWithName("spaced", "  Ada Lovelace  ")
  expect((await gitIdentity({ cwd })).name).toBe("Ada Lovelace")
})

test("control characters in the value are folded to spaces", async () => {
  const cwd = await repoWithName("control", "Ada\tLovelace")
  expect((await gitIdentity({ cwd })).name).toBe("Ada Lovelace")
})

test("an absurdly long value is refused, leaving the caller's fallback", async () => {
  const cwd = await repoWithName("long", "N".repeat(200))
  expect(await gitIdentity({ cwd })).toEqual({ name: "" })
})

test("a bad cwd never throws and never returns anything but a string name", async () => {
  // These fall back to reading the GLOBAL config, which may or may not be set on
  // the machine running the tests — the contract under test is the shape, and
  // that nothing throws.
  for (const cwd of [undefined, "", "relative/path", "/no/such/dir/anywhere", "/tmp/\0nul", 42]) {
    const identity = await gitIdentity({ cwd })
    expect(typeof identity.name).toBe("string")
    expect(Object.keys(identity)).toEqual(["name"])
  }
})

test("only the name is ever returned — no email, no other config", async () => {
  const cwd = await repoWithName("email", "Ada Lovelace")
  await Bun.spawn(["git", "-C", cwd, "config", "user.email", "ada@example.com"], {
    stdout: "ignore",
    stderr: "ignore",
  }).exited
  const identity = await gitIdentity({ cwd })
  expect(identity).toEqual({ name: "Ada Lovelace" })
  expect(JSON.stringify(identity)).not.toContain("@")
})
