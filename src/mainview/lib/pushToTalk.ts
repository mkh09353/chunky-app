// Push-to-talk input model for the voice agent.
//
// Kept free of React and the DOM event objects themselves so the whole
// interaction — hold, release, double-tap to open mic, tap back to PTT — is
// unit-testable without a browser. The hook feeds it timestamps; it decides
// whether the microphone should be transmitting.

/** Hardcoded for now: the backquote key, matched by `code` (layout-independent). */
export const PTT_CODE = "Backquote"

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
 * True for a usable push-to-talk press: the right key, not an auto-repeat, and
 * unmodified so Ctrl+` (terminal drawer) and friends still work.
 */
export function isPttKey(event: PttKeyLike): boolean {
  if (event.code !== PTT_CODE) return false
  if (event.repeat === true) return false
  return !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey
}
