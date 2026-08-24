// Guest-page hardening for the in-app browser pane.
//
// Why this exists (Electrobun 1.18.1 + CEF 147):
//
// The pane's `<electrobun-webview renderer="cef">` is created with
// `CefWindowInfo::SetAsChild`, i.e. the CEF browser is a child NSView of the
// app's MAIN window. `ElectrobunClient` does not override `DoClose`, so CEF's
// default close path runs `CefBrowserPlatformDelegateNativeMac::CloseHostWindow()`,
// which sends `performClose:` to the browser view's window — our main window.
// That fires `-[WindowDelegate windowWillClose:]` → Electrobun's `close` event →
// `BrowserWindow.ts` deletes the last entry of `BrowserWindowMap` and, with
// `exitOnLastWindowClosed` defaulting to true, calls `quit()` →
// `stopEventLoop()` + `forceExit(0)`. A clean exit, no crash report.
//
// A page calling `window.close()` therefore quits Chunky. Popups are blocked
// upstream (`ElectrobunClient::OnBeforePopup` always returns true), so
// popup-style flows — OAuth "this window will close automatically" pages in
// particular — run INLINE in the pane and then self-close, which is exactly the
// "clicked something in a page and the app vanished" report.
//
// The fix is to take `window.close` away from the guest page and turn it into a
// message to the host instead. The script below is static (no interpolation, no
// secrets, nothing derived from page content) and is delivered two ways, see
// `BrowserPane.tsx`:
//
//  1. as the tag's `preload` attribute (runs before page scripts), and
//  2. re-injected with `executeJavascript` on every navigation/dom-ready event,
//     which is the belt-and-braces path that does not depend on the custom
//     preload being honoured for sandboxed CEF views.
//
// It is idempotent, so running both ways (or several times per page) is a
// no-op after the first.

/** Message type the guarded page sends when it tries to close itself. */
export const PAGE_CLOSE_REQUEST = "chunky:page-close-request"

/**
 * The JS injected into the guest page.
 *
 * Notes on the shape:
 *  - Sandboxed guests do NOT get Electrobun's trusted preload, so
 *    `window.__electrobunSendToHost` does not exist there. The sandboxed
 *    dynamic preload does set `window.__electrobunEventBridge` /
 *    `__electrobunInternalBridge`, so this posts the same `webviewEvent`
 *    envelope Electrobun's own `emitWebviewEvent` uses. It arrives on the tag
 *    as a `host-message` event with a parsed object detail.
 *  - Only the guest page's own self-close is affected. Our chrome (back /
 *    forward / reload / address bar) drives the view through the tag's RPC and
 *    is untouched, and `window.open` is deliberately left alone (popups are
 *    already blocked natively and surface as `new-window-open`).
 *  - Everything is wrapped in try/catch: a page that has frozen `window` or
 *    removed the bridge must keep working, just without the guard.
 */
export const GUEST_GUARD_SCRIPT = `(function(){
  try {
    if (window.__chunkyGuestGuard) return;
    window.__chunkyGuestGuard = true;
    var post = function (payload) {
      try {
        var bridge = window.__electrobunEventBridge || window.__electrobunInternalBridge;
        if (!bridge || typeof bridge.postMessage !== "function") return;
        bridge.postMessage(JSON.stringify({
          id: "webviewEvent",
          type: "message",
          payload: {
            id: window.__electrobunWebviewId,
            eventName: "host-message",
            detail: JSON.stringify(payload)
          }
        }));
      } catch (err) {}
    };
    var requestClose = function () {
      var href = "";
      try { href = String(window.location.href); } catch (err) {}
      post({ type: ${JSON.stringify(PAGE_CLOSE_REQUEST)}, url: href });
    };
    try {
      Object.defineProperty(window, "close", {
        configurable: true,
        enumerable: false,
        writable: true,
        value: requestClose
      });
    } catch (err) {
      try { window.close = requestClose; } catch (err2) {}
    }
  } catch (err) {}
})();`

/**
 * Is this `host-message` detail the guarded page asking to be closed?
 *
 * The detail arrives as an object (Electrobun parses the JSON before emitting
 * it on the tag), but tolerate a raw JSON string too: the native event handler
 * falls back to the unparsed string when parsing fails, and the browser-only
 * dev build has no native side at all.
 */
export function isPageCloseRequest(detail: unknown): boolean {
  let value = detail
  if (typeof value === "string") {
    try {
      value = JSON.parse(value)
    } catch {
      return false
    }
  }
  if (!value || typeof value !== "object") return false
  return (value as { type?: unknown }).type === PAGE_CLOSE_REQUEST
}
