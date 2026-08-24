// Find-in-page state for the browser pane.
//
// What the platform actually gives us (verified against Electrobun 1.18.1 /
// CEF 147, not assumed):
//
//  - `webviewTagFindInPage` → `-[CEFWebViewImpl findInPage:forward:matchCase:]`
//    → `CefBrowserHost::Find(...)`, and `webviewTagStopFind` →
//    `StopFinding(true)`. Searching and stepping through matches are REAL.
//  - There is NO match count. `CefClient::GetFindHandler` is not overridden by
//    `ElectrobunClient` (only the base vtable entry exists), so
//    `CefFindHandler::OnFindResult` — the callback carrying `count`,
//    `activeMatchOrdinal` and `finalUpdate` — is never delivered, and no
//    find-result event name exists anywhere in the native library. So the bar
//    ships without "3 of 12"; inventing one would be a lie.
//
// CEF's `Find` advances to the next match when it is called again with the same
// text, so "next"/"previous" are the same call with a direction — which is why
// this reducer emits a command per step rather than tracking a cursor.

export interface FindState {
  open: boolean
  query: string
}

export type FindEvent =
  /** ⌘F: open (or re-focus) the bar, keeping the previous query. */
  | { type: "open" }
  /** Escape / the close button. */
  | { type: "close" }
  | { type: "query"; value: string }
  | { type: "next" }
  | { type: "previous" }
  /** The pane navigated: highlights are gone and the bar is stale. */
  | { type: "navigated" }

export type FindCommand =
  | { kind: "find"; text: string; forward: boolean }
  /** Drop the highlights (CEF `StopFinding`). */
  | { kind: "stop" }

export interface FindTransition {
  state: FindState
  /** What to ask the webview to do, if anything. */
  command: FindCommand | null
  /** Should the bar's input take focus after this transition? */
  focusInput: boolean
}

export const INITIAL_FIND_STATE: FindState = { open: false, query: "" }

const stop = (state: FindState, focusInput = false): FindTransition => ({ state, command: { kind: "stop" }, focusInput })

/** The whole find-bar behaviour, as one pure step. */
export function findReducer(state: FindState, event: FindEvent): FindTransition {
  switch (event.type) {
    case "open": {
      const next = { ...state, open: true }
      // Re-opening with a query already in the box searches again immediately,
      // so ⌘F ⌘F does not leave a filled box with no highlights.
      if (state.query) return { state: next, command: { kind: "find", text: state.query, forward: true }, focusInput: true }
      return { state: next, command: null, focusInput: true }
    }
    case "close":
      // The query is kept so the next ⌘F starts where the user left off; the
      // highlights are not.
      return stop({ ...state, open: false })
    case "navigated":
      return state.open || state.query ? stop({ open: false, query: state.query }) : { state, command: null, focusInput: false }
    case "query": {
      const next = { ...state, query: event.value }
      // An emptied box means "no search", not "search for nothing".
      if (!event.value) return stop(next)
      return { state: next, command: { kind: "find", text: event.value, forward: true }, focusInput: false }
    }
    case "next":
    case "previous": {
      if (!state.query) return { state, command: null, focusInput: false }
      return {
        state,
        command: { kind: "find", text: state.query, forward: event.type === "next" },
        focusInput: false,
      }
    }
  }
}

export interface FindShortcutInput {
  key: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  defaultPrevented: boolean
  /** Is the pane on screen at all? */
  paneVisible: boolean
  /** Is the pane the surface the user is working in right now? */
  paneEngaged: boolean
  /** A dialog/palette/menu owns the keyboard. */
  overlayOpen: boolean
}

/**
 * Should ⌘F (Ctrl+F) open the pane's find bar?
 *
 * Deliberately narrow, following the app's Esc-to-stop convention: the app
 * binds no ⌘F of its own, so this claims it — but only for a visible pane the
 * user is actually in. Typing ⌘F in the composer, in a dialog, or anywhere else
 * must be left alone (macOS/WebKit may have their own use for it), and an event
 * something else already consumed is never re-claimed.
 */
export function shouldClaimFindShortcut(input: FindShortcutInput): boolean {
  if (input.defaultPrevented) return false
  if (!input.paneVisible || !input.paneEngaged || input.overlayOpen) return false
  if (input.altKey) return false
  if (!(input.metaKey || input.ctrlKey)) return false
  return input.key.toLowerCase() === "f"
}
