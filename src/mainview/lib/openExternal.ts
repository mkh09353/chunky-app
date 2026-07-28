// Opening links outside the app.
//
// Inside Electrobun the WebView has nowhere to put a new window, so
// `target="_blank"` anchors and `window.open` are silently dropped. Route them
// through the Bun process instead (which shells out to the OS handler), and
// fall back to `window.open` in plain browser dev (`bun run dev:web`).

import { getRpc, nativeRpcAvailable } from "./rpc"

/** Only http(s) leaves the app — never file:, javascript:, data:, … */
export function isExternalUrl(raw: string | null | undefined): raw is string {
  if (typeof raw !== "string") return false
  const value = raw.trim()
  if (!value || value.startsWith("#")) return false
  try {
    const { protocol } = new URL(value, typeof location === "undefined" ? undefined : location.href)
    return protocol === "http:" || protocol === "https:"
  } catch {
    return false
  }
}

function openInBrowser(url: string) {
  try {
    window.open(url, "_blank", "noopener,noreferrer")
  } catch {
    /* popup blocked — the URL stays visible wherever it was rendered */
  }
}

/**
 * Open an http(s) URL in the user's default browser. Fire-and-forget: a failed
 * hand-off is never worth interrupting the UI for. Non-http(s) input is ignored
 * here as well as in the Bun handler.
 */
export function openExternal(url: string): void {
  if (!isExternalUrl(url)) return
  if (!nativeRpcAvailable()) {
    openInBrowser(url)
    return
  }
  void (async () => {
    const rpc = await getRpc()
    const fn = rpc?.request?.openExternal
    if (!fn) {
      openInBrowser(url)
      return
    }
    try {
      const raw = (await fn({ url })) as { ok?: unknown } | null
      if (!raw || typeof raw !== "object" || raw.ok !== true) openInBrowser(url)
    } catch {
      openInBrowser(url)
    }
  })()
}

/** Anchors we take over: real external targets, not in-page fragments or downloads. */
function externalAnchor(target: EventTarget | null): HTMLAnchorElement | null {
  if (!(target instanceof Element)) return null
  const anchor = target.closest("a")
  if (!anchor) return null
  if (anchor.hasAttribute("download")) return null
  const href = anchor.getAttribute("href")
  if (!href || href.startsWith("#")) return null
  return isExternalUrl(anchor.href) ? anchor : null
}

/**
 * Single delegated listener for the whole document: intercepts plain clicks,
 * ⌘/ctrl-clicks and middle-clicks on external links and hands them to the OS.
 * Returns a disposer.
 */
export function installExternalLinkHandler(doc: Document = document): () => void {
  const onClick = (event: MouseEvent) => {
    if (event.defaultPrevented) return
    // Right-click opens the context menu; anything past the middle button is
    // navigation (back/forward) and not ours.
    if (event.button !== 0 && event.button !== 1) return
    const anchor = externalAnchor(event.target)
    if (!anchor) return
    event.preventDefault()
    openExternal(anchor.href)
  }

  doc.addEventListener("click", onClick)
  // Middle-click never fires `click` — it arrives as `auxclick`.
  doc.addEventListener("auxclick", onClick)
  return () => {
    doc.removeEventListener("click", onClick)
    doc.removeEventListener("auxclick", onClick)
  }
}
