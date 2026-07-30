// Hand-off rules between the link menu, App (mounts the pane) and BrowserPane
// (navigates). Run with:
//   bun test src/mainview/lib/browserNav.test.ts
import { describe, expect, it } from "bun:test"
import {
  appOpenUrlRequest,
  consumeAppOpenUrl,
  openInAppBrowser,
  subscribeBrowserNavigation,
  takePendingBrowserUrl,
} from "./browserNav"
import { reduce, initialState } from "./transcript"

describe("browserNav", () => {
  it("parks a request for a pane that is not mounted yet", () => {
    openInAppBrowser("https://a.dev/x")
    expect(takePendingBrowserUrl()).toBe("https://a.dev/x")
    // Claiming it clears it, so a remount does not re-navigate.
    expect(takePendingBrowserUrl()).toBeNull()
  })

  it("notifies every live subscriber and disposes cleanly", () => {
    const seen: string[] = []
    const stop = subscribeBrowserNavigation((url) => seen.push(url))
    openInAppBrowser("http://localhost:4700")
    takePendingBrowserUrl()
    stop()
    openInAppBrowser("https://b.dev/y")
    takePendingBrowserUrl()
    expect(seen).toEqual(["http://localhost:4700"])
  })

  it("ignores anything that is not an http(s) URL", () => {
    const seen: string[] = []
    const stop = subscribeBrowserNavigation((url) => seen.push(url))
    for (const bad of ["javascript:alert(1)", "file:///etc/passwd", "", "not a url"]) {
      openInAppBrowser(bad)
    }
    stop()
    expect(seen).toEqual([])
    expect(takePendingBrowserUrl()).toBeNull()
  })
})

/**
 * `app.open_url` is the agent asking for the pane. It arrives on the session SSE
 * stream and is intercepted in App's attachSession BEFORE reduce(), so it must
 * never reach the transcript.
 */
describe("app.open_url", () => {
  it("claims the event and navigates the pane", () => {
    const seen: string[] = []
    const stop = subscribeBrowserNavigation((url) => seen.push(url))
    expect(consumeAppOpenUrl({ type: "app.open_url", url: "https://chunky.to/docs" })).toBe(true)
    stop()
    expect(seen).toEqual(["https://chunky.to/docs"])
    expect(takePendingBrowserUrl()).toBe("https://chunky.to/docs")
  })

  it("leaves every other event for the reducer", () => {
    const seen: string[] = []
    const stop = subscribeBrowserNavigation((url) => seen.push(url))
    for (const ev of [
      { type: "message.user", text: "hi" },
      { type: "session.status", status: "idle" },
      null,
      undefined,
      "app.open_url",
      42,
    ]) {
      expect(consumeAppOpenUrl(ev)).toBe(false)
    }
    stop()
    expect(seen).toEqual([])
  })

  it("still claims a malformed or disallowed URL rather than rendering it", () => {
    const seen: string[] = []
    const stop = subscribeBrowserNavigation((url) => seen.push(url))
    // Claimed (never reduced), but openInAppBrowser refuses to navigate.
    for (const url of ["javascript:alert(1)", "file:///etc/passwd", "not a url"]) {
      expect(consumeAppOpenUrl({ type: "app.open_url", url })).toBe(true)
    }
    stop()
    expect(seen).toEqual([])
    expect(takePendingBrowserUrl()).toBeNull()
  })

  it("does not claim a frame with no usable url field", () => {
    expect(appOpenUrlRequest({ type: "app.open_url" })).toBeNull()
    expect(appOpenUrlRequest({ type: "app.open_url", url: "" })).toBeNull()
    expect(appOpenUrlRequest({ type: "app.open_url", url: "   " })).toBeNull()
    expect(appOpenUrlRequest({ type: "app.open_url", url: 42 })).toBeNull()
    expect(appOpenUrlRequest({ type: "app.open_url", url: " https://a.dev/x " })).toBe("https://a.dev/x")
  })

  it("is inert if it ever reaches the transcript reducer anyway", () => {
    const before = initialState
    const after = reduce(before, { type: "app.open_url", url: "https://a.dev/x" })
    expect(after).toBe(before)
  })
})
