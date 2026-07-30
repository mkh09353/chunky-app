// Programmatic navigation for the in-app BrowserPane.
//
// The pane is mounted by App (behind `browserOpen`) and owns its own URL state,
// so "open this link in the Chunky browser" has two halves: App has to mount
// the pane, and the pane has to navigate. Both subscribe here; the request is
// also parked so a pane that mounts *after* the request still picks it up.

import { isExternalUrl } from "./openExternal"

type Listener = (url: string) => void

const listeners = new Set<Listener>()
let pending: string | null = null

/** Show `url` in the in-app browser pane, opening the pane when it is closed. */
export function openInAppBrowser(url: string): void {
  if (!isExternalUrl(url)) return
  pending = url
  for (const listener of Array.from(listeners)) listener(url)
}

/** Listen for navigation requests. Returns a disposer. */
export function subscribeBrowserNavigation(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * Claim a request that arrived before the pane existed (or was handled live).
 * Reading it clears it, so a later remount does not re-navigate.
 */
export function takePendingBrowserUrl(): string | null {
  const url = pending
  pending = null
  return url
}

/**
 * Read the URL out of a server `app.open_url` frame, or null when this is not
 * one.
 *
 * Typed against `unknown` on purpose: the check has to survive a protocol
 * package that does not carry the variant yet (and a server that sends a
 * malformed one), so the shape is verified structurally instead of trusting the
 * union. Whether the URL is *allowed* is not decided here — `openInAppBrowser`
 * owns that rule.
 */
export function appOpenUrlRequest(ev: unknown): string | null {
  if (!ev || typeof ev !== "object") return null
  const { type, url } = ev as { type?: unknown; url?: unknown }
  if (type !== "app.open_url" || typeof url !== "string") return null
  const value = url.trim()
  return value ? value : null
}

/**
 * Handle an `app.open_url` event: the agent asking for this app's browser pane.
 *
 * Returns true when the event was CLAIMED, which the caller must treat as "do
 * not pass this to the transcript reducer" — including for a claimed frame whose
 * URL `openInAppBrowser` then rejects (non-http(s) or junk). It is a live-only
 * control frame either way, never a transcript item.
 */
export function consumeAppOpenUrl(ev: unknown): boolean {
  const url = appOpenUrlRequest(ev)
  if (url === null) return false
  openInAppBrowser(url)
  return true
}
