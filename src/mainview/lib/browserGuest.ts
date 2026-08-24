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
 * Message type carrying the page's `<meta name="theme-color">` content, or
 * null when the page has none. Reported RAW: validation is the host's job
 * (`~/lib/browserTint`), because a page string must never reach a style.
 */
export const PAGE_THEME_COLOR = "chunky:page-theme-color"

/** How long the guard coalesces `<head>` churn before re-reading the meta. */
export const THEME_COLOR_THROTTLE_MS = 250

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

    // -- theme-color -------------------------------------------------------
    // Media-aware: a page may ship one meta per colour scheme, so the variant
    // whose media query currently matches wins, with the unscoped one as the
    // fallback. Reported on load, on <head> changes (SPAs swap these), and when
    // the colour scheme flips.
    var lastReported;
    // Everything is reached through window.* on purpose: the script is also
    // evaluated against a stand-in window in tests, and in a real page
    // window.document === document.
    var readThemeColor = function () {
      try {
        var doc = window.document;
        if (!doc || typeof doc.querySelectorAll !== "function") return null;
        var metas = doc.querySelectorAll('meta[name="theme-color"]');
        var fallback = null;
        for (var i = 0; i < metas.length; i++) {
          var content = metas[i].getAttribute("content");
          if (!content) continue;
          var media = metas[i].getAttribute("media");
          if (!media) { if (fallback === null) fallback = content; continue; }
          try {
            if (window.matchMedia && window.matchMedia(media).matches) return content;
          } catch (err) {}
        }
        return fallback;
      } catch (err) {
        return null;
      }
    };
    var reportThemeColor = function () {
      var color = readThemeColor();
      if (color === lastReported) return;
      lastReported = color;
      post({ type: ${JSON.stringify(PAGE_THEME_COLOR)}, color: color === null ? null : String(color) });
    };
    var pending = 0;
    var scheduleReport = function () {
      if (pending) return;
      pending = window.setTimeout(function () {
        pending = 0;
        reportThemeColor();
      }, ${THEME_COLOR_THROTTLE_MS});
    };
    reportThemeColor();
    try {
      var doc = window.document;
      if (doc && doc.readyState === "loading" && doc.addEventListener) {
        doc.addEventListener("DOMContentLoaded", reportThemeColor, { once: true });
      }
      if (window.addEventListener) window.addEventListener("load", scheduleReport);
      // ONE observer per document: the __chunkyGuestGuard gate above means a
      // re-injection returns before reaching this, so observers cannot stack.
      if (doc && doc.head && typeof window.MutationObserver === "function") {
        new window.MutationObserver(scheduleReport).observe(doc.head, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ["content", "media", "name"]
        });
      }
      if (window.matchMedia) {
        var scheme = window.matchMedia("(prefers-color-scheme: dark)");
        if (scheme.addEventListener) scheme.addEventListener("change", scheduleReport);
        else if (scheme.addListener) scheme.addListener(scheduleReport);
      }
    } catch (err) {}
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

/**
 * Read a theme-colour report out of a `host-message` detail.
 *
 * Returns the RAW page string (never trusted, never styled with directly), or
 * null both for "the page has no theme colour" and for "this message is
 * something else" — distinguished by the `matched` flag so the host only resets
 * its tint on an actual report.
 */
export function readThemeColorMessage(detail: unknown): { matched: boolean; color: string | null } {
  let value = detail
  if (typeof value === "string") {
    try {
      value = JSON.parse(value)
    } catch {
      return { matched: false, color: null }
    }
  }
  if (!value || typeof value !== "object") return { matched: false, color: null }
  const body = value as { type?: unknown; color?: unknown }
  if (body.type !== PAGE_THEME_COLOR) return { matched: false, color: null }
  return { matched: true, color: typeof body.color === "string" ? body.color : null }
}
