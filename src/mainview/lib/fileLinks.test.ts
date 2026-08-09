// File-path detection for transcript code spans. The interesting half of this
// suite is the rejects: a false positive turns ordinary prose into a broken
// "open in editor" chip. Run with:
//   bun test src/mainview/lib/fileLinks.test.ts
import { describe, expect, it } from "bun:test"
import { formatFileRef, isFileRef, parseFileRef } from "./fileLinks"

describe("parseFileRef — accepted shapes", () => {
  it("takes a relative path with a slash and an extension", () => {
    expect(parseFileRef("src/mainview/lib/markdown.tsx")).toEqual({
      path: "src/mainview/lib/markdown.tsx",
    })
    expect(parseFileRef("a-b/c.ts")).toEqual({ path: "a-b/c.ts" })
    expect(parseFileRef("src/bun/index.ts")).toEqual({ path: "src/bun/index.ts" })
    expect(parseFileRef("docs/adr/0001-why.md")).toEqual({ path: "docs/adr/0001-why.md" })
  })

  it("takes a bare filename with a source-ish extension", () => {
    for (const name of ["package.json", "markdown.tsx", "README.md", "tsconfig.json", "main.rs"]) {
      expect(parseFileRef(name)).toEqual({ path: name })
    }
  })

  it("takes ~, ./ and ../ prefixes", () => {
    expect(parseFileRef("~/notes/todo.md")).toEqual({ path: "~/notes/todo.md" })
    expect(parseFileRef("./vite.config.ts")).toEqual({ path: "./vite.config.ts" })
    expect(parseFileRef("../sibling/pkg.json")).toEqual({ path: "../sibling/pkg.json" })
    // Explicitly relative is signal enough to allow an extension-less target.
    expect(parseFileRef("./scripts")).toEqual({ path: "./scripts" })
  })

  it("takes absolute paths under real filesystem roots", () => {
    for (const path of [
      "/Users/me/proj/src/a.ts",
      "/home/dev/app/main.go",
      "/tmp/out.log",
      "/etc/hosts",
      "/opt/homebrew/bin/rg",
      "/var/log/system.log",
      "/Volumes/Data/notes.md",
      "/private/tmp/x.json",
      "/workspace/repo/a.ts",
      "/workspaces/repo/b.ts",
      "/srv/www/index.html",
      "/mnt/c/dev/x.py",
    ]) {
      expect(parseFileRef(path)).toEqual({ path })
    }
  })

  it("trims surrounding whitespace", () => {
    expect(parseFileRef("  src/a.ts  ")).toEqual({ path: "src/a.ts" })
  })
})

describe("parseFileRef — line and column suffixes", () => {
  it("parses :line and :line:col", () => {
    expect(parseFileRef("src/foo.ts:42")).toEqual({ path: "src/foo.ts", line: 42 })
    expect(parseFileRef("src/foo.ts:42:7")).toEqual({ path: "src/foo.ts", line: 42, column: 7 })
    expect(parseFileRef("/Users/me/a.ts:1:1")).toEqual({
      path: "/Users/me/a.ts",
      line: 1,
      column: 1,
    })
    expect(parseFileRef("package.json:3")).toEqual({ path: "package.json", line: 3 })
  })

  it("ignores a zero or malformed position", () => {
    expect(parseFileRef("src/foo.ts:0")).toBeNull()
    expect(parseFileRef("src/foo.ts:")).toBeNull()
    expect(parseFileRef("src/foo.ts:abc")).toBeNull()
    // A column of 0 is dropped, the line survives.
    expect(parseFileRef("src/foo.ts:42:0")).toEqual({ path: "src/foo.ts", line: 42 })
  })

  it("never leaves a position on the path itself", () => {
    const ref = parseFileRef("src/a.ts:12:3")
    expect(ref?.path).toBe("src/a.ts")
    expect(formatFileRef(ref as { path: string })).toBe("src/a.ts:12:3")
  })
})

