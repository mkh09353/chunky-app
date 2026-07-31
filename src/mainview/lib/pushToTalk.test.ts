import { describe, expect, test } from "bun:test"
import {
  codeToLabel,
  DEFAULT_PTT_CODE,
  DOUBLE_TAP_MS,
  getPttCode,
  initialPttState,
  isPttKey,
  isTransmitting,
  isTypingTarget,
  PTT_STORAGE_KEY,
  pttReducer,
  readStoredPttCode,
  resetPttCodeStore,
  setPttCode,
  subscribePttCode,
  TAP_MAX_MS,
  validatePttCode,
  writeStoredPttCode,
  type PttEvent,
  type PttState,
  type PttStorage,
} from "./pushToTalk"

/** In-memory stand-in for localStorage. */
function fakeStorage(initial: Record<string, string> = {}): PttStorage & { data: Record<string, string> } {
  const data = { ...initial }
  return {
    data,
    getItem: (key) => (key in data ? data[key]! : null),
    setItem: (key, value) => {
      data[key] = value
    },
    removeItem: (key) => {
      delete data[key]
    },
  }
}

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

  test("matches whichever key is configured", () => {
    expect(isPttKey({ code: "F8" }, "F8")).toBe(true)
    expect(isPttKey({ code: "Backquote" }, "F8")).toBe(false)
    expect(isPttKey({ code: "BracketLeft" }, "BracketLeft")).toBe(true)
  })

  test("still refuses modifiers and repeat on a configured key", () => {
    expect(isPttKey({ code: "F8", repeat: true }, "F8")).toBe(false)
    expect(isPttKey({ code: "F8", shiftKey: true }, "F8")).toBe(false)
  })

  test("defaults to backquote when no key is passed", () => {
    expect(DEFAULT_PTT_CODE).toBe("Backquote")
    expect(isPttKey({ code: DEFAULT_PTT_CODE })).toBe(true)
  })
})

describe("hotkey validation", () => {
  test("allows function, punctuation and navigation keys", () => {
    for (const code of ["F8", "F13", "Backquote", "BracketLeft", "BracketRight", "Backslash", "Slash", "ArrowUp", "Home", "NumpadAdd"]) {
      expect(validatePttCode(code).ok).toBe(true)
    }
  })

  test("refuses letters and digits so typing keeps working", () => {
    for (const code of ["KeyA", "KeyZ", "Digit0", "Digit9", "Numpad4"]) {
      const check = validatePttCode(code)
      expect(check.ok).toBe(false)
      if (!check.ok) expect(check.reason).toMatch(/typing/i)
    }
  })

  test("refuses keys the app itself needs", () => {
    for (const code of ["Escape", "Enter", "NumpadEnter", "Tab", "Space", "Backspace", "Delete"]) {
      const check = validatePttCode(code)
      expect(check.ok).toBe(false)
      if (!check.ok) expect(check.reason).toMatch(/reserved/i)
    }
  })

  test("refuses bare modifiers", () => {
    for (const code of ["ShiftLeft", "ControlRight", "AltLeft", "MetaLeft", "CapsLock"]) {
      const check = validatePttCode(code)
      expect(check.ok).toBe(false)
      if (!check.ok) expect(check.reason).toMatch(/modifier/i)
    }
  })

  test("refuses an empty capture", () => {
    expect(validatePttCode("").ok).toBe(false)
  })

  test("refuses values that are not key codes at all", () => {
    // A corrupt stored preference must not become an unpressable hotkey.
    for (const code of ["{}", "a b", "Key-A", "1F8", '"Backquote"']) {
      expect(validatePttCode(code).ok).toBe(false)
    }
  })
})

describe("codeToLabel", () => {
  test("renders punctuation as the character it types", () => {
    expect(codeToLabel("Backquote")).toBe("`")
    expect(codeToLabel("BracketLeft")).toBe("[")
    expect(codeToLabel("BracketRight")).toBe("]")
    expect(codeToLabel("Slash")).toBe("/")
    expect(codeToLabel("Minus")).toBe("-")
  })

  test("keeps function keys as they are", () => {
    expect(codeToLabel("F8")).toBe("F8")
    expect(codeToLabel("F13")).toBe("F13")
  })

  test("reads letters, digits and numpad keys", () => {
    expect(codeToLabel("KeyQ")).toBe("Q")
    expect(codeToLabel("Digit7")).toBe("7")
    expect(codeToLabel("Numpad5")).toBe("Numpad 5")
  })

  test("spells out navigation keys", () => {
    expect(codeToLabel("ArrowUp")).toBe("Up arrow")
    expect(codeToLabel("PageDown")).toBe("Page Down")
  })

  test("falls back to the raw code and tolerates empty input", () => {
    expect(codeToLabel("MediaTrackNext")).toBe("MediaTrackNext")
    expect(codeToLabel("")).toBe("")
  })
})

describe("hotkey persistence", () => {
  test("reads a stored key", () => {
    expect(readStoredPttCode(fakeStorage({ [PTT_STORAGE_KEY]: "F8" }))).toBe("F8")
  })

  test("falls back to the default when empty, corrupt or no longer allowed", () => {
    expect(readStoredPttCode(fakeStorage())).toBe(DEFAULT_PTT_CODE)
    expect(readStoredPttCode(fakeStorage({ [PTT_STORAGE_KEY]: "KeyA" }))).toBe(DEFAULT_PTT_CODE)
    expect(readStoredPttCode(fakeStorage({ [PTT_STORAGE_KEY]: "{}" }))).toBe(DEFAULT_PTT_CODE)
    expect(readStoredPttCode(null)).toBe(DEFAULT_PTT_CODE)
  })

  test("stores a custom key and clears the entry for the default", () => {
    const storage = fakeStorage()
    writeStoredPttCode("F8", storage)
    expect(storage.data[PTT_STORAGE_KEY]).toBe("F8")
    writeStoredPttCode(DEFAULT_PTT_CODE, storage)
    expect(PTT_STORAGE_KEY in storage.data).toBe(false)
  })

  test("a disabled storage never throws", () => {
    expect(() => writeStoredPttCode("F8", null)).not.toThrow()
  })
})

describe("hotkey store", () => {
  test("rejects an invalid key and keeps the current one", () => {
    resetPttCodeStore()
    const before = getPttCode()
    const check = setPttCode("KeyA")
    expect(check.ok).toBe(false)
    expect(getPttCode()).toBe(before)
    resetPttCodeStore()
  })

  test("notifies subscribers when the key changes", () => {
    resetPttCodeStore()
    let calls = 0
    const unsubscribe = subscribePttCode(() => {
      calls += 1
    })
    expect(setPttCode("F8").ok).toBe(true)
    expect(getPttCode()).toBe("F8")
    expect(calls).toBe(1)
    // Setting the same key again is not a change.
    setPttCode("F8")
    expect(calls).toBe(1)
    setPttCode(DEFAULT_PTT_CODE)
    expect(calls).toBe(2)
    unsubscribe()
    setPttCode("F9")
    expect(calls).toBe(2)
    resetPttCodeStore()
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
