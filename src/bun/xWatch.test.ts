import { describe, expect, test } from "bun:test"
import { buildXWatchPrompt, formatXArtifact, normalizeXHandle, normalizeXPostUrl, parseXFindings, runXWatchSession, xWindowHours } from "./xWatch"

describe("X normalization and parsing", () => {
  test("normalizes handles and profile URLs", () => {
    expect(normalizeXHandle(" @Theo ")).toBe("theo")
    expect(normalizeXHandle("https://twitter.com/THEO/")).toBe("theo")
    expect(normalizeXHandle("x.com/a_b?x=1")).toBe("a_b")
    expect(normalizeXHandle("bad-name")).toBeNull()
    expect(normalizeXHandle("abcdefghijklmnop")).toBeNull()
  })
  test("canonicalizes status URLs and rejects non-post URLs", () => {
    expect(normalizeXPostUrl("https://twitter.com/Theo/status/123?s=20")).toBe("https://x.com/theo/status/123")
    expect(normalizeXPostUrl("x.com/@Theo/status/456/photo/1")).toBe("https://x.com/theo/status/456")
    expect(normalizeXPostUrl("https://x.com/theo")).toBeNull()
  })
  test("requires fenced arrays, validates account and dedupes canonical URL", () => {
    const row = { url: "https://twitter.com/THEO/status/123?s=1", author: "@Theo", text: "Ship it", postedAt: "2026-01-01T00:00:00Z" }
    expect(parseXFindings(`prose\n\`\`\`json\n${JSON.stringify([row, { ...row, url: "x.com/theo/status/123" }])}\n\`\`\``, "theo")).toEqual([{ url: "https://x.com/theo/status/123", author: "@theo", text: "Ship it", postedAt: Date.parse("2026-01-01T00:00:00Z") }])
    expect(parseXFindings("```json\n[]\n```", "theo")).toEqual([])
    expect(() => parseXFindings("[]", "theo")).toThrow("no fenced")
    expect(() => parseXFindings("```json\n{}\n```", "theo")).toThrow("not an array")
    expect(() => parseXFindings(`\`\`\`json\n${JSON.stringify([{ ...row, author: "other" }])}\n\`\`\``, "theo")).toThrow("invalid URL")
  })
  test("uses at least two hours and bounded initial/catch-up windows", () => {
    const now = Date.UTC(2026, 0, 2)
    expect(xWindowHours(now - 1_000, now)).toBe(2)
    expect(xWindowHours(now - 3.2 * 3_600_000, now)).toBe(4)
    expect(xWindowHours(null, now)).toBe(24)
    expect(xWindowHours(now - 900 * 3_600_000, now)).toBe(720)
    expect(buildXWatchPrompt("theo", 2)).toContain("last 2 hours")
  })
  test("formats URL-keyed artifacts without credentials", () => {
    const artifact = formatXArtifact({ url: "https://x.com/theo/status/1", author: "@theo", text: "hello", postedAt: 0 })
    expect(artifact.externalId).toBe(artifact.url)
    expect(artifact.content).toContain("hello")
  })
})

function sse(events: unknown[]): Response {
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } })
}

