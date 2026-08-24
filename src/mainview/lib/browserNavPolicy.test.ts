// What may load in the browser pane.
// Run with: bun test src/mainview/lib/browserNavPolicy.test.ts
import { describe, expect, test } from "bun:test"
import {
  BLANK_URL,
  DEFAULT_PANE_URL,
  isAllowedPaneUrl,
  resolveAddressInput,
  resolveProgrammaticUrl,
  resolveStartupUrl,
} from "./browserNavPolicy"

describe("isAllowedPaneUrl", () => {
  test("allows http, https and about:blank", () => {
    expect(isAllowedPaneUrl("http://example.com/")).toBe(true)
    expect(isAllowedPaneUrl("https://example.com/path?q=1#frag")).toBe(true)
    expect(isAllowedPaneUrl("https://localhost:5173/")).toBe(true)
    expect(isAllowedPaneUrl(BLANK_URL)).toBe(true)
  })

  test("refuses every other scheme, however it is spelled", () => {
    for (const url of [
      "javascript:alert(1)",
      "JaVaScRiPt:alert(1)",
      "  javascript:alert(1)  ",
      "file:///etc/passwd",
      "data:text/html,<script>alert(1)</script>",
      "views://mainview/index.html",
      "chunky://open",
      "itms-apps://apple.com",
      "chrome://settings",
      "about:config",
      "blob:https://example.com/abc",
      "ws://example.com/socket",
    ]) {
      expect(isAllowedPaneUrl(url)).toBe(false)
    }
  })

  test("refuses malformed input and non-strings", () => {
    expect(isAllowedPaneUrl("")).toBe(false)
    expect(isAllowedPaneUrl("   ")).toBe(false)
    expect(isAllowedPaneUrl("not a url")).toBe(false)
    expect(isAllowedPaneUrl("/relative/path")).toBe(false)
    expect(isAllowedPaneUrl("http://")).toBe(false)
    expect(isAllowedPaneUrl(null)).toBe(false)
    expect(isAllowedPaneUrl(undefined)).toBe(false)
    expect(isAllowedPaneUrl(42)).toBe(false)
  })
})

describe("resolveProgrammaticUrl", () => {
  test("passes through allowed URLs, normalized", () => {
    expect(resolveProgrammaticUrl("https://example.com")).toEqual({ ok: true, url: "https://example.com/" })
    expect(resolveProgrammaticUrl("  http://example.com/x  ")).toEqual({ ok: true, url: "http://example.com/x" })
    expect(resolveProgrammaticUrl(BLANK_URL)).toEqual({ ok: true, url: BLANK_URL })
  })

  test("never searches: a bare term is a rejection, not a query", () => {
    const result = resolveProgrammaticUrl("chunky release notes")
    expect(result.ok).toBe(false)
  })

  test("rejects dangerous schemes with a reason", () => {
    const result = resolveProgrammaticUrl("javascript:alert(document.cookie)")
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain("http")
  })

  test("rejects junk", () => {
    expect(resolveProgrammaticUrl("").ok).toBe(false)
    expect(resolveProgrammaticUrl(null).ok).toBe(false)
    expect(resolveProgrammaticUrl({ url: "https://example.com" }).ok).toBe(false)
  })
})

describe("resolveAddressInput", () => {
  test("loads what is clearly a URL", () => {
    expect(resolveAddressInput("https://example.com/a")).toEqual({ ok: true, url: "https://example.com/a" })
    expect(resolveAddressInput("example.com")).toEqual({ ok: true, url: "https://example.com/" })
    expect(resolveAddressInput("example.com/deep/path")).toEqual({
      ok: true,
      url: "https://example.com/deep/path",
    })
    expect(resolveAddressInput("localhost:4620")).toEqual({ ok: true, url: "https://localhost:4620/" })
    expect(resolveAddressInput("127.0.0.1:8080")).toEqual({ ok: true, url: "https://127.0.0.1:8080/" })
  })

  test("searches for bare terms (unchanged behaviour)", () => {
    const result = resolveAddressInput("what is a chunky")
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.url.startsWith("https://duckduckgo.com/?q=")).toBe(true)
      expect(result.url).toContain("what%20is%20a%20chunky")
    }
  })

  test("empty input goes home", () => {
    expect(resolveAddressInput("   ")).toEqual({ ok: true, url: DEFAULT_PANE_URL })
  })

  test("a typed dangerous scheme is REFUSED, not searched", () => {
    for (const input of ["javascript:alert(1)", "file:///etc/passwd", "data:text/html,x", "chrome://settings"]) {
      const result = resolveAddressInput(input)
      expect(result.ok).toBe(false)
    }
  })

  test("a scheme-looking string that cannot parse falls back to search", () => {
    const result = resolveAddressInput("ratio: 3:1 is fine")
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.url.startsWith("https://duckduckgo.com/?q=")).toBe(true)
  })
})

describe("resolveStartupUrl", () => {
  test("takes the first acceptable candidate", () => {
    expect(resolveStartupUrl("https://a.test/", "https://b.test/")).toBe("https://a.test/")
    expect(resolveStartupUrl(null, "https://b.test/")).toBe("https://b.test/")
  })

  test("falls back to the home page instead of leaving the pane blank", () => {
    expect(resolveStartupUrl("javascript:alert(1)", "file:///x")).toBe(DEFAULT_PANE_URL)
    expect(resolveStartupUrl(null, undefined)).toBe(DEFAULT_PANE_URL)
  })
})
