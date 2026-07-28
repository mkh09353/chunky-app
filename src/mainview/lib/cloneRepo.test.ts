// Pure helpers behind "add repo from a git URL". These decide what directory
// gets registered, so they carry the risk in the feature.
//   bun test src/mainview/lib/cloneRepo.test.ts
import { describe, expect, it } from "bun:test"
import {
  cloneObjective,
  defaultCloneParent,
  extractClonePath,
  joinPath,
  parentDirOf,
  parseGitUrl,
  summarizeEvent,
} from "./cloneRepo"

describe("parseGitUrl", () => {
  it("accepts the shapes people paste", () => {
    expect(parseGitUrl("https://github.com/owner/repo")).toMatchObject({ leaf: "repo", slug: "owner/repo" })
    expect(parseGitUrl("https://github.com/owner/repo.git")).toMatchObject({ leaf: "repo" })
    expect(parseGitUrl("https://github.com/owner/repo/")).toMatchObject({ leaf: "repo" })
    expect(parseGitUrl("  https://github.com/owner/repo  ")?.url).toBe("https://github.com/owner/repo")
    expect(parseGitUrl("git@github.com:owner/repo.git")).toMatchObject({ leaf: "repo", slug: "owner/repo" })
    expect(parseGitUrl("ssh://git@gitlab.com/group/sub/repo.git")).toMatchObject({ leaf: "repo" })
    expect(parseGitUrl("github.com/owner/repo")).toMatchObject({ leaf: "repo" })
  })

  it("trims branch/file URLs back to the repo", () => {
    expect(parseGitUrl("https://github.com/owner/repo/tree/main")).toMatchObject({ leaf: "repo" })
    expect(parseGitUrl("https://github.com/owner/repo/blob/main/src/index.ts")).toMatchObject({
      leaf: "repo",
      slug: "owner/repo",
    })
  })

  it("rejects junk and anything shell-unsafe", () => {
    for (const bad of [
      "",
      "   ",
      "not a url",
      "https://github.com/",
      "https://github.com/owner/repo; rm -rf /",
      "https://github.com/owner/`whoami`",
      "https://localhost/repo",
      "https://github.com/owner/..",
    ]) {
      expect(parseGitUrl(bad)).toBeNull()
    }
  })
})

describe("paths", () => {
  it("joins without doubling separators", () => {
    expect(joinPath("/Users/me/code", "repo")).toBe("/Users/me/code/repo")
    expect(joinPath("/Users/me/code/", "/repo")).toBe("/Users/me/code/repo")
  })

  it("finds a parent directory only for absolute paths", () => {
    expect(parentDirOf("/Users/me/code/repo")).toBe("/Users/me/code")
    expect(parentDirOf("/Users/me/code/repo/")).toBe("/Users/me/code")
    expect(parentDirOf("relative/path")).toBeNull()
    expect(parentDirOf("/top")).toBeNull()
    expect(parentDirOf(null)).toBeNull()
  })

  it("defaults the destination to a root, else the active repo's parent", () => {
    expect(defaultCloneParent(["/Users/me/code", "/Users/me/src"])).toBe("/Users/me/code")
    expect(defaultCloneParent(["/Users/me/code/"])).toBe("/Users/me/code")
    expect(defaultCloneParent([], "/Users/me/work/chunky-app")).toBe("/Users/me/work")
    expect(defaultCloneParent([], null)).toBe("")
  })
})

describe("extractClonePath", () => {
  const input = { parentDir: "/Users/me/code", leaf: "repo" }

  it("prefers the expected path wherever it is printed", () => {
    expect(extractClonePath("Done.\n/Users/me/code/repo\n", input)).toBe("/Users/me/code/repo")
    expect(extractClonePath("Cloned into `/Users/me/code/repo`.", input)).toBe("/Users/me/code/repo")
    expect(extractClonePath("- /Users/me/code/repo", input)).toBe("/Users/me/code/repo")
  })

  it("takes the last path under the destination when the name differs", () => {
    const text = "Cloning…\n/Users/me/code\nfinal: /Users/me/code/repo-2\n"
    expect(extractClonePath(text, input)).toBe("/Users/me/code/repo-2")
  })

  it("falls back to a path that ends in the repo name elsewhere", () => {
    expect(extractClonePath("cloned to /tmp/scratch/repo", input)).toBe("/tmp/scratch/repo")
  })

  it("ignores trailing punctuation and slashes", () => {
    expect(extractClonePath("Cloned to /Users/me/code/repo/.", input)).toBe("/Users/me/code/repo")
    expect(extractClonePath('"/Users/me/code/repo",', input)).toBe("/Users/me/code/repo")
  })

  it("returns null when there's nothing usable", () => {
    expect(extractClonePath("", input)).toBeNull()
    expect(extractClonePath("I could not clone that repository.", input)).toBeNull()
  })
})

describe("cloneObjective", () => {
  it("pins the URL, the destination, and the print-the-path contract", () => {
    const objective = cloneObjective({
      url: "https://github.com/owner/repo",
      parentDir: "/Users/me/code",
      leaf: "repo",
    })
    expect(objective).toContain("https://github.com/owner/repo")
    expect(objective).toContain("/Users/me/code")
    expect(objective).toContain("/Users/me/code/repo")
    expect(objective).toContain("gh repo clone")
    expect(objective).toContain("git clone")
    expect(objective).toContain("Do not cd anywhere else")
    expect(objective).toContain("goal_complete")
    // The path we parse back out must survive its own instructions.
    expect(extractClonePath(objective, { parentDir: "/Users/me/code", leaf: "repo" })).toBe(
      "/Users/me/code/repo",
    )
  })
})

describe("summarizeEvent", () => {
  it("summarizes tool activity, failures, and goal notices", () => {
    expect(
      summarizeEvent({ type: "tool.start", id: "1", name: "bash", input: { command: "git clone x\nmore" } }),
    ).toBe("⚒ bash: git clone x")
    expect(summarizeEvent({ type: "tool.end", id: "1", ok: true, output: "fine" })).toBeNull()
    expect(summarizeEvent({ type: "tool.end", id: "1", ok: false, output: "fatal: nope" })).toBe(
      "⚠ fatal: nope",
    )
    expect(
      summarizeEvent({ type: "goal.update", sessionId: "s", goal: null, message: "◎ Goal set — clone" }),
    ).toBe("◎ Goal set — clone")
    expect(summarizeEvent({ type: "error", message: "boom" })).toBe("⚠ boom")
    expect(summarizeEvent({ type: "message.delta", text: "hi" })).toBeNull()
  })
})