describe("authenticated Grok session runner", () => {
  test("discovers ready Grok, creates repo-less session, pins by sessionId, opens SSE, then sends", async () => {
    const calls: { url: string; init?: RequestInit }[] = []
    let eventsOpened = false
    const now = Date.UTC(2026, 0, 2, 12)
    const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input); calls.push({ url, init })
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer secret")
      if (url.endsWith("/api/providers")) return Response.json({ providers: [{ id: "grok", ready: true, active: true }] })
      if (url.endsWith("/api/providers/grok/models")) return Response.json({ models: [{ id: "grok-4" }] })
      if (url.endsWith("/api/sessions")) { expect(JSON.parse(String(init?.body))).toEqual({ repositoryScope: "none" }); return Response.json({ sessionId: "s-1" }) }
      if (url.endsWith("/api/model/select")) { expect(JSON.parse(String(init?.body))).toEqual({ provider: "grok", model: "grok-4", sessionId: "s-1" }); return Response.json({ provider: "grok", model: "grok-4", pinned: true }) }
      if (url.endsWith("/events")) { eventsOpened = true; return sse([{ type: "message.start", sessionId: "s-1" }, { type: "message.delta", sessionId: "s-1", text: `\`\`\`json\n[{"url":"https://x.com/theo/status/1","author":"@theo","text":"new","postedAt":"${new Date(now - 3_600_000).toISOString()}"}]\n\`\`\`` }, { type: "message.end", sessionId: "s-1" }]) }
      if (url.endsWith("/messages")) { expect(eventsOpened).toBe(true); expect(String(init?.body)).not.toContain("secret"); return new Response(null, { status: 202 }) }
      throw new Error(`unexpected ${url}`)
    }) as typeof globalThis.fetch
    const result = await runXWatchSession({ handle: "@Theo", since: now - 1_000, now }, { baseUrl: "http://chunky", token: "secret", fetch })
    expect(result).toMatchObject({ provider: "grok", model: "grok-4", findings: [{ url: "https://x.com/theo/status/1" }] })
    expect(calls.findIndex((c) => c.url.endsWith("/api/model/select"))).toBeLessThan(calls.findIndex((c) => c.url.endsWith("/events")))
  })
  test("fails closed without ready Grok and never creates a session", async () => {
    const calls: string[] = []
    const fetch = (async (input: RequestInfo | URL) => { calls.push(String(input)); return Response.json({ providers: [{ id: "grok", ready: false, active: true }] }) }) as typeof globalThis.fetch
    await expect(runXWatchSession({ handle: "theo", since: null, now: 1 }, { baseUrl: "http://chunky", fetch })).rejects.toThrow("configured, active Grok")
    expect(calls).toHaveLength(1)
  })
  test("fails closed on unconfirmed pin and does not open SSE or send", async () => {
    const calls: string[] = []
    const fetch = (async (input: RequestInfo | URL) => { const url = String(input); calls.push(url); if (url.endsWith("/api/providers")) return Response.json({ providers: [{ id: "grok", ready: true, active: true }] }); if (url.endsWith("/models")) return Response.json({ models: [{ id: "g" }] }); if (url.endsWith("/api/sessions")) return Response.json({ sessionId: "s" }); return Response.json({ provider: "grok", model: "g", pinned: false }) }) as typeof globalThis.fetch
    await expect(runXWatchSession({ handle: "theo", since: null, now: 1 }, { baseUrl: "http://chunky", fetch })).rejects.toThrow("could not be pinned")
    expect(calls.some((url) => url.endsWith("/events") || url.endsWith("/messages"))).toBe(false)
  })
  test("redacts a bearer token echoed by an error response", async () => {
    const fetch = (async () => Response.json({ error: "bad secret-token value" }, { status: 500 })) as typeof globalThis.fetch
    await expect(runXWatchSession({ handle: "theo", since: null, now: 1 }, { baseUrl: "http://chunky", token: "secret-token", fetch })).rejects.toThrow("bad [redacted] value")
  })
  test("times out a stream that never completes", async () => {
    const fetch = (async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith("/api/providers")) return Response.json({ providers: [{ id: "grok", ready: true, active: true }] })
      if (url.endsWith("/models")) return Response.json({ models: [{ id: "g" }] })
      if (url.endsWith("/api/sessions")) return Response.json({ sessionId: "s" })
      if (url.endsWith("/api/model/select")) return Response.json({ provider: "grok", model: "g", pinned: true })
      if (url.endsWith("/events")) return new Response(new ReadableStream({ start() {} }))
      return new Response(null, { status: 202 })
    }) as typeof globalThis.fetch
    await expect(runXWatchSession({ handle: "theo", since: null, now: 1 }, { baseUrl: "http://chunky", fetch, timeoutMs: 2 })).rejects.toThrow("timed out")
  })
})
