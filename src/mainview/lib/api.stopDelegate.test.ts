// Stopping ONE delegate, and the compatibility rule that makes it safe to ship
// against older servers: a 404 can mean either "no such run" (a real answer) or
// "no such route" (this server predates stop_delegate), and the App must not
// confuse the two — the first is a notice, the second silently retires the
// button.
import { afterEach, describe, expect, test } from "bun:test"
import type { StopDelegateResponse } from "@chunky/protocol"
import { classifyStopDelegate, stopDelegate, stopDelegateAvailable } from "./api"

const CANCELLED: StopDelegateResponse = {
  outcome: "cancelled",
  status: "cancelled",
  seat: "frontend",
  threadId: "sess-1:sidekick:frontend",
  message: "Sidekick (frontend) cancelled by user.",
}

describe("classifyStopDelegate", () => {
  test("a stop that landed is a plain ok, message and all", () => {
    const result = classifyStopDelegate(200, CANCELLED)
    expect(result).toEqual({ status: "ok", response: CANCELLED })
  })

  test("semantic answers stay user-facing, whatever HTTP status they arrive on", () => {
    // 404 WITH an outcome: that run is gone. Still an answer, not a missing route.
    const gone = classifyStopDelegate(404, {
      outcome: "not-found",
      runId: "r1",
      message: 'error: no detached run "r1" in this session.',
    })
    expect(gone.status).toBe("ok")
    // 409: two live delegates on one seat — the message tells the user what to do.
    const ambiguous = classifyStopDelegate(409, {
      outcome: "ambiguous",
      seat: "frontend",
      message: 'error: multiple live delegates on seat "frontend" — pass runId.',
    })
    expect(ambiguous.status).toBe("ok")
    expect(classifyStopDelegate(200, { outcome: "already-finished", message: "done" }).status).toBe(
      "ok",
    )
  })

  test("a route that isn't there is unsupported, not an error", () => {
    // Older servers answer an unmatched route with a plain `not found` string,
    // which never parses — the caller passes null.
    expect(classifyStopDelegate(404, null)).toEqual({ status: "unsupported" })
    expect(classifyStopDelegate(405, null)).toEqual({ status: "unsupported" })
    expect(classifyStopDelegate(404, "not found")).toEqual({ status: "unsupported" })
    expect(classifyStopDelegate(501, { outcome: "cancelled", message: "x" })).toEqual({
      status: "unsupported",
    })
  })

  test("a JSON 404 from a CAPABLE server is an error for this call only", () => {
    // The sessions router 404s an unknown/archived session id before it ever
    // reaches the stop-delegate branch. Reading that as "no such endpoint"
    // would retire the button on a server that has it.
    expect(classifyStopDelegate(404, { error: "unknown session" })).toEqual({
      status: "error",
      message: "unknown session",
    })
    expect(classifyStopDelegate(404, {})).toEqual({
      status: "error",
      message: "stop delegate failed (404)",
    })
  })

  test("anything else is an error carrying the server's own words", () => {
    expect(classifyStopDelegate(400, { error: "invalid runId" })).toEqual({
      status: "error",
      message: "invalid runId",
    })
    expect(classifyStopDelegate(500, null)).toEqual({
      status: "error",
      message: "stop delegate failed (500)",
    })
  })
})

describe("stopDelegate", () => {
  const original = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = original
  })

  function stub(status: number, body: unknown): { calls: { url: string; init?: RequestInit }[] } {
    const calls: { url: string; init?: RequestInit }[] = []
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), ...(init ? { init } : {}) })
      return Promise.resolve(
        new Response(body === null ? "" : JSON.stringify(body), {
          status,
          headers: { "Content-Type": "application/json" },
        }),
      )
    }) as unknown as typeof fetch
    return { calls }
  }

  test("POSTs the target to the session's stop-delegate route", async () => {
    const { calls } = stub(200, CANCELLED)
    const result = await stopDelegate("http://localhost:4620", "sess-1", { seat: "frontend" })
    expect(result).toEqual({ status: "ok", response: CANCELLED })
    expect(calls[0]!.url).toBe("http://localhost:4620/api/sessions/sess-1/stop-delegate")
    expect(calls[0]!.init?.method).toBe("POST")
    expect(calls[0]!.init?.body).toBe('{"seat":"frontend"}')
  })

  test("an empty target is the default seat, and an empty 404 body is unsupported", async () => {
    const { calls } = stub(404, null)
    expect(await stopDelegate("http://localhost:4620", "sess-1")).toEqual({ status: "unsupported" })
    expect(calls[0]!.init?.body).toBe("{}")
  })

  test("a transport failure is an error, never a crash", async () => {
    globalThis.fetch = (() => Promise.reject(new Error("Load failed"))) as unknown as typeof fetch
    expect(await stopDelegate("http://localhost:4620", "sess-1", { runId: "r1" })).toEqual({
      status: "error",
      message: "Load failed",
    })
  })

  test("no server at all is an error rather than a request", async () => {
    expect(await stopDelegate("", "sess-1")).toEqual({
      status: "error",
      message: "Chunky server is unavailable",
    })
  })

  test("an unknown session does NOT retire the endpoint", async () => {
    stub(404, { error: "unknown session" })
    const result = await stopDelegate("http://localhost:4620", "gone")
    expect(result).toEqual({ status: "error", message: "unknown session" })
    // Which is what keeps the control alive on this server (see below).
    expect(stopDelegateAvailable("http://localhost:4620", null)).toBe(true)
  })
})

describe("stopDelegateAvailable", () => {
  test("offers Stop until THIS server says it has no such endpoint", () => {
    expect(stopDelegateAvailable("http://localhost:4620", null)).toBe(true)
    expect(stopDelegateAvailable("http://localhost:4620", "http://localhost:4620")).toBe(false)
  })

  test("recovers by itself on a reconnect or in-place upgrade to another server", () => {
    const old = "http://localhost:4620"
    // The app moved onto a replacement/upgraded server without remounting:
    // the remembered refusal belongs to the OLD base URL, so the new one is
    // offered again with no reset step to forget.
    expect(stopDelegateAvailable("http://localhost:4621", old)).toBe(true)
    expect(stopDelegateAvailable("/chunky-api", old)).toBe(true)
  })

  test("no server means nothing to stop", () => {
    expect(stopDelegateAvailable("", null)).toBe(false)
    expect(stopDelegateAvailable(undefined, null)).toBe(false)
    expect(stopDelegateAvailable(null, null)).toBe(false)
  })
})
