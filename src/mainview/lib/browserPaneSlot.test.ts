// The browser pane's mount is one-way: unmounting it would disconnect its
// native webview, and closing the last CEF browser quits the app. Run with:
//   bun test src/mainview/lib/browserPaneSlot.test.ts
import { describe, expect, test } from "bun:test"
import { resolvePaneSlot } from "./browserPaneSlot"

describe("resolvePaneSlot", () => {
  test("stays unmounted until the browser is first opened", () => {
    expect(resolvePaneSlot({ mounted: false, browserOpen: false, filesShowing: false })).toEqual({
      mounted: false,
      visible: false,
    })
    expect(resolvePaneSlot({ mounted: false, browserOpen: true, filesShowing: false })).toEqual({
      mounted: true,
      visible: true,
    })
  })

  test("closing the pane hides it but never unmounts it", () => {
    expect(resolvePaneSlot({ mounted: true, browserOpen: false, filesShowing: false })).toEqual({
      mounted: true,
      visible: false,
    })
  })

  test("the files pane takes the slot without unmounting the browser", () => {
    expect(resolvePaneSlot({ mounted: true, browserOpen: true, filesShowing: true })).toEqual({
      mounted: true,
      visible: false,
    })
    // ...and giving the slot back shows it again.
    expect(resolvePaneSlot({ mounted: true, browserOpen: true, filesShowing: false })).toEqual({
      mounted: true,
      visible: true,
    })
  })

  test("a first open behind the files pane still mounts, hidden", () => {
    expect(resolvePaneSlot({ mounted: false, browserOpen: true, filesShowing: true })).toEqual({
      mounted: true,
      visible: false,
    })
  })

  test("mount is sticky across every combination", () => {
    for (const browserOpen of [false, true]) {
      for (const filesShowing of [false, true]) {
        expect(resolvePaneSlot({ mounted: true, browserOpen, filesShowing }).mounted).toBe(true)
      }
    }
  })
})
