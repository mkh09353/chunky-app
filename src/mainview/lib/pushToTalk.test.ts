import { describe, expect, test } from "bun:test"
import {
  DOUBLE_TAP_MS,
  initialPttState,
  isPttKey,
  isTransmitting,
  isTypingTarget,
  pttReducer,
  TAP_MAX_MS,
  type PttEvent,
  type PttState,
} from "./pushToTalk"

/** Fold a sequence of events for readable scenario tests. */
function run(events: PttEvent[], from: PttState = initialPttState): PttState {
  return events.reduce(pttReducer, from)
}

describe("push-to-talk holding", () => {
  test("rests muted", () => {
    expect(isTransmitting(initialPttState)).toBe(false)
    expect(initialPttState.mode).toBe("ptt")
  })

  test("transmits only while the key is held", () => {
    const down = run([{ type: "keydown", at: 1000 }])
    expect(isTransmitting(down)).toBe(true)
    const up = pttReducer(down, { type: "keyup", at: 1000 + TAP_MAX_MS + 500 })
    expect(isTransmitting(up)).toBe(false)
  })

  test("transmits while the HUD pad is held", () => {
    const down = run([{ type: "pointerdown" }])
    expect(isTransmitting(down)).toBe(true)
    expect(isTransmitting(pttReducer(down, { type: "pointerup" }))).toBe(false)
  })

  test("a hold does not arm a double-tap", () => {
    const held = run([
      { type: "keydown", at: 0 },
      { type: "keyup", at: TAP_MAX_MS + 1 },
    ])
    expect(held.lastTapAt).toBeNull()
    // The next press is a plain hold, not an open-mic toggle.
    const next = pttReducer(held, { type: "keydown", at: TAP_MAX_MS + 50 })
    expect(next.mode).toBe("ptt")
    expect(isTransmitting(next)).toBe(true)
  })

  test("blur releases a held key so the mic cannot stick open", () => {
    const stuck = run([{ type: "keydown", at: 0 }])
    expect(isTransmitting(pttReducer(stuck, { type: "release" }))).toBe(false)
  })
})

describe("double-tap toggles open mic", () => {
  test("two quick taps switch to open mic and stay transmitting", () => {
    const state = run([
      { type: "keydown", at: 0 },
      { type: "keyup", at: 40 },
      { type: "keydown", at: 40 + DOUBLE_TAP_MS - 10 },
    ])
    expect(state.mode).toBe("open")
    expect(state.holding).toBe(false)
    expect(isTransmitting(state)).toBe(true)
  })

  test("taps spaced beyond the window do not toggle", () => {
    const state = run([
      { type: "keydown", at: 0 },
      { type: "keyup", at: 40 },
      { type: "keydown", at: 40 + DOUBLE_TAP_MS + 10 },
    ])
    expect(state.mode).toBe("ptt")
    // It is just another hold.
    expect(state.holding).toBe(true)
  })

  test("releasing the second tap does not immediately exit open mic", () => {
    const state = run([
      { type: "keydown", at: 0 },
      { type: "keyup", at: 40 },
      { type: "keydown", at: 200 },
      // The release of the toggling press must not read as an exit tap.
      { type: "keyup", at: 240 },
    ])
    expect(state.mode).toBe("open")
    expect(isTransmitting(state)).toBe(true)
  })

  test("a later single tap in open mic returns to push-to-talk, muted", () => {
    const open = run([
      { type: "keydown", at: 0 },
      { type: "keyup", at: 40 },
      { type: "keydown", at: 200 },
      { type: "keyup", at: 240 },
    ])
    expect(open.mode).toBe("open")
    const back = run(
      [
        { type: "keydown", at: 2000 },
        { type: "keyup", at: 2030 },
      ],
      open,
    )
    expect(back.mode).toBe("ptt")
    expect(isTransmitting(back)).toBe(false)
  })

  test("holding the key in open mic does not exit", () => {
    const open = run([{ type: "setMode", mode: "open" }])
    const after = run(
      [
        { type: "keydown", at: 0 },
        { type: "keyup", at: TAP_MAX_MS + 100 },
      ],
      open,
    )
    expect(after.mode).toBe("open")
    expect(isTransmitting(after)).toBe(true)
  })

  test("three taps land back in push-to-talk", () => {
    const state = run([
      { type: "keydown", at: 0 },
      { type: "keyup", at: 30 },
      { type: "keydown", at: 200 },
      { type: "keyup", at: 230 },
      { type: "keydown", at: 400 },
      { type: "keyup", at: 430 },
    ])
    expect(state.mode).toBe("ptt")
    expect(isTransmitting(state)).toBe(false)
  })

  test("toggleMode flips both ways and clears held state", () => {
    const open = pttReducer({ ...initialPttState, holding: true }, { type: "toggleMode" })
    expect(open.mode).toBe("open")
    expect(open.holding).toBe(false)
    expect(pttReducer(open, { type: "toggleMode" }).mode).toBe("ptt")
  })

  test("reset returns to muted push-to-talk for the next session", () => {
    const open = run([{ type: "setMode", mode: "open" }])
    expect(pttReducer(open, { type: "reset" })).toEqual(initialPttState)
  })
})

describe("key guards", () => {
  test("accepts an unmodified backquote press", () => {
    expect(isPttKey({ code: "Backquote" })).toBe(true)
  })

  test("ignores auto-repeat", () => {
    expect(isPttKey({ code: "Backquote", repeat: true })).toBe(false)
  })

  test("ignores other keys and modified presses", () => {
    expect(isPttKey({ code: "KeyB" })).toBe(false)
    // Ctrl+` already toggles the terminal drawer.
    expect(isPttKey({ code: "Backquote", ctrlKey: true })).toBe(false)
    expect(isPttKey({ code: "Backquote", metaKey: true })).toBe(false)
    expect(isPttKey({ code: "Backquote", altKey: true })).toBe(false)
    expect(isPttKey({ code: "Backquote", shiftKey: true })).toBe(false)
  })
})

describe("typing guard", () => {
  test("text entry keeps the backquote", () => {
    expect(isTypingTarget({ tagName: "INPUT" })).toBe(true)
    expect(isTypingTarget({ tagName: "textarea" })).toBe(true)
    expect(isTypingTarget({ tagName: "SELECT" })).toBe(true)
    expect(isTypingTarget({ tagName: "DIV", isContentEditable: true })).toBe(true)
  })

  test("a descendant of a contenteditable is still typing", () => {
    expect(isTypingTarget({ tagName: "SPAN", closest: (s: string) => (s.includes("contenteditable") ? {} : null) })).toBe(true)
  })

  test("ordinary elements and nullish targets are not typing", () => {
    expect(isTypingTarget({ tagName: "DIV", closest: () => null })).toBe(false)
    expect(isTypingTarget({ tagName: "BUTTON" })).toBe(false)
    expect(isTypingTarget(null)).toBe(false)
    expect(isTypingTarget(undefined)).toBe(false)
  })
})
