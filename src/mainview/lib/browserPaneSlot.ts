// Who owns the side slot next to the chat — and what that means for the
// browser pane's lifetime.
//
// The browser pane cannot be unmounted once it is open. Its
// `<electrobun-webview>` sends `webviewTagRemove` from `disconnectedCallback`
// whenever a native view exists, and for CEF that closes the process's only CEF
// browser, which quits the app (Electrobun ≤ 2.0.1 calls `CefQuitMessageLoop`
// from `OnBeforeClose`). So the mount is STICKY: once true it stays true for the
// app's life, and closing the pane — or the files pane taking the slot — only
// makes it invisible.

export interface PaneSlotInputs {
  /** Was the browser pane already mounted? Sticky: never goes back to false. */
  mounted: boolean
  /** Has the user got the browser open? */
  browserOpen: boolean
  /** Is the repo files pane claiming the side slot? It wins the slot. */
  filesShowing: boolean
}

export interface PaneSlotState {
  /** Render BrowserPane at all. */
  mounted: boolean
  /** Show it: it takes layout space and its native view paints. */
  visible: boolean
}

/** Resolve the browser pane's mount/visibility for one render. */
export function resolvePaneSlot({ mounted, browserOpen, filesShowing }: PaneSlotInputs): PaneSlotState {
  return {
    mounted: mounted || browserOpen,
    // The files pane and the browser share one slot, so an open browser behind
    // the files pane is mounted-but-hidden, exactly like a closed one.
    visible: browserOpen && !filesShowing,
  }
}
