import { describe, expect, test } from "bun:test"
import { serverMismatchWarning } from "./serverMismatch"

const installed = { version: "2.0.0", buildId: "current-build" }

describe("serverMismatchWarning", () => {
  test("warns for a development server", () => {
    expect(serverMismatchWarning("https://remote.example", installed, {
      workspace: "/repo",
      version: "1.0.0",
      channel: "dev",
    })).toBe("Connected to a development Chunky server (v1.0.0) — shipped fixes may be missing")
  })

  test("warns for a localhost version mismatch", () => {
    expect(serverMismatchWarning("http://localhost:4620", installed, {
      workspace: "/repo",
      version: "1.0.0",
      channel: "managed",
    })).toBe("Server v1.0.0 does not match installed runtime v2.0.0")
  })

  test("keeps a remote version mismatch silent", () => {
    expect(serverMismatchWarning("https://remote.example", installed, {
      workspace: "/repo",
      version: "1.0.0",
      channel: "managed",
    })).toBeNull()
  })

  test("keeps older responses with missing identity fields silent", () => {
    expect(serverMismatchWarning("http://127.0.0.1:4620", installed, {
      workspace: "/repo",
    })).toBeNull()
    expect(serverMismatchWarning("https://remote.example", installed, {
      workspace: "/repo",
      channel: "dev",
    })).toBeNull()
    expect(serverMismatchWarning("http://localhost:4620", installed, {
      workspace: "/repo",
      version: "1.0.0",
    })).toBeNull()
  })

  test("keeps a matching managed server silent", () => {
    expect(serverMismatchWarning("http://127.0.0.1:4620", installed, {
      workspace: "/repo",
      version: "2.0.0",
      channel: "managed",
    })).toBeNull()
  })
})
