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
