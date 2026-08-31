import { afterEach, describe, expect, test } from "bun:test"
import {
  fetchSessionHistory,
  fetchSessionTodos,
  SessionHistoryRewritten,
  SessionHistoryUnsupported,
} from "./api"

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })

describe("fetchSessionHistory", () => {
  test("requests a bounded tail and older cursor", async () => {
    let requested = ""
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      requested = String(input)
      return Response.json({
        events: [], cursor: { generation: "g", nextSeq: 4 },
        before: "older", hasMore: true, firstSeq: null, lastSeq: null,
      })
    }) as typeof fetch
    const response = await fetchSessionHistory("http://x/", "s", { turns: 10, before: "page" })
    expect(requested).toBe("http://x/api/sessions/s/history?turns=10&before=page")
    expect(response.cursor.nextSeq).toBe(4)
  })

  test("404 is typed so cold attach can silently use full replay", async () => {
    globalThis.fetch = (async () => new Response(null, { status: 404 })) as unknown as typeof fetch
    await expect(fetchSessionHistory("http://x", "s", { turns: 10 }))
      .rejects.toBeInstanceOf(SessionHistoryUnsupported)
  })

  test("409 carries the current generation cursor for a full rebuild", async () => {
    globalThis.fetch = (async () => Response.json({
      error: "history-rewritten", cursor: { generation: "g2", nextSeq: 7 },
    }, { status: 409 })) as unknown as typeof fetch
    try {
      await fetchSessionHistory("http://x", "s", { before: "old" })
      throw new Error("expected rejection")
    } catch (err) {
      expect(err).toBeInstanceOf(SessionHistoryRewritten)
      expect((err as SessionHistoryRewritten).cursor).toEqual({ generation: "g2", nextSeq: 7 })
    }
  })

  test("hydrates the current todos snapshot separately from bounded history", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      expect(String(input)).toBe("http://x/api/sessions/s/todos")
      return Response.json([{ id: "1", content: "verify", status: "pending" }])
    }) as unknown as typeof fetch
    expect(await fetchSessionTodos("http://x/", "s")).toEqual([
      { id: "1", content: "verify", status: "pending" },
    ])
  })
})
