// Live delegate status, and the compatibility rule that makes it safe to poll a
// server that has never heard of the endpoint: a 404 with no JSON body means
// "this server predates /api/sessions/:id/delegates", and the App must stop
// asking THAT server without treating a semantic 404 (unknown session) the same
// way.
import { afterEach, describe, expect, test } from "bun:test"
import {
  classifyDelegatesResponse,
  delegatesAvailable,
  getSessionDelegates,
  type DelegatesResult,
} from "./api"

const ROW = {
  kind: "sidekick",
  run_id: "run-7",
  thread_id: "sess-1:sidekick:frontend",
  seat: "frontend",
  title: "Sidekick (frontend)",
  status: "running",
  elapsed_ms: 12_000,
}

describe("classifyDelegatesResponse", () => {
  test("a 200 payload becomes typed, camel-cased rows", () => {
    const result = classifyDelegatesResponse(200, { runs: [ROW] })
    expect(result).toEqual({
      status: "ok",
      runs: [
        {
          kind: "sidekick",
          threadId: "sess-1:sidekick:frontend",
          status: "running",
          title: "Sidekick (frontend)",
          elapsedMs: 12_000,
          runId: "run-7",
          seat: "frontend",
        },
      ],
    })
  })

  test("a 200 with nothing usable is an empty snapshot, never a crash", () => {
    expect(classifyDelegatesResponse(200, { runs: [] })).toEqual({ status: "ok", runs: [] })
    expect(classifyDelegatesResponse(200, {})).toEqual({ status: "ok", runs: [] })
    expect(classifyDelegatesResponse(200, null)).toEqual({ status: "ok", runs: [] })
    expect(classifyDelegatesResponse(200, "hello")).toEqual({ status: "ok", runs: [] })
  })

  test("one malformed row is dropped, the rest of the snapshot survives", () => {
    const result = classifyDelegatesResponse(200, {
      runs: [
        { ...ROW, kind: "telepathy" },
        { ...ROW, thread_id: "" },
        { ...ROW, status: "pondering" },
        { kind: "workflow", thread_id: "t2", title: "Audit", status: "completed" },
      ],
    })
    expect(result.status).toBe("ok")
    const runs = (result as Extract<DelegatesResult, { status: "ok" }>).runs
    expect(runs).toHaveLength(1)
    // A row with no elapsed still counts; it just has nothing to say about time.
    expect(runs[0]).toEqual({
      kind: "workflow",
      threadId: "t2",
      title: "Audit",
      status: "completed",
      elapsedMs: 0,
    })
  })

  test("a 404 the server could not put JSON on is the route being absent", () => {
    expect(classifyDelegatesResponse(404, null)).toEqual({ status: "unsupported" })
    expect(classifyDelegatesResponse(404, "not found")).toEqual({ status: "unsupported" })
    expect(classifyDelegatesResponse(404, {})).toEqual({ status: "unsupported" })
    expect(classifyDelegatesResponse(405, null)).toEqual({ status: "unsupported" })
  })

  test("a 404 with a JSON error is THIS call failing, not the endpoint missing", () => {
    // The sessions router 404s an unknown/archived id before reaching the
    // delegates branch. Retiring the endpoint on that would be wrong.
    expect(classifyDelegatesResponse(404, { error: "unknown session" })).toEqual({
      status: "error",
      message: "unknown session",
    })
  })

  test("501 is unsupported, and a 500 is a plain error", () => {
    expect(classifyDelegatesResponse(501, { runs: [] })).toEqual({ status: "unsupported" })
    expect(classifyDelegatesResponse(500, null)).toEqual({
      status: "error",
      message: "delegate status failed (500)",
    })
    expect(classifyDelegatesResponse(500, { error: "boom" })).toEqual({
      status: "error",
      message: "boom",
    })
  })
})

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

function stubFetch(reply: { status: number; body: unknown } | Error): { url: string }[] {
  const calls: { url: string }[] = []
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    calls.push({ url: String(input) })
    if (reply instanceof Error) throw reply
    return {
      status: reply.status,
      json: async () => reply.body,
    } as unknown as Response
  }) as typeof fetch
  return calls
}

describe("getSessionDelegates", () => {
  test("GETs the session's delegates route and returns its rows", async () => {
    const calls = stubFetch({ status: 200, body: { runs: [ROW] } })
    const result = await getSessionDelegates("http://localhost:4620", "sess-1")
    expect(calls[0]!.url).toBe("http://localhost:4620/api/sessions/sess-1/delegates")
    expect(result.status).toBe("ok")
  })

  test("optional filters travel as the wire's snake_case query", async () => {
    const calls = stubFetch({ status: 200, body: { runs: [] } })
    await getSessionDelegates("http://localhost:4620", "sess-1", {
      runId: "run-7",
      seat: "frontend",
      timeoutMs: 1500,
    })
    expect(calls[0]!.url).toBe(
      "http://localhost:4620/api/sessions/sess-1/delegates?run_id=run-7&seat=frontend&timeout_ms=1500",
    )
  })

  test("an old server (404, no JSON) is unsupported, not an error", async () => {
    stubFetch({ status: 404, body: null })
    expect(await getSessionDelegates("http://localhost:4620", "sess-1")).toEqual({
      status: "unsupported",
    })
  })

  test("a transport failure is an error, never a throw", async () => {
    stubFetch(new Error("network down"))
    expect(await getSessionDelegates("http://localhost:4620", "sess-1")).toEqual({
      status: "error",
      message: "network down",
    })
  })

  test("no server at all is an error rather than a request", async () => {
    const calls = stubFetch({ status: 200, body: { runs: [] } })
    expect(await getSessionDelegates("", "sess-1")).toEqual({
      status: "error",
      message: "Chunky server is unavailable",
    })
    expect(calls).toHaveLength(0)
  })
})

describe("delegatesAvailable", () => {
  test("polls until THIS server says it has no such endpoint", () => {
    expect(delegatesAvailable("http://localhost:4620", null)).toBe(true)
    expect(delegatesAvailable("http://localhost:4620", "http://localhost:4620")).toBe(false)
  })

  test("recovers by itself on a reconnect or upgrade onto another base URL", () => {
    const old = "http://localhost:4620"
    expect(delegatesAvailable("http://localhost:4621", old)).toBe(true)
    expect(delegatesAvailable("/chunky-api", old)).toBe(true)
  })

  test("no server means nothing to poll", () => {
    expect(delegatesAvailable("", null)).toBe(false)
    expect(delegatesAvailable(undefined, null)).toBe(false)
    expect(delegatesAvailable(null, null)).toBe(false)
  })
})
