// Window drag regions — which parts of our custom chrome move the OS window.
//
// The window is frameless-ish (`titleBarStyle: "hiddenInset"` in src/bun/index.ts),
// so the app owns its titlebar and must declare the draggable strips itself.
//
// The catch: Electrobun's main window is a WKWebView, which does NOT implement
// `-webkit-app-region` at all. Electrobun emulates it in its preload shim
// (node_modules/electrobun/dist/api/bun/preload/dragRegions.ts), and that shim
// decides purely from markup on mousedown:
//
//   target.closest('.electrobun-webkit-app-region-no-drag')          → no drag
//   target.closest('[style*="app-region"][style*="no-drag"]')        → no drag
//   target.closest('.electrobun-webkit-app-region-drag')             → drag
//   target.closest('[style*="app-region"][style*="drag"]')           → drag
//
// A *stylesheet* rule (`.app-drag { -webkit-app-region: drag }`) is invisible to
// it: the shim never reads computed styles. So every drag/no-drag element has to
// carry Electrobun's literal class name. We keep our own `app-drag` / `no-drag`
// classes alongside it so the CSS property still applies in Chromium-based
// renderers (CEF builds, `bun run dev:web` in a browser).
//
// Note the shim starts the native window move on mousedown *anywhere* inside a
// drag region, so every interactive descendant (tab, button, input, menu
// trigger) must opt out with NO_DRAG_REGION or clicking it drags the window.

/** Marks a strip of chrome as "grab here to move the window". */
export const DRAG_REGION = "app-drag electrobun-webkit-app-region-drag"

/** Opts an interactive element out of an enclosing drag region. */
export const NO_DRAG_REGION = "no-drag electrobun-webkit-app-region-no-drag"
