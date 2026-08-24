// Park-vs-remove: the one decision that decides whether tearing the browser
// pane down quits the app.
//
// Removing (or reparenting) an `<electrobun-webview>` whose native view exists
// runs `disconnectedCallback` → `webviewTagRemove` → `BrowserView.remove()` →
// `-[CEFWebViewImpl remove]` → `CloseBrowser(false)`. For a `SetAsChild` CEF
// browser that ends in `performClose:` on the app's main window, which is a
// silent `forceExit(0)` (see `browserGuest.ts` for the full chain).
//
// So: an element whose native view exists — or whose creation is in flight and
// may still produce one — must never be removed. It is parked instead: left in
// place in the body-level stage (see `browserStage.ts`, which is what keeps the
// element out of React's reach entirely) with the native view hidden and
// passthrough. `element.remove()` is only safe when no native view was ever
// started, where `disconnectedCallback` is a no-op.

export interface WebviewTeardownInput {
  /** Set once the native view exists. */
  webviewId: number | null
  /** Did `initWebview()` actually start (the rAF callback ran)? */
  initStarted: boolean
}

export type WebviewTeardown = "remove" | "park"

/** Decide how to tear a webview element down. */
export function resolveWebviewTeardown({ webviewId, initStarted }: WebviewTeardownInput): WebviewTeardown {
  if (webviewId != null) return "park"
  return initStarted ? "park" : "remove"
}

/**
 * Should a torn-down element be kept for a later mount?
 *
 * The pane can remount without the app restarting (StrictMode's double invoke,
 * or the root error boundary resetting), and creating a second native view for
 * the same pane would double the browser processes and leave the first one
 * composited forever. A parked element is therefore reused; only a removed one
 * is forgotten.
 */
export function shouldRetainForReuse(decision: WebviewTeardown): boolean {
  return decision === "park"
}
