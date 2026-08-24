// The stage keeps the native view exactly over the pane slot while living
// outside React. Run with: bun test src/mainview/lib/browserStage.test.ts
import { describe, expect, test } from "bun:test"
import { isPaneOwnedNode, rectsEqual, resolveStageRect, type PaneRect } from "./browserStage"

const slot: PaneRect = { x: 900, y: 52, width: 420, height: 800 }

describe("resolveStageRect", () => {
  test("adopts the slot's rect when the pane is visible", () => {
    expect(resolveStageRect({ slot, visible: true, previous: null })).toEqual(slot)
  })

  test("writes nothing when the rect has not meaningfully changed", () => {
    expect(resolveStageRect({ slot, visible: true, previous: slot })).toBeNull()
    expect(
      resolveStageRect({ slot: { ...slot, x: slot.x + 0.25 }, visible: true, previous: slot }),
    ).toBeNull()
  })

  test("writes a moved slot even when its size is unchanged", () => {
    const moved = { ...slot, x: slot.x - 120 }
    expect(resolveStageRect({ slot: moved, visible: true, previous: slot })).toEqual(moved)
  })

  test("freezes the geometry while the pane is closed", () => {
    // A closed pane is display:none (0x0). Resizing the native view would
    // reflow the guest page and lose its scroll position, so leave it alone —
    // the suppressor hides it instead.
    expect(resolveStageRect({ slot: { x: 0, y: 0, width: 0, height: 0 }, visible: false, previous: slot })).toBeNull()
    expect(resolveStageRect({ slot, visible: false, previous: slot })).toBeNull()
  })

  test("ignores a missing or degenerate slot", () => {
    expect(resolveStageRect({ slot: null, visible: true, previous: slot })).toBeNull()
    expect(
      resolveStageRect({ slot: { x: 10, y: 10, width: 0.5, height: 800 }, visible: true, previous: slot }),
    ).toBeNull()
  })
})

describe("rectsEqual", () => {
  test("tolerates sub-pixel jitter and compares nulls", () => {
    expect(rectsEqual(slot, { ...slot, height: slot.height + 0.4 })).toBe(true)
    expect(rectsEqual(slot, { ...slot, height: slot.height + 2 })).toBe(false)
    expect(rectsEqual(null, null)).toBe(true)
    expect(rectsEqual(slot, null)).toBe(false)
  })
})

describe("isPaneOwnedNode", () => {
  // Minimal stand-ins: the real callers pass DOM elements, and all this needs
  // is identity plus `contains`.
  const makeNode = (children: unknown[] = []) => {
    const node = {
      contains: (other: unknown) => children.includes(other),
    }
    return node as unknown as Element & { contains: (n: Node | null) => boolean }
  }

  test("the slot, the stage and their descendants are not overlays", () => {
    const child = makeNode()
    const host = makeNode([child])
    const webview = makeNode()
    const stage = makeNode([webview])

    expect(isPaneOwnedNode(host, host, stage)).toBe(true)
    expect(isPaneOwnedNode(child, host, stage)).toBe(true)
    expect(isPaneOwnedNode(stage, host, stage)).toBe(true)
    expect(isPaneOwnedNode(webview, host, stage)).toBe(true)
  })

  test("anything else is", () => {
    const host = makeNode()
    const stage = makeNode()
    expect(isPaneOwnedNode(makeNode(), host, stage)).toBe(false)
    expect(isPaneOwnedNode(null, host, stage)).toBe(false)
  })

  test("tolerates a stage that does not exist yet", () => {
    const host = makeNode()
    expect(isPaneOwnedNode(host, host, null)).toBe(true)
    expect(isPaneOwnedNode(makeNode(), host, null)).toBe(false)
  })
})
