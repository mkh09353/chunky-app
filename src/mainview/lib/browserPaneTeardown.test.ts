// Removing an initialized <electrobun-webview> quits the app (CEF SetAsChild
// browser close → performClose: on the main window → exitOnLastWindowClosed).
// Run with: bun test src/mainview/lib/browserPaneTeardown.test.ts
import { describe, expect, test } from "bun:test"
import { resolveWebviewTeardown, shouldRetainForReuse } from "./browserPaneTeardown"

describe("resolveWebviewTeardown", () => {
  test("removes only when no native view was ever started", () => {
    expect(resolveWebviewTeardown({ webviewId: null, initStarted: false })).toBe("remove")
  })

  test("parks an element whose native view exists", () => {
    expect(resolveWebviewTeardown({ webviewId: 7, initStarted: true })).toBe("park")
    // Defensive: an id without a recorded start is still a live native view.
    expect(resolveWebviewTeardown({ webviewId: 7, initStarted: false })).toBe("park")
    // Id 0 is a valid webview id and must not be treated as "no view".
    expect(resolveWebviewTeardown({ webviewId: 0, initStarted: true })).toBe("park")
  })

  test("parks an in-flight init that may still produce a native view", () => {
    expect(resolveWebviewTeardown({ webviewId: null, initStarted: true })).toBe("park")
  })

  test("never returns remove once init has started or an id exists", () => {
    for (const webviewId of [null, 0, 3]) {
      for (const initStarted of [false, true]) {
        const decision = resolveWebviewTeardown({ webviewId, initStarted })
        if (webviewId != null || initStarted) expect(decision).toBe("park")
      }
    }
  })
})

describe("shouldRetainForReuse", () => {
  test("a parked element is reused by the next mount; a removed one is not", () => {
    expect(shouldRetainForReuse("park")).toBe(true)
    expect(shouldRetainForReuse("remove")).toBe(false)
  })

  test("an initialized element is always retained", () => {
    expect(shouldRetainForReuse(resolveWebviewTeardown({ webviewId: 4, initStarted: true }))).toBe(true)
    expect(shouldRetainForReuse(resolveWebviewTeardown({ webviewId: null, initStarted: true }))).toBe(true)
    expect(shouldRetainForReuse(resolveWebviewTeardown({ webviewId: null, initStarted: false }))).toBe(false)
  })
})
