// Push-to-talk input model for the voice agent.
//
// Kept free of React and the DOM event objects themselves so the whole
// interaction — hold, release, double-tap to open mic, tap back to PTT — is
// unit-testable without a browser. The hook feeds it timestamps; it decides
// whether the microphone should be transmitting.

/** The out-of-the-box hotkey, matched by `code` so it is layout-independent. */
export const DEFAULT_PTT_CODE = "Backquote"

/** Renderer-local preference; voice hotkeys are per-machine, not server state. */
export const PTT_STORAGE_KEY = "chunky.voice.pttKey"

/** Two taps closer together than this toggle open-mic mode. */
export const DOUBLE_TAP_MS = 350

/** A press shorter than this is a tap; anything longer is a hold. */
export const TAP_MAX_MS = 250

export type PttMode = "ptt" | "open"

export interface PttState {
  mode: PttMode
  /** The key or the HUD pad is being held down right now. */
  holding: boolean
  /** When the current key press started, for tap-vs-hold. */
  pressAt: number | null
  /** When the last completed tap ended, for double-tap detection. */
  lastTapAt: number | null
}

export const initialPttState: PttState = { mode: "ptt", holding: false, pressAt: null, lastTapAt: null }

export type PttEvent =
  | { type: "keydown"; at: number }
  | { type: "keyup"; at: number }
  | { type: "pointerdown" }
  | { type: "pointerup" }
  /** Window blur / tab hidden: never leave the mic stuck open. */
  | { type: "release" }
  | { type: "setMode"; mode: PttMode }
  | { type: "toggleMode" }
  | { type: "reset" }

/**
 * The microphone transmits while open-mic is on, or while the key/pad is held
 * in push-to-talk. Everything else is muted, which is also the resting state.
 */
export function isTransmitting(state: PttState): boolean {
  return state.mode === "open" || state.holding
}

export function pttReducer(state: PttState, event: PttEvent): PttState {
  switch (event.type) {
    case "keydown": {
      // Open mic ignores the press itself; the release decides (a tap exits).
      if (state.mode === "open") return { ...state, pressAt: event.at }
      // Second tap of a double-tap: switch to open mic instead of transmitting.
      if (state.lastTapAt !== null && event.at - state.lastTapAt <= DOUBLE_TAP_MS) {
        return { mode: "open", holding: false, pressAt: null, lastTapAt: null }
      }
      return { ...state, holding: true, pressAt: event.at }
    }
    case "keyup": {
      const pressAt = state.pressAt
      const wasTap = pressAt !== null && event.at - pressAt <= TAP_MAX_MS
      if (state.mode === "open") {
        // A tap while open drops back to push-to-talk (muted until held).
        return wasTap
          ? { mode: "ptt", holding: false, pressAt: null, lastTapAt: null }
          : { ...state, pressAt: null }
      }
      return { ...state, holding: false, pressAt: null, lastTapAt: wasTap ? event.at : null }
    }
    case "pointerdown":
      // The HUD pad is a plain hold; it never toggles open mic.
      return state.mode === "open" ? state : { ...state, holding: true }
    case "pointerup":
      return state.holding ? { ...state, holding: false, pressAt: null } : state
    case "release":
      return state.holding ? { ...state, holding: false, pressAt: null, lastTapAt: null } : state
    case "setMode":
      return event.mode === state.mode ? state : { ...initialPttState, mode: event.mode }
    case "toggleMode":
      return { ...initialPttState, mode: state.mode === "open" ? "ptt" : "open" }
    case "reset":
      return initialPttState
    default:
      return state
  }
}

/** Element-ish shape, so tests do not need real DOM nodes. */
export interface TypingTargetLike {
  tagName?: string
  isContentEditable?: boolean
  closest?: (selector: string) => unknown
}

/**
 * True when the key belongs to whatever the user is typing into. Backquote is
 * an ordinary character, so the composer, settings inputs and any rich-text
 * surface must keep it.
 */
export function isTypingTarget(target: unknown): boolean {
  if (!target || typeof target !== "object") return false
  const el = target as TypingTargetLike
  const tag = typeof el.tagName === "string" ? el.tagName.toUpperCase() : ""
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true
  if (el.isContentEditable === true) return true
  // Base UI renders comboboxes/menus with editable descendants.
  if (typeof el.closest === "function" && el.closest('[contenteditable="true"]')) return true
  return false
}

/** The subset of a KeyboardEvent this module needs. */
export interface PttKeyLike {
  code: string
  repeat?: boolean
  metaKey?: boolean
  ctrlKey?: boolean
  altKey?: boolean
  shiftKey?: boolean
}

/**
 * True for a usable push-to-talk press: the configured key, not an auto-repeat,
 * and unmodified so Ctrl+` (terminal drawer) and friends still work.
 */
export function isPttKey(event: PttKeyLike, code: string = DEFAULT_PTT_CODE): boolean {
  if (event.code !== code) return false
  if (event.repeat === true) return false
  return !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey
}

// ---- Hotkey choice: validation, display, persistence ----------------------

