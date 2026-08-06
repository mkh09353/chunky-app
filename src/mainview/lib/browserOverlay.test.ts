import { describe, expect, test } from "bun:test"
import { clampDragOffset, rectsIntersect } from "./browserOverlay"

describe("browser overlay geometry", () => {
  test("detects overlap without relying on z-index", () => {
    expect(rectsIntersect(
      { left: 100, top: 0, right: 300, bottom: 300, width: 200, height: 300 },
      { left: 250, top: 100, right: 450, bottom: 200, width: 200, height: 100 },
    )).toBe(true)
    expect(rectsIntersect(
      { left: 100, top: 0, right: 300, bottom: 300, width: 200, height: 300 },
      { left: 300, top: 0, right: 450, bottom: 100, width: 150, height: 100 },
    )).toBe(false)
  })

  test("clamps add-repository dragging to the viewport", () => {
    const rect = { left: 700, top: 20, width: 300, height: 400 }
    expect(clampDragOffset(rect, { x: 500, y: -100 }, { width: 1024, height: 600 })).toEqual({ x: 16, y: -12 })
    expect(clampDragOffset(rect, { x: -900, y: 900 }, { width: 1024, height: 600 })).toEqual({ x: -692, y: 172 })
  })
})
