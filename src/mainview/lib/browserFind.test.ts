// Find-in-page state machine + shortcut arming.
// Run with: bun test src/mainview/lib/browserFind.test.ts
import { describe, expect, test } from "bun:test"
import { INITIAL_FIND_STATE, findReducer, shouldClaimFindShortcut, type FindState } from "./browserFind"

const open = (query = ""): FindState => ({ open: true, query })

describe("findReducer", () => {
  test("opening an empty bar just focuses it", () => {
    const result = findReducer(INITIAL_FIND_STATE, { type: "open" })
    expect(result.state).toEqual({ open: true, query: "" })
    expect(result.command).toBeNull()
    expect(result.focusInput).toBe(true)
  })

  test("re-opening with a remembered query searches again", () => {
    const result = findReducer({ open: false, query: "chunky" }, { type: "open" })
    expect(result.state.open).toBe(true)
    expect(result.command).toEqual({ kind: "find", text: "chunky", forward: true })
    expect(result.focusInput).toBe(true)
  })

  test("typing searches forward; emptying the box stops the search", () => {
    const typed = findReducer(open(), { type: "query", value: "abc" })
    expect(typed.state).toEqual({ open: true, query: "abc" })
    expect(typed.command).toEqual({ kind: "find", text: "abc", forward: true })

    const cleared = findReducer(typed.state, { type: "query", value: "" })
    expect(cleared.state.query).toBe("")
    expect(cleared.command).toEqual({ kind: "stop" })
  })

  test("next and previous re-issue the same search with a direction", () => {
    expect(findReducer(open("abc"), { type: "next" }).command).toEqual({
      kind: "find",
      text: "abc",
      forward: true,
    })
    expect(findReducer(open("abc"), { type: "previous" }).command).toEqual({
      kind: "find",
      text: "abc",
      forward: false,
    })
  })

  test("next with an empty query does nothing", () => {
    const result = findReducer(open(), { type: "next" })
    expect(result.command).toBeNull()
    expect(result.state).toEqual(open())
  })

  test("closing drops the highlights but remembers the query", () => {
    const result = findReducer(open("abc"), { type: "close" })
    expect(result.state).toEqual({ open: false, query: "abc" })
    expect(result.command).toEqual({ kind: "stop" })
  })

  test("navigation closes the bar and stops the search", () => {
    const result = findReducer(open("abc"), { type: "navigated" })
    expect(result.state.open).toBe(false)
    expect(result.command).toEqual({ kind: "stop" })
  })

  test("navigation with nothing to clear is a no-op", () => {
    const result = findReducer(INITIAL_FIND_STATE, { type: "navigated" })
    expect(result.command).toBeNull()
    expect(result.state).toBe(INITIAL_FIND_STATE)
  })
})

describe("shouldClaimFindShortcut", () => {
  const base = {
    key: "f",
    metaKey: true,
    ctrlKey: false,
    altKey: false,
    defaultPrevented: false,
    paneVisible: true,
    paneEngaged: true,
    overlayOpen: false,
  }

  test("claims ⌘F / Ctrl+F for an engaged, visible pane", () => {
    expect(shouldClaimFindShortcut(base)).toBe(true)
    expect(shouldClaimFindShortcut({ ...base, key: "F" })).toBe(true)
    expect(shouldClaimFindShortcut({ ...base, metaKey: false, ctrlKey: true })).toBe(true)
  })

  test("never fires for another surface (composer, dialog, hidden pane)", () => {
    expect(shouldClaimFindShortcut({ ...base, paneEngaged: false })).toBe(false)
    expect(shouldClaimFindShortcut({ ...base, paneVisible: false })).toBe(false)
    expect(shouldClaimFindShortcut({ ...base, overlayOpen: true })).toBe(false)
  })

  test("ignores plain f, ⌥⌘F and already-handled events", () => {
    expect(shouldClaimFindShortcut({ ...base, metaKey: false })).toBe(false)
    expect(shouldClaimFindShortcut({ ...base, altKey: true })).toBe(false)
    expect(shouldClaimFindShortcut({ ...base, defaultPrevented: true })).toBe(false)
    expect(shouldClaimFindShortcut({ ...base, key: "g" })).toBe(false)
  })
})
