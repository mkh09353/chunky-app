import { describe, expect, test } from "bun:test"
import { buildRepoFilesQuery, filterAndSortRepoFiles, normalizeRepoPath } from "./repoFiles"

const file = (path: string, kind: "file" | "directory") => ({ path, name: path.split("/").pop()!, kind })

describe("repo file helpers", () => {
  test("normalizes relative paths", () => expect(normalizeRepoPath("./src/main.ts/")).toBe("src/main.ts"))
  test("combines directory scope and fuzzy term", () => expect(buildRepoFilesQuery("src/components", "button")).toBe("src/components button"))
  test("filters scope, removes directory itself and deduplicates", () => {
    const result = filterAndSortRepoFiles([file("src", "directory"), file("src/a", "file"), file("./src/a", "file"), file("src/lib", "directory"), file("other", "file")], "src")
    expect(result.map((item) => item.path)).toEqual(["src/lib", "src/a"])
  })
  test("sorts directories first and natural paths", () => {
    const result = filterAndSortRepoFiles([file("file10", "file"), file("file2", "file"), file("z", "directory"), file("a", "directory")], "")
    expect(result.map((item) => item.path)).toEqual(["a", "z", "file2", "file10"])
  })
})
