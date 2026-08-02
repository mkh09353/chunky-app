// How much of a settled section is shown before "Show more". Run with:
//   bun test src/mainview/lib/sessionList.test.ts
import { describe, expect, test } from "bun:test"
import { SETTLED_PREVIEW, collapseList } from "./sessionList"

const rows = (n: number) => Array.from({ length: n }, (_, i) => `s${i}`)

describe("collapseList", () => {
  test("a short list is shown whole, with nothing hidden", () => {
    expect(collapseList(rows(3), false)).toEqual({ visible: rows(3), hidden: 0 })
    expect(collapseList([], false)).toEqual({ visible: [], hidden: 0 })
  })

  test("exactly the limit stays whole", () => {
    const list = rows(SETTLED_PREVIEW)
    expect(collapseList(list, false)).toEqual({ visible: list, hidden: 0 })
  })

  test("one row over the limit is not worth a button", () => {
    const list = rows(SETTLED_PREVIEW + 1)
    expect(collapseList(list, false)).toEqual({ visible: list, hidden: 0 })
  })

  test("a long list keeps the first N and counts the rest", () => {
    const list = rows(20)
    const { visible, hidden } = collapseList(list, false)
    expect(visible).toHaveLength(SETTLED_PREVIEW)
    expect(hidden).toBe(20 - SETTLED_PREVIEW)
    // Order is the server's, untouched.
    expect(visible[0]).toBe("s0")
    expect(visible.at(-1)).toBe(`s${SETTLED_PREVIEW - 1}`)
  })

  test("expanding shows everything again", () => {
    const list = rows(20)
    expect(collapseList(list, true)).toEqual({ visible: list, hidden: 0 })
  })

  test("the limit is configurable, and a nonsense limit disables collapsing", () => {
    expect(collapseList(rows(10), false, 2)).toEqual({ visible: ["s0", "s1"], hidden: 8 })
    expect(collapseList(rows(10), false, 0)).toEqual({ visible: rows(10), hidden: 0 })
  })
})
