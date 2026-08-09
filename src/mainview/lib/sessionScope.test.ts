import { afterEach, describe, expect, test } from "bun:test"
import { createSession, listSessions } from "./api"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe("repository-less session API scope", () => {
  test("lists explicit no-repository sessions without using the unfiltered route", async () => {
    let requested = ""
    globalThis.fetch = (async (input) => {
      requested = String(input)
      return new Response(JSON.stringify({ sessions: [] }), { status: 200 })
    }) as typeof fetch

    await listSessions("http://localhost:4317", null, "none")
    expect(new URL(requested).searchParams.get("scope")).toBe("none")
    expect(new URL(requested).searchParams.has("repo")).toBe(false)
  })

  test("creates an explicit no-repository session", async () => {
    let body: unknown
    globalThis.fetch = (async (_input, init) => {
      body = JSON.parse(String(init?.body))
      return new Response(JSON.stringify({ sessionId: "general-1" }), { status: 200 })
    }) as typeof fetch

    await createSession("http://localhost:4317", null, null, "none")
    expect(body).toEqual({ repositoryScope: "none" })
  })

  test("keeps legacy default-repository creation unchanged", async () => {
    let body: unknown
    globalThis.fetch = (async (_input, init) => {
      body = JSON.parse(String(init?.body))
      return new Response(JSON.stringify({ sessionId: "repo-1" }), { status: 200 })
    }) as typeof fetch

    await createSession("http://localhost:4317")
    expect(body).toEqual({})
  })
})
