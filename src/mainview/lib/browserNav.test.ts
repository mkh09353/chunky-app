// Hand-off rules between the link menu, App (mounts the pane) and BrowserPane
// (navigates). Run with:
//   bun test src/mainview/lib/browserNav.test.ts
import { describe, expect, it } from "bun:test"
import { openInAppBrowser, subscribeBrowserNavigation, takePendingBrowserUrl } from "./browserNav"

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
