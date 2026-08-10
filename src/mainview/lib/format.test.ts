// Path display shared by the header's Add repository search and the Zoo's
// area dialog — both show the same folder, so they must shorten it the same way.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { compactPath } from "./format"

// The shortening is deliberately browser-only (it must not touch node:os in the
// bundle), so this runner has to look like a browser for it to apply.
const hadWindow = "window" in globalThis

describe("compactPath", () => {
  beforeAll(() => {
    if (!hadWindow) (globalThis as { window?: unknown }).window = {}
  })
  afterAll(() => {
    if (!hadWindow) delete (globalThis as { window?: unknown }).window
  })

  it("shortens a home-relative path", () => {
    expect(compactPath("/Users/max/code/chunky-app")).toBe("~/code/chunky-app")
    expect(compactPath("/home/max/code/chunky-app")).toBe("~/code/chunky-app")
  })

  it("leaves paths outside home alone", () => {
    expect(compactPath("/opt/work/payments")).toBe("/opt/work/payments")
  })

  it("leaves the path untouched off the browser (no window to key off)", () => {
    if (hadWindow) return
    delete (globalThis as { window?: unknown }).window
    expect(compactPath("/Users/max/code/chunky-app")).toBe("/Users/max/code/chunky-app")
    ;(globalThis as { window?: unknown }).window = {}
  })
})
