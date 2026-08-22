/**
 * Keep-alive slot for the browser pane's CEF webview.
 *
 * Why this exists: Electrobun's CEF handler calls `CefQuitMessageLoop()` from
 * `OnBeforeClose` once its `browser_list_` is empty, and in a CEF-bundled build
 * that message loop IS the app's main event loop (confirmed in the Electrobun
 * 1.18.1 native source, still unfixed in 2.0.1). Our main window runs on the
 * system WebView, so the pane's `<electrobun-webview renderer="cef">` is the
 * ONLY CEF browser in the process — closing the pane would close the last CEF
 * browser and quit the whole app.
 *
 * So a CEF webview is never destroyed: closing the pane PARKS the live element
 * off-screen (still connected, so no native close), and reopening ADOPTS the
 * parked element instead of creating a new one. The system-WebView renderer
 * keeps the ordinary destroy path — a WKWebView close is harmless, and leaving
 * one lingering off-screen would not be.
 *
 * The helpers here are deliberately structural (no `document`, no DOM types) so
 * they can be exercised with a fake element under `bun test`.
 */

/** The inline style the pane sizes its live webview with; the element's rect is
 *  exactly where the native view is composited. */
export const LIVE_WEBVIEW_CSS =
  "display:block;position:absolute;inset:0;width:100%;height:100%;background:transparent;"

/** The bits of `<electrobun-webview>` park/adopt actually touch. */
export type KeepAliveWebview = {
  style: { cssText: string; position: string; width: string; height: string }
  isConnected: boolean
  webviewId?: number | null
  src?: string | null
  togglePassthrough: (on: boolean) => void
  toggleHidden?: (hidden: boolean) => void
  syncDimensions: (force: boolean) => void
  loadURL: (url: string) => void
}

/** Only the CEF renderer must survive a pane close; see the note above. */
export function keepsAlive(rendererKind: "cef" | "native"): boolean {
  return rendererKind === "cef"
}

// One process, one CEF webview — so one slot.
let parked: KeepAliveWebview | null = null

/** The element parked by the last CEF pane close, if any (does not claim it). */
export function peekParkedWebview(): KeepAliveWebview | null {
  return parked
}

/**
 * Park `element` in the off-screen holder and remember it for the next open.
 *
 * 1x1 rather than 0x0: the overlay sync ignores an empty rect, so a zero-sized
 * element would keep the native view wherever it last was. `position: static`
 * drops the pane's absolute placement, and `toggleHidden` (when the runtime has
 * it) takes the native view out of the compositor entirely, so nothing paints
 * over the chat.
 */
export function parkWebview<E extends KeepAliveWebview>(
  element: E,
  parkingLot: { appendChild: (el: E) => unknown },
): void {
  element.style.position = "static"
  element.style.width = "1px"
  element.style.height = "1px"
  element.togglePassthrough(true)
  element.toggleHidden?.(true)
  parkingLot.appendChild(element)
  parked = element
}

/**
 * Claim the parked element for a pane that is opening, or null when there is
 * none to adopt. A disconnected element (the holder was torn out from under it)
 * is dropped rather than reused.
 */
export function takeParkedWebview<E extends KeepAliveWebview>(): E | null {
  const element = parked as E | null
  parked = null
  if (!element) return null
  return element.isConnected ? element : null
}

/**
 * Re-attach a parked element to a freshly opened pane: full-size styles back,
 * hit testing and visibility restored, geometry pushed to the native side.
 *
 * `pendingUrl` is a link the user asked for while the pane was closed. Without
 * one the adopted page is left exactly as it was — that is the whole point of
 * keeping it alive — so it is never reloaded.
 */
export function adoptWebview<E extends KeepAliveWebview>(
  element: E,
  host: { appendChild: (el: E) => unknown },
  pendingUrl?: string | null,
): void {
  element.style.cssText = LIVE_WEBVIEW_CSS
  host.appendChild(element)
  element.togglePassthrough(false)
  element.toggleHidden?.(false)
  element.syncDimensions(true)
  if (pendingUrl) element.loadURL(pendingUrl)
}

/**
 * The one decision a closing pane makes: park a CEF webview (the process's last
 * CEF browser — closing it quits the app) or hand a system WebView to the
 * caller's ordinary destroy path.
 */
export function teardownWebview<E extends KeepAliveWebview>(
  rendererKind: "cef" | "native",
  element: E,
  parkingLot: { appendChild: (el: E) => unknown },
  destroy: (el: E) => void,
): "parked" | "destroyed" {
  if (!keepsAlive(rendererKind)) {
    destroy(element)
    return "destroyed"
  }
  parkWebview(element, parkingLot)
  return "parked"
}

/** Test seam: forget whatever is parked. */
export function resetParkedWebview(): void {
  parked = null
}
