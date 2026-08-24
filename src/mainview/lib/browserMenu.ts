// Native menu → renderer signals for the browser pane.
//
// Why this exists: while focus is inside the pane's NATIVE (CEF) view, the host
// WebView receives no key events, so the pane's own ⌘F listener cannot see the
// keystroke. AppKit routes a menu key equivalent regardless of which NSView has
// focus, so `Edit ▸ Find…` (declared in `src/bun/index.ts`) is the only ⌘F that
// works from inside a page. Bun forwards the click over the existing
// fire-and-forget bun→webview message channel — the same one the terminal
// stream and the setup/updater notices use.

import { getRpc, type RpcMessageListener } from "./rpc"

/**
 * Message name, mirrored in `src/bun/index.ts` (the renderer bundle must not
 * import Bun modules — same arrangement as `SETUP_STAGE_MESSAGE`).
 */
export const BROWSER_FIND_MESSAGE = "chunkyBrowserFind"

/**
 * Subscribe to `Edit ▸ Find…`. Returns a synchronous unsubscribe even though
 * the RPC client resolves asynchronously.
 */
export function onBrowserFindRequested(handler: () => void): () => void {
  let cancelled = false
  let attached: RpcMessageListener | null = null

  void (async () => {
    const rpc = await getRpc()
    if (cancelled || !rpc?.addMessageListener) return
    const listener: RpcMessageListener = () => handler()
    attached = listener
    rpc.addMessageListener(BROWSER_FIND_MESSAGE, listener)
  })()

  return () => {
    cancelled = true
    const listener = attached
    if (!listener) return
    attached = null
    void getRpc().then((rpc) => rpc?.removeMessageListener?.(BROWSER_FIND_MESSAGE, listener))
  }
}