/** Keys that carry no press of their own. */
function isModifierCode(code: string): boolean {
  return /^(Shift|Control|Alt|Meta)(Left|Right)$|^CapsLock$|^Fn$/.test(code)
}

/**
 * Keys reserved because binding them would break the app: the ones every
 * dialog and list depends on, plus the plain characters people type.
 */
const RESERVED_CODES = new Set(["Escape", "Enter", "NumpadEnter", "Tab", "Space", "Backspace", "Delete"])

export type PttCodeCheck = { ok: true } | { ok: false; reason: string }

/**
 * Whether a captured key may become the hotkey. The hook fires on unmodified
 * presses, so anything used for plain typing has to stay off the list.
 */
export function validatePttCode(code: string): PttCodeCheck {
  if (!code) return { ok: false, reason: "No key was captured. Try again." }
  // KeyboardEvent.code is always an alphanumeric identifier. Anything else is a
  // corrupt stored value, which would otherwise become an unpressable hotkey.
  if (!/^[A-Za-z][A-Za-z0-9]*$/.test(code)) {
    return { ok: false, reason: "That is not a usable key. Try again." }
  }
  if (isModifierCode(code)) {
    return { ok: false, reason: "Modifier keys cannot be used on their own. Press a normal key." }
  }
  if (RESERVED_CODES.has(code)) {
    return { ok: false, reason: `${codeToLabel(code)} is reserved by the app. Pick another key.` }
  }
  if (/^Key[A-Z]$/.test(code) || /^Digit[0-9]$/.test(code) || /^Numpad[0-9]$/.test(code)) {
    return { ok: false, reason: "Letters and digits are needed for typing. Try a function key or a punctuation key." }
  }
  return { ok: true }
}

const CODE_LABELS: Record<string, string> = {
  Backquote: "`",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Minus: "-",
  Equal: "=",
  ArrowUp: "Up arrow",
  ArrowDown: "Down arrow",
  ArrowLeft: "Left arrow",
  ArrowRight: "Right arrow",
  PageUp: "Page Up",
  PageDown: "Page Down",
  CapsLock: "Caps Lock",
  ScrollLock: "Scroll Lock",
  NumpadEnter: "Numpad Enter",
  NumpadAdd: "Numpad +",
  NumpadSubtract: "Numpad -",
  NumpadMultiply: "Numpad *",
  NumpadDivide: "Numpad /",
  NumpadDecimal: "Numpad .",
  IntlBackslash: "\\",
  Space: "Space",
  Escape: "Escape",
  Enter: "Enter",
  Tab: "Tab",
}

/** A short human label for a KeyboardEvent.code, falling back to the raw code. */
export function codeToLabel(code: string): string {
  if (!code) return ""
  const known = CODE_LABELS[code]
  if (known) return known
  if (/^F\d{1,2}$/.test(code)) return code
  const letter = /^Key([A-Z])$/.exec(code)
  if (letter) return letter[1]!
  const digit = /^Digit([0-9])$/.exec(code)
  if (digit) return digit[1]!
  const numpad = /^Numpad([0-9])$/.exec(code)
  if (numpad) return `Numpad ${numpad[1]}`
  return code
}

/** Storage shim so the store is testable without a DOM. */
export interface PttStorage {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
  removeItem: (key: string) => void
}

function defaultStorage(): PttStorage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage
  } catch {
    return null
  }
}

/** Stored value, ignoring anything corrupt or no longer allowed. */
export function readStoredPttCode(storage: PttStorage | null = defaultStorage()): string {
  try {
    const raw = storage?.getItem(PTT_STORAGE_KEY)
    if (raw && validatePttCode(raw).ok) return raw
  } catch {
    /* storage disabled */
  }
  return DEFAULT_PTT_CODE
}

export function writeStoredPttCode(code: string, storage: PttStorage | null = defaultStorage()): void {
  try {
    if (code === DEFAULT_PTT_CODE) storage?.removeItem(PTT_STORAGE_KEY)
    else storage?.setItem(PTT_STORAGE_KEY, code)
  } catch {
    /* storage disabled */
  }
}

// A module-level store keeps the Settings field and the live hotkey in sync
// without threading the value through the whole component tree.
let currentCode: string | null = null
const listeners = new Set<() => void>()

export function getPttCode(): string {
  if (currentCode === null) currentCode = readStoredPttCode()
  return currentCode
}

/** Set the hotkey. Invalid codes are refused and reported to the caller. */
export function setPttCode(code: string): PttCodeCheck {
  const check = validatePttCode(code)
  if (!check.ok) return check
  if (code !== getPttCode()) {
    currentCode = code
    writeStoredPttCode(code)
    for (const listener of Array.from(listeners)) listener()
  }
  return { ok: true }
}

export function resetPttCode(): void {
  setPttCode(DEFAULT_PTT_CODE)
}

export function subscribePttCode(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Test-only: drop the cached value and stored preference. */
export function resetPttCodeStore(storage: PttStorage | null = defaultStorage()): void {
  currentCode = null
  try {
    storage?.removeItem(PTT_STORAGE_KEY)
  } catch {
    /* ignore */
  }
}
