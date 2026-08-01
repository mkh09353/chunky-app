// The rule that decides whether a lost stream means "retry this server" or
// "the server moved". Getting it wrong in either direction is costly: too eager
// and a hiccup triggers discovery churn, too lazy and the app retries a port
// nothing is listening on until the user restarts it.
import { afterEach, describe, expect, test } from "bun:test"
import {
  isConnectionRefused,
  RERESOLVE_AFTER_ATTEMPTS,
  RERESOLVE_AFTER_REFUSED_ATTEMPTS,
  shouldReresolve,
} from "./reresolve"
import { getModes, setBaseUrl } from "./configApi"

describe("isConnectionRefused", () => {
  test("recognises the browser/runtime wordings for an unreachable server", () => {
    for (const message of [
      "Failed to fetch",
      "Load failed",
      "NetworkError when attempting to fetch resource.",
      "connect ECONNREFUSED 127.0.0.1:4620",
      "fetch failed",
    ]) {
      expect(isConnectionRefused(new TypeError(message))).toBe(true)
    }
  })

  test("does not mistake an HTTP-level failure for an unreachable server", () => {
    expect(isConnectionRefused(new Error("events stream failed (500)"))).toBe(false)
    expect(isConnectionRefused(undefined)).toBe(false)
    expect(isConnectionRefused(null)).toBe(false)
  })
})

describe("shouldReresolve", () => {
  test("a retiring server moves us immediately, whatever the attempt count", () => {
    expect(shouldReresolve({ attempts: 0, retiring: true })).toBe(true)
    expect(shouldReresolve({ attempts: 1, retiring: true })).toBe(true)
  })

  test("a plain transient drop keeps retrying the same server", () => {
    // EOF on a healthy server: no error, first attempts.
    expect(shouldReresolve({ attempts: 1 })).toBe(false)
    expect(shouldReresolve({ attempts: 2 })).toBe(false)
    expect(shouldReresolve({ attempts: 1, error: new Error("events stream failed (502)") })).toBe(false)
  })

  test("gives up on the same server after enough consecutive failures", () => {
    expect(shouldReresolve({ attempts: RERESOLVE_AFTER_ATTEMPTS })).toBe(true)
    expect(shouldReresolve({ attempts: RERESOLVE_AFTER_ATTEMPTS + 5 })).toBe(true)
  })

  test("a refused connection re-resolves sooner than a server-side error", () => {
    const refused = new TypeError("Failed to fetch")
    expect(RERESOLVE_AFTER_REFUSED_ATTEMPTS).toBeLessThan(RERESOLVE_AFTER_ATTEMPTS)
    expect(shouldReresolve({ attempts: RERESOLVE_AFTER_REFUSED_ATTEMPTS - 1, error: refused })).toBe(false)
    expect(shouldReresolve({ attempts: RERESOLVE_AFTER_REFUSED_ATTEMPTS, error: refused })).toBe(true)
  })
})

describe("configApi base URL", () => {
  const realFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = realFetch
    setBaseUrl(undefined)
  })

  test("requests follow the server we were repointed at", async () => {
    const seen: string[] = []
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      seen.push(input.toString())
      return new Response(JSON.stringify({ modes: {} }), { status: 200 })
    }) as typeof fetch

    setBaseUrl("http://localhost:1111")
    await getModes()
    setBaseUrl("http://localhost:2222")
    await getModes()

    expect(seen[0]).toStartWith("http://localhost:1111")
    expect(seen[1]).toStartWith("http://localhost:2222")
  })
})
