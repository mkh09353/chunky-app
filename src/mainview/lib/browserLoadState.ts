// Did the page in the pane fail to load?
//
// IMPORTANT, and the reason this file is so small: the installed Electrobun
// (1.18.1) surfaces NO load-failure event for `renderer="cef"`. Its
// `ElectrobunClient` overrides `CefLoadHandler::OnLoadStart` / `OnLoadEnd` but
// NOT `OnLoadError` (no `ElectrobunClient::OnLoadError` symbol exists in
// libNativeWrapper), and the only navigation event names the native library
// emits at all are `will-navigate`, `did-commit-navigation` and `did-navigate`.
// `load-started` / `load-committed` / `load-finished` exist in Electrobun's
// TypeScript event union but nothing emits them, and there is no
// `did-fail-load`.
//
// So the only HONEST failure signal available is the one the engine itself
// navigates to: Chromium commits its network-error page, and that commit
// arrives as an ordinary navigation event whose URL is an error-page URL. That
// is what this module recognises. No timers, no "dom-ready did not arrive"
// heuristics: if the engine does not tell us, the pane shows nothing.

/**
 * Schemes/URLs Chromium (and WebKit) use for their internal error documents.
 * Matched on the parsed protocol, never by prefix.
 */
const ERROR_PROTOCOLS = new Set(["chrome-error:", "edge-error:", "webkit-error:"])

/** `chrome://network-error/…`, `about:neterror?…` and friends. */
const ERROR_HOSTS = new Set(["network-error", "neterror", "chromewebdata"])

/** Is this URL an engine-generated error document rather than a real page? */
export function isErrorPageUrl(raw: unknown): boolean {
  if (typeof raw !== "string" || !raw.trim()) return false
  let parsed: URL
  try {
    parsed = new URL(raw.trim())
  } catch {
    return false
  }
  if (ERROR_PROTOCOLS.has(parsed.protocol)) return true
  if (parsed.protocol === "chrome:" || parsed.protocol === "about:") {
    const host = parsed.hostname || parsed.pathname.replace(/^\/+/, "")
    return ERROR_HOSTS.has(host)
  }
  return false
}

/** The host to name in "Couldn't load …", or the whole URL when it has none. */
export function hostLabel(raw: string): string {
  try {
    const parsed = new URL(raw)
    return parsed.hostname || parsed.href
  } catch {
    return raw
  }
}

export interface LoadFailure {
  /** What the user asked for (never the error-page URL). */
  url: string
  /** Host to show in the headline. */
  host: string
  /** Engine-provided reason, when the error URL carries one. */
  reason: string | null
}

/**
 * Turn "we asked for X and the view committed to an error page" into the state
 * the error surface renders, or null when this navigation was fine.
 *
 * `requested` is the last URL the pane actually asked for; the error page's own
 * URL is useless as a headline (`chrome-error://chromewebdata/`), so the
 * headline always names the requested host.
 */
export function describeLoadFailure(committed: unknown, requested: string | null): LoadFailure | null {
  if (!isErrorPageUrl(committed)) return null
  const url = requested && requested.trim() ? requested.trim() : typeof committed === "string" ? committed : ""
  return { url, host: hostLabel(url), reason: errorReason(committed) }
}

/**
 * Some engines put the failure in the error URL's query (`?e=`, `?errorCode=`,
 * `?d=`). Read it when it is there; never invent one.
 */
function errorReason(committed: unknown): string | null {
  if (typeof committed !== "string") return null
  try {
    const parsed = new URL(committed)
    for (const key of ["e", "d", "errorCode", "error", "reason"]) {
      const value = parsed.searchParams.get(key)
      if (value && value.trim()) return value.trim()
    }
  } catch {
    return null
  }
  return null
}

/**
 * Should an in-flight error surface be cleared for this navigation?
 *
 * Any navigation to something that is NOT an error page means the pane is
 * showing a real document again.
 */
export function shouldClearFailure(committed: unknown): boolean {
  return !isErrorPageUrl(committed)
}
