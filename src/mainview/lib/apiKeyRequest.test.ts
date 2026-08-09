// Claim/replace rules for the agent's "collect an API key" request. Run with:
//   bun test src/mainview/lib/apiKeyRequest.test.ts
import { afterEach, describe, expect, it } from "bun:test"
import {
  apiKeyRequestFrom,
  askForApiKey,
  clearApiKeyRequest,
  consumeApiKeyRequest,
  currentApiKeyRequest,
  resetApiKeyRequests,
  subscribeApiKeyRequests,
} from "./apiKeyRequest"
import { initialState, reduce } from "./transcript"

const FRAME = {
  type: "app.request_api_key",
  requestId: "req-1",
  providerId: "together",
  label: "Together",
}

afterEach(() => {
  resetApiKeyRequests()
})

describe("apiKeyRequestFrom", () => {
  it("reads a well-formed frame", () => {
    expect(apiKeyRequestFrom(FRAME)).toEqual({
      requestId: "req-1",
      providerId: "together",
      label: "Together",
    })
  })

  it("falls back to the provider id when the label is missing or blank", () => {
    expect(apiKeyRequestFrom({ ...FRAME, label: "   " })?.label).toBe("together")
    expect(apiKeyRequestFrom({ ...FRAME, label: undefined })?.label).toBe("together")
    expect(apiKeyRequestFrom({ ...FRAME, label: 7 })?.label).toBe("together")
  })

  it("rejects anything unanswerable", () => {
    expect(apiKeyRequestFrom(null)).toBeNull()
    expect(apiKeyRequestFrom("app.request_api_key")).toBeNull()
    expect(apiKeyRequestFrom({ type: "message.end" })).toBeNull()
    expect(apiKeyRequestFrom({ ...FRAME, requestId: "" })).toBeNull()
    expect(apiKeyRequestFrom({ ...FRAME, requestId: "  " })).toBeNull()
    expect(apiKeyRequestFrom({ ...FRAME, providerId: undefined })).toBeNull()
    expect(apiKeyRequestFrom({ ...FRAME, requestId: 1 })).toBeNull()
  })
})

describe("consumeApiKeyRequest", () => {
  it("claims the event and parks the request", () => {
    const seen: (string | null)[] = []
    const stop = subscribeApiKeyRequests((r) => seen.push(r?.requestId ?? null))
    expect(consumeApiKeyRequest(FRAME)).toBe(true)
    stop()
    expect(seen).toEqual(["req-1"])
    expect(currentApiKeyRequest()?.providerId).toBe("together")
  })

  it("leaves every other event for the reducer", () => {
    expect(consumeApiKeyRequest({ type: "app.open_url", url: "https://a.dev" })).toBe(false)
    expect(consumeApiKeyRequest({ type: "message.end", text: "hi" })).toBe(false)
    expect(currentApiKeyRequest()).toBeNull()
  })

  it("is inert in the transcript reducer even if one ever slipped through", () => {
    const after = reduce(initialState, {
      type: "app.request_api_key",
      requestId: "req-1",
      providerId: "together",
      label: "Together",
    })
    expect(after).toBe(initialState)
  })
})

describe("replace and clear", () => {
  it("replaces the on-screen request with the newest one", () => {
    askForApiKey({ requestId: "req-1", providerId: "together", label: "Together" })
    askForApiKey({ requestId: "req-2", providerId: "fireworks", label: "Fireworks" })
    expect(currentApiKeyRequest()).toEqual({
      requestId: "req-2",
      providerId: "fireworks",
      label: "Fireworks",
    })
  })

  it("ignores a stale clear so a late answer cannot close a newer prompt", () => {
    askForApiKey({ requestId: "req-1", providerId: "together", label: "Together" })
    askForApiKey({ requestId: "req-2", providerId: "fireworks", label: "Fireworks" })
    clearApiKeyRequest("req-1")
    expect(currentApiKeyRequest()?.requestId).toBe("req-2")
    clearApiKeyRequest("req-2")
    expect(currentApiKeyRequest()).toBeNull()
  })

  it("clears unconditionally without an id, and is a no-op when idle", () => {
    const seen: (string | null)[] = []
    const stop = subscribeApiKeyRequests((r) => seen.push(r?.requestId ?? null))
    clearApiKeyRequest()
    askForApiKey({ requestId: "req-3", providerId: "zen", label: "Zen" })
    clearApiKeyRequest()
    stop()
    expect(seen).toEqual(["req-3", null])
    expect(currentApiKeyRequest()).toBeNull()
  })

  it("disposes subscribers cleanly", () => {
    const seen: string[] = []
    const stop = subscribeApiKeyRequests((r) => seen.push(r?.requestId ?? "null"))
    askForApiKey({ requestId: "req-4", providerId: "zen", label: "Zen" })
    stop()
    askForApiKey({ requestId: "req-5", providerId: "zen", label: "Zen" })
    expect(seen).toEqual(["req-4"])
  })
})
