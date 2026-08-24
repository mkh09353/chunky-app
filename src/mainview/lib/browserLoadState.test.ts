// Recognising a real load failure — the engine's own error-page commit.
// Run with: bun test src/mainview/lib/browserLoadState.test.ts
import { describe, expect, test } from "bun:test"
import { describeLoadFailure, hostLabel, isErrorPageUrl, shouldClearFailure } from "./browserLoadState"

describe("isErrorPageUrl", () => {
  test("recognises engine error documents", () => {
    expect(isErrorPageUrl("chrome-error://chromewebdata/")).toBe(true)
    expect(isErrorPageUrl("chrome-error://chromewebdata/?e=-105")).toBe(true)
    expect(isErrorPageUrl("chrome://network-error/-105")).toBe(true)
    expect(isErrorPageUrl("about:neterror?e=dnsNotFound")).toBe(true)
  })

  test("leaves real pages alone", () => {
    expect(isErrorPageUrl("https://example.com/")).toBe(false)
    expect(isErrorPageUrl("http://localhost:4620/x")).toBe(false)
    expect(isErrorPageUrl("about:blank")).toBe(false)
    // A page whose own URL merely mentions an error is not an error page.
    expect(isErrorPageUrl("https://example.com/chrome-error://chromewebdata")).toBe(false)
    expect(isErrorPageUrl("https://neterror.example.com/")).toBe(false)
  })

  test("tolerates junk", () => {
    expect(isErrorPageUrl("")).toBe(false)
    expect(isErrorPageUrl("not a url")).toBe(false)
    expect(isErrorPageUrl(null)).toBe(false)
    expect(isErrorPageUrl(undefined)).toBe(false)
    expect(isErrorPageUrl(7)).toBe(false)
  })
})

describe("describeLoadFailure", () => {
  test("names the requested host, not the error page", () => {
    expect(describeLoadFailure("chrome-error://chromewebdata/", "https://nope.invalid/thing")).toEqual({
      url: "https://nope.invalid/thing",
      host: "nope.invalid",
      reason: null,
    })
  })

  test("reads an engine-provided reason out of the error URL when present", () => {
    const failure = describeLoadFailure("chrome-error://chromewebdata/?e=-105", "https://nope.invalid/")
    expect(failure?.reason).toBe("-105")
    expect(describeLoadFailure("about:neterror?d=dnsNotFound", "https://nope.invalid/")?.reason).toBe(
      "dnsNotFound",
    )
  })

  test("falls back to the error URL when nothing was requested", () => {
    const failure = describeLoadFailure("chrome-error://chromewebdata/", null)
    expect(failure?.url).toBe("chrome-error://chromewebdata/")
  })

  test("a successful navigation is not a failure", () => {
    expect(describeLoadFailure("https://example.com/", "https://example.com/")).toBeNull()
    expect(describeLoadFailure(null, "https://example.com/")).toBeNull()
  })
})

describe("hostLabel", () => {
  test("prefers the host and degrades gracefully", () => {
    expect(hostLabel("https://example.com/deep/path?q=1")).toBe("example.com")
    expect(hostLabel("about:blank")).toBe("about:blank")
    expect(hostLabel("garbage")).toBe("garbage")
  })
})

describe("shouldClearFailure", () => {
  test("any navigation to a real document clears the error surface", () => {
    expect(shouldClearFailure("https://example.com/")).toBe(true)
    expect(shouldClearFailure("about:blank")).toBe(true)
    expect(shouldClearFailure("chrome-error://chromewebdata/")).toBe(false)
  })
})
