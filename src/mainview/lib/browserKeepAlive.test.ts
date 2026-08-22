// The CEF webview must survive a pane close: closing the last CEF browser quits
// the app (Electrobun ≤ 2.0.1). Run with:
//   bun test src/mainview/lib/browserKeepAlive.test.ts
import { beforeEach, describe, expect, it } from "bun:test"
import {
  adoptWebview,
  keepsAlive,
  LIVE_WEBVIEW_CSS,
  parkWebview,
  peekParkedWebview,
  resetParkedWebview,
  takeParkedWebview,
  teardownWebview,
} from "./browserKeepAlive"

type FakeElement = ReturnType<typeof fakeElement>

/** Stands in for `<electrobun-webview>`; there is no DOM in this runner. */
function fakeElement(options: { toggleHidden?: boolean } = {}) {
  const element = {
    style: { cssText: LIVE_WEBVIEW_CSS, position: "absolute", width: "100%", height: "100%" },
    isConnected: true,
    webviewId: 7 as number | null,
    src: "https://kept.dev/page",
    removed: false,
    passthrough: false,
    hidden: false,
    synced: 0,
    loaded: [] as string[],
    remove() {
      element.removed = true
      element.isConnected = false
    },
    togglePassthrough(on: boolean) {
      element.passthrough = on
    },
    syncDimensions() {
      element.synced += 1
    },
    loadURL(url: string) {
      element.loaded.push(url)
      element.src = url
    },
    ...(options.toggleHidden === false
      ? {}
      : {
          toggleHidden(hidden: boolean) {
            element.hidden = hidden
          },
        }),
  }
  return element
}

function fakeParent() {
  const children: FakeElement[] = []
  return {
    children,
    appendChild(child: FakeElement) {
      children.push(child)
      child.isConnected = true
      return child
    },
  }
}

describe("browserKeepAlive", () => {
  beforeEach(() => {
    resetParkedWebview()
  })

  it("keeps only the CEF renderer alive", () => {
    expect(keepsAlive("cef")).toBe(true)
    expect(keepsAlive("native")).toBe(false)
  })

  it("parks a closed CEF webview off-screen instead of removing it", () => {
    const element = fakeElement()
    const lot = fakeParent()

    parkWebview(element, lot)

    expect(element.removed).toBe(false)
    expect(lot.children).toEqual([element])
    // 1x1 static: a 0x0 rect is ignored by the overlay sync.
    expect(element.style.position).toBe("static")
    expect(element.style.width).toBe("1px")
    expect(element.style.height).toBe("1px")
    // Nothing composites over the chat while it sits there.
    expect(element.hidden).toBe(true)
    expect(element.passthrough).toBe(true)
    expect(peekParkedWebview()).toBe(element)
  })

  it("survives a runtime without toggleHidden", () => {
    const element = fakeElement({ toggleHidden: false })
    const lot = fakeParent()
    expect(() => parkWebview(element, lot)).not.toThrow()
    expect(lot.children).toEqual([element])
  })

  it("adopts the same element on reopen and restores its live state", () => {
    const element = fakeElement()
    parkWebview(element, fakeParent())

    const claimed = takeParkedWebview<FakeElement>()
    expect(claimed).toBe(element)
    // Claiming empties the slot, so a second pane cannot adopt it twice.
    expect(takeParkedWebview()).toBeNull()

    const host = fakeParent()
    adoptWebview(claimed!, host, null)

    expect(host.children).toEqual([element])
    expect(element.style.cssText).toBe(LIVE_WEBVIEW_CSS)
    expect(element.passthrough).toBe(false)
    expect(element.hidden).toBe(false)
    expect(element.synced).toBe(1)
    // No pending request: the page it is still showing is left alone.
    expect(element.loaded).toEqual([])
  })

  it("navigates an adopted element to a URL requested while the pane was closed", () => {
    const element = fakeElement()
    parkWebview(element, fakeParent())
    const claimed = takeParkedWebview<FakeElement>()!

    adoptWebview(claimed, fakeParent(), "https://asked.dev/link")

    expect(element.loaded).toEqual(["https://asked.dev/link"])
  })

  it("parks a closing CEF pane but destroys a system WebView", () => {
    const cef = fakeElement()
    const lot = fakeParent()
    expect(teardownWebview("cef", cef, lot, (el) => el.remove())).toBe("parked")
    expect(cef.removed).toBe(false)
    expect(peekParkedWebview()).toBe(cef)

    const native = fakeElement()
    expect(teardownWebview("native", native, lot, (el) => el.remove())).toBe("destroyed")
    expect(native.removed).toBe(true)
    // A destroyed WKWebView never enters the keep-alive slot.
    expect(peekParkedWebview()).toBe(cef)
  })

  it("drops a parked element that lost its holder", () => {
    const element = fakeElement()
    parkWebview(element, fakeParent())
    element.isConnected = false
    expect(takeParkedWebview()).toBeNull()
  })

  it("hands the parked element to the second mount of a StrictMode pair", () => {
    // create → park (teardown) → adopt (second mount): one native view, never
    // two, and never a lost element.
    const element = fakeElement()
    const lot = fakeParent()
    parkWebview(element, lot)

    const second = takeParkedWebview<FakeElement>()
    const host = fakeParent()
    adoptWebview(second!, host, null)

    expect(second).toBe(element)
    expect(host.children).toEqual([element])
    expect(peekParkedWebview()).toBeNull()
    expect(element.removed).toBe(false)
  })
})
