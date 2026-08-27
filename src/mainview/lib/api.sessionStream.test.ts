// openSessionEventStream: the v2 request (cursor in the URL) and the two shapes
// a server can answer with — named v2 frames, or bare legacy AgentEvent frames
// from a server that ignored `?stream=v2`.
// Run with: bun test src/mainview/lib/api.sessionStream.test.ts
import { afterEach, describe, expect, test } from "bun:test"
import { encodeSessionEventCursor, sse, sseFrame, type AgentEvent } from "@chunky/protocol"
import { openSessionEventStream, SessionCursorRejected } from "./api"
import type { SessionStreamFrame } from "./sessionStream"

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })

function stubStream(body: string, urls: string[]): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    urls.push(String(input))
    return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } })
  }) as unknown as typeof fetch
}

const CURSOR = encodeSessionEventCursor({ generation: "g1", nextSeq: 4 })

describe("openSessionEventStream", () => {
  test("asks for the v2 stream and resumes from the cursor", async () => {
    const urls: string[] = []
    stubStream(
      sseFrame({ kind: "event", seq: 4, cursor: { generation: "g1", nextSeq: 5 }, event: { type: "message.user", text: "hi" } }) +
      sseFrame({ kind: "replay-end", cursor: { generation: "g1", nextSeq: 5 } }) +
      sseFrame({ kind: "live", event: { type: "message.delta", text: "yo" } }),
      urls,
    )
    const frames: SessionStreamFrame[] = []
    let opened = 0
    await openSessionEventStream("http://x", "s 1", (f) => frames.push(f), { cursor: CURSOR, onOpen: () => { opened += 1 } })

    expect(urls[0]).toContain("stream=v2")
    expect(urls[0]).toContain(`cursor=${encodeURIComponent(CURSOR)}`)
    // NOTE: protocol's ROUTES.events (and therefore sessionEventsUrl) does not
    // percent-encode the session id. Same as the legacy stream — parity, not a
    // regression — so this asserts today's behaviour rather than hiding it.
    expect(urls[0]).toContain("/api/sessions/s 1/events")
    expect(opened).toBe(1)
    expect(frames.map((f) => f.kind)).toEqual(["event", "replay-end", "live"])
    const first = frames[0]
    expect(first && first.kind === "event" ? first.seq : null).toBe(4)
  })

  test("omits the cursor on a fresh attach", async () => {
    const urls: string[] = []
    stubStream(sseFrame({ kind: "replay-end", cursor: { generation: "g1", nextSeq: 0 } }), urls)
    await openSessionEventStream("http://x", "s1", () => {}, {})
    expect(urls[0]).toContain("stream=v2")
    expect(urls[0]).not.toContain("cursor=")
  })

  test("an old server's unnamed frames arrive as legacy events", async () => {
    const urls: string[] = []
    const history: AgentEvent[] = [{ type: "message.user", text: "hi" }, { type: "message.end" }]
    stubStream(history.map(sse).join(""), urls)
    const frames: SessionStreamFrame[] = []
    await openSessionEventStream("http://x", "s1", (f) => frames.push(f), { cursor: CURSOR })
    expect(frames.every((f) => f.kind === "legacy")).toBe(true)
    expect(frames.map((f) => (f as { event: AgentEvent }).event)).toEqual(history)
  })

  test("a cursor the server calls malformed is reported so the caller can drop it", async () => {
    // The real server answers 400 {"error":"invalid session event cursor"};
    // retrying with the same cursor could only fail forever.
    globalThis.fetch = (async () =>
      Response.json({ error: "invalid session event cursor" }, { status: 400 })) as unknown as typeof fetch
    const failure = openSessionEventStream("http://x", "s1", () => {}, { cursor: CURSOR })
    await expect(failure).rejects.toBeInstanceOf(SessionCursorRejected)
  })

  test("a 400 without a cursor is just a stream failure", async () => {
    globalThis.fetch = (async () => new Response("nope", { status: 400 })) as unknown as typeof fetch
    await expect(openSessionEventStream("http://x", "s1", () => {}, {})).rejects.toThrow(/400/)
  })

  test("a non-ok response throws instead of pretending the stream is open", async () => {
    globalThis.fetch = (async () => new Response("nope", { status: 503 })) as unknown as typeof fetch
    let opened = 0
    await expect(
      openSessionEventStream("http://x", "s1", () => {}, { onOpen: () => { opened += 1 } }),
    ).rejects.toThrow(/503/)
    expect(opened).toBe(0)
  })
})