describe("parseFileRef — rejects", () => {
  it("rejects URLs and anything scheme-shaped", () => {
    for (const bad of [
      "https://x.dev/a.ts",
      "http://localhost:4700",
      "//cdn.example.com/a.js",
      "mailto:a@b.dev",
      "file:///Users/me/a.ts",
      "www.example.com/index.html",
      "example.com/index.html",
      "docs.google.com/a.html",
    ]) {
      expect(parseFileRef(bad)).toBeNull()
    }
  })

  it("rejects package specifiers and flags", () => {
    for (const bad of ["@chunky/protocol", "@types/react", "@scope/pkg.js", "--out-dir", "-v"]) {
      expect(parseFileRef(bad)).toBeNull()
    }
  })

  it("rejects anything with whitespace — commands are not paths", () => {
    for (const bad of ["npm install", "bun run typecheck", "src/a.ts b.ts", "rm -rf /tmp/x"]) {
      expect(parseFileRef(bad)).toBeNull()
    }
  })

  it("rejects shell punctuation, globs and substitutions", () => {
    for (const bad of [
      "src/*.ts",
      "src/a.ts;rm",
      "$(pwd)/a.ts",
      "`pwd`",
      "a.ts|b.ts",
      "src/a.ts&",
      "C:\\Users\\me\\a.ts",
      "foo=bar.ts",
    ]) {
      expect(parseFileRef(bad)).toBeNull()
    }
  })

  it("rejects route-ish absolute paths", () => {
    for (const bad of ["/app/x", "/api/users/1", "/dashboard", "/settings/profile.tsx", "/"]) {
      expect(parseFileRef(bad)).toBeNull()
    }
  })

  it("rejects bare words and unknown bare extensions", () => {
    for (const bad of [
      "install",
      "renderMarkdown",
      "React.memo",
      "chunky.dev",
      "Dockerfile.dev",
      "v1.2.3",
      "0.3.12",
      "Node.qux",
      ".env",
      "…",
    ]) {
      expect(parseFileRef(bad)).toBeNull()
    }
  })

  it("rejects directory-ish and structureless tokens", () => {
    for (const bad of ["src/", "src/mainview/lib", "~", "~x", "./", "", "   "]) {
      expect(parseFileRef(bad)).toBeNull()
    }
  })

  it("rejects non-strings and oversized input", () => {
    expect(parseFileRef(null)).toBeNull()
    expect(parseFileRef(undefined)).toBeNull()
    expect(parseFileRef(42)).toBeNull()
    expect(parseFileRef({ path: "a.ts" })).toBeNull()
    expect(parseFileRef(`src/${"a".repeat(600)}.ts`)).toBeNull()
    expect(parseFileRef("src/a\u0000.ts")).toBeNull()
  })
})

describe("parseFileRef — streaming safety", () => {
  it("never throws on any prefix of a path-bearing sentence", () => {
    const doc = "see src/mainview/lib/markdown.tsx:42:7 and ~/notes/todo.md — not @scope/pkg"
    for (let n = 0; n <= doc.length; n++) {
      expect(() => parseFileRef(doc.slice(0, n))).not.toThrow()
    }
  })

  it("treats half-typed paths as not-a-path", () => {
    for (const partial of ["src", "src/", "src/a", "src/a.", "/Us", "~", "~/"]) {
      expect(isFileRef(partial)).toBe(false)
    }
    // …until the extension lands.
    expect(isFileRef("src/a.ts")).toBe(true)
  })
})

describe("formatFileRef", () => {
  it("round-trips the three shapes", () => {
    expect(formatFileRef({ path: "a/b.ts" })).toBe("a/b.ts")
    expect(formatFileRef({ path: "a/b.ts", line: 4 })).toBe("a/b.ts:4")
    expect(formatFileRef({ path: "a/b.ts", line: 4, column: 9 })).toBe("a/b.ts:4:9")
  })
})
