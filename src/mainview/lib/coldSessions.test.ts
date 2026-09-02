import { afterEach, describe, expect, test } from "bun:test"
import { listSessions } from "./api"
import { mergeColdThreads } from "./coldSessions"
import type { Thread } from "./mock"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

function thread(id: string): Thread {
  return {
    id,
    projectId: "repo:r1",
    title: id,
    updated: "1d",
    preview: "",
    status: { kind: "idle", ago: "1d" },
    branch: "main",
    messages: [],
  }
}

function summary(id: string, extra: Record<string, unknown> = {}) {
  return {
    sessionId: id,
    title: id,
    lastActivity: 1,
    workspace: "/tmp/r1",
    attached: false,
    running: false,
    ...extra,
  }
}

describe("listSessions archived flag", () => {
  test("sets archived=1 alongside the repo filter", async () => {
    let requested = ""
    globalThis.fetch = (async (input: unknown) => {
      requested = String(input)
      return new Response(
        JSON.stringify({ sessions: [summary("cold-1", { archived: true, lastActivity: 5 })] }),
        { status: 200 },
      )
    }) as unknown as typeof fetch

    const rows = await listSessions("http://localhost:4317", "r1", undefined, { archived: true })
    const url = new URL(requested)
    expect(url.searchParams.get("archived")).toBe("1")
    expect(url.searchParams.get("repo")).toBe("r1")
    expect(rows.map((r) => r.sessionId)).toEqual(["cold-1"])
  })

  test("sorts archived rows by lastActivity desc", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          sessions: [
            summary("old", { archived: true, lastActivity: 1 }),
            summary("new", { archived: true, lastActivity: 9 }),
          ],
        }),
        { status: 200 },
      )) as unknown as typeof fetch

    const rows = await listSessions("http://localhost:4317", "r1", undefined, { archived: true })
    expect(rows.map((r) => r.sessionId)).toEqual(["new", "old"])
  })

  test("an older server that ignores the flag yields no cold rows", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ sessions: [summary("live-1"), summary("live-2")] }), {
        status: 200,
      })) as unknown as typeof fetch

    const rows = await listSessions("http://localhost:4317", "r1", undefined, { archived: true })
    expect(rows).toEqual([])
  })

  test("never sets archived on the ordinary live list", async () => {
    let requested = ""
    globalThis.fetch = (async (input: unknown) => {
      requested = String(input)
      return new Response(JSON.stringify({ sessions: [summary("live-1")] }), { status: 200 })
    }) as unknown as typeof fetch

    const rows = await listSessions("http://localhost:4317", "r1")
    expect(new URL(requested).searchParams.has("archived")).toBe(false)
    expect(rows.map((r) => r.sessionId)).toEqual(["live-1"])
  })

  test("refuses archived rows for the repository-less scope", async () => {
    globalThis.fetch = (async () => {
      throw new Error("should not be requested")
    }) as unknown as typeof fetch

    await expect(
      listSessions("http://localhost:4317", null, "none", { archived: true }),
    ).rejects.toThrow(/without a repository/)
  })
})

describe("mergeColdThreads", () => {
  test("keeps cold rows that are not already drawn", () => {
    const merged = mergeColdThreads([thread("a")], [thread("b"), thread("c")])
    expect(merged.map((t) => t.id)).toEqual(["b", "c"])
  })

  test("a locally archived session shows once", () => {
    const merged = mergeColdThreads([thread("a")], [thread("a"), thread("b")])
    expect(merged.map((t) => t.id)).toEqual(["b"])
  })

  test("drops rows that are back in the live list", () => {
    const merged = mergeColdThreads([], [thread("a"), thread("b")], new Set(["a"]))
    expect(merged.map((t) => t.id)).toEqual(["b"])
  })

  test("no cold rows → nothing", () => {
    expect(mergeColdThreads([thread("a")], undefined)).toEqual([])
  })
})
