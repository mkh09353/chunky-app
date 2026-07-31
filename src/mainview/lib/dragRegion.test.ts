import { describe, expect, it } from "bun:test"
import { DRAG_REGION, NO_DRAG_REGION } from "./dragRegion"

// A faithful port of Electrobun's preload shim predicate
// (node_modules/electrobun/dist/api/bun/preload/dragRegions.ts). The shim is the
// only thing that moves the window in a WKWebView, and it reads *markup*, never
// computed styles — so these tests pin the exact contract our class names have
// to satisfy. If they fail, the window stopped being draggable.

interface FakeEl {
  classes: string[]
  style?: string
  parent?: FakeEl
}

function closest(el: FakeEl | undefined, pred: (el: FakeEl) => boolean): boolean {
  for (let node = el; node; node = node.parent) if (pred(node)) return true
  return false
}

const hasClass = (name: string) => (el: FakeEl) => el.classes.includes(name)
const inlineHas = (...needles: string[]) => (el: FakeEl) =>
  needles.every((n) => (el.style ?? "").includes(n))

/** True when a mousedown on `target` starts a native window move. */
function startsWindowMove(target: FakeEl): boolean {
  if (
    closest(target, hasClass("electrobun-webkit-app-region-no-drag")) ||
    closest(target, inlineHas("app-region", "no-drag"))
  ) {
    return false
  }
  return (
    closest(target, inlineHas("app-region", "drag")) ||
    closest(target, hasClass("electrobun-webkit-app-region-drag"))
  )
}

const el = (className: string, parent?: FakeEl): FakeEl => ({
  classes: className.split(" ").filter(Boolean),
  parent,
})

describe("drag region class names", () => {
  it("makes a bar marked with DRAG_REGION draggable", () => {
    const bar = el(`${DRAG_REGION} flex h-[52px]`)
    expect(startsWindowMove(bar)).toBe(true)
    // …including its inert children (spacers, brand text, icons).
    expect(startsWindowMove(el("h-full min-w-12 flex-1", bar))).toBe(true)
  })

  it("lets interactive children opt out with NO_DRAG_REGION", () => {
    const bar = el(DRAG_REGION)
    const tabs = el(`${NO_DRAG_REGION} flex`, bar)
    expect(startsWindowMove(tabs)).toBe(false)
    // Deep descendants of a no-drag island stay clickable too.
    expect(startsWindowMove(el("truncate", el("h-7", tabs)))).toBe(false)
  })

  it("is not satisfied by the stylesheet-only class names alone", () => {
    // The regression this guards: `.app-drag { -webkit-app-region: drag }` is
    // invisible to the shim (and to WKWebView), so a bar marked only `app-drag`
    // is not draggable — which is exactly how window dragging was lost.
    expect(startsWindowMove(el("app-drag"))).toBe(false)
    expect(DRAG_REGION.split(" ")).toContain("electrobun-webkit-app-region-drag")
    expect(NO_DRAG_REGION.split(" ")).toContain("electrobun-webkit-app-region-no-drag")
  })
})
