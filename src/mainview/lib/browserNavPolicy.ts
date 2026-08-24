// What may load in the browser pane.
//
// The pane is a real browser view with our app's process behind it, so the set
// of schemes it accepts is a security boundary, not a convenience:
//
//  - `javascript:` would execute in whatever document is currently loaded,
//    which is how a copied-and-pasted "address" turns into script running with
//    the page's origin;
//  - `file:` would hand a remote-controllable view read access to the local
//    disk (the pane is also a CDP target the server can drive);
//  - `data:` is the classic phishing vector — an attacker-authored
//    document that inherits a blank origin and can spoof any chrome;
//  - custom schemes (`views:`, `chunky:`, `itms:`, …) reach app-internal or
//    OS-level handlers that were never meant to be reachable from a page.
//
// So: http, https, and `about:blank` (the only useful "nothing here" URL).
// Everything else is refused, and refusal is a no-op plus an inline note — the
// pane never navigates and never shows a modal.
//
// Every decision goes through `new URL(...)`, never a string prefix check:
// `"https:/\evil"`, `" javascript:…"`, `"jAvAsCrIpT:…"` and friends all have to
// answer to the same parser the loader will use.

/** The only schemes the pane will load. */
export const ALLOWED_PANE_PROTOCOLS = ["http:", "https:"] as const

/** The only non-http(s) URL worth allowing: an intentionally blank page. */
export const BLANK_URL = "about:blank"

/** Where a bare search term goes. */
const SEARCH_PREFIX = "https://duckduckgo.com/?q="

/** The pane's home page, and the fallback whenever a stored URL is unusable. */
export const DEFAULT_PANE_URL = "https://duckduckgo.com/"

export type NavRejection = { ok: false; reason: string }
export type NavResolution = { ok: true; url: string } | NavRejection

const REJECT_SCHEME: NavRejection = {
  ok: false,
  reason: "Only http and https addresses can open in this browser.",
}
const REJECT_MALFORMED: NavRejection = { ok: false, reason: "That does not look like a valid address." }

/** Parse without throwing. Relative URLs are not resolved: the pane has no base. */
function parse(raw: string): URL | null {
  try {
    return new URL(raw)
  } catch {
    return null
  }
}

/** Is this an absolute URL the pane is allowed to load, exactly as given? */
export function isAllowedPaneUrl(raw: unknown): raw is string {
  if (typeof raw !== "string") return false
  const value = raw.trim()
  if (!value) return false
  const parsed = parse(value)
  if (!parsed) return false
  if (parsed.href === BLANK_URL || value === BLANK_URL) return true
  if (!(ALLOWED_PANE_PROTOCOLS as readonly string[]).includes(parsed.protocol)) return false
  // `http://` with no host parses on some inputs; a hostless page cannot load.
  return parsed.hostname.length > 0
}

/**
 * Resolve a URL the app itself asks the pane to open: a `new-window-open`
 * target, an `app.open_url` from the server, the persisted last URL, a restored
 * link. No search fallback — programmatic input is a URL or it is nothing.
 */
export function resolveProgrammaticUrl(raw: unknown): NavResolution {
  if (typeof raw !== "string" || !raw.trim()) return REJECT_MALFORMED
  const value = raw.trim()
  const parsed = parse(value)
  if (!parsed) return REJECT_MALFORMED
  if (!isAllowedPaneUrl(value)) return REJECT_SCHEME
  return { ok: true, url: value === BLANK_URL ? BLANK_URL : parsed.href }
}

/** Hosts, IPv4 addresses, `localhost[:port]`, and paths under any of them. */
function looksLikeHost(value: string): boolean {
  return (
    value === "localhost" ||
    /^localhost(?::\d+)?(?:\/|$)/.test(value) ||
    /^\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?(?:\/|$)/.test(value) ||
    /^(?:[\w-]+\.)+[a-z]{2,}(?::\d+)?(?:\/|$)/i.test(value)
  )
}

/**
 * Resolve what the user typed in the address bar.
 *
 * In order:
 *  1. anything containing whitespace is a search — `"ratio: 3:1 is fine"`
 *     parses as a URL with scheme `ratio:` but is obviously a query, and
 *     browsers treat it that way. (It can never navigate anywhere dangerous:
 *     a search is a plain https URL.)
 *  2. host-shaped input (`example.com/x`, `localhost:4620`, `127.0.0.1:8080`)
 *     gets `https://` — checked BEFORE the scheme branch, since `localhost:4620`
 *     also parses as the bogus scheme `localhost:`;
 *  3. an explicit scheme loads if allowed and is REFUSED otherwise. Typing
 *     `javascript:…` must not quietly become a web search for it: that would
 *     hide the refusal and teach the habit;
 *  4. everything else is a search.
 */
export function resolveAddressInput(input: string): NavResolution {
  const value = input.trim()
  if (!value) return { ok: true, url: DEFAULT_PANE_URL }
  const search = (): NavResolution => ({ ok: true, url: `${SEARCH_PREFIX}${encodeURIComponent(value)}` })

  if (/\s/.test(value)) return search()

  if (looksLikeHost(value)) {
    const parsed = parse(`https://${value}`)
    if (parsed && isAllowedPaneUrl(parsed.href)) return { ok: true, url: parsed.href }
  }

  if (/^[a-z][a-z\d+.-]*:/i.test(value)) {
    const parsed = parse(value)
    // `http://` and friends do not parse at all; those are searches, not
    // refusals — nothing dangerous was asked for.
    if (!parsed) return search()
    return isAllowedPaneUrl(value) ? { ok: true, url: parsed.href } : REJECT_SCHEME
  }

  return search()
}

/**
 * The URL to open on start-up, given whatever was parked or persisted. Falls
 * back to the home page rather than refusing to open: a stored value that is no
 * longer acceptable must not leave the pane blank.
 */
export function resolveStartupUrl(...candidates: (string | null | undefined)[]): string {
  for (const candidate of candidates) {
    const resolved = resolveProgrammaticUrl(candidate)
    if (resolved.ok) return resolved.url
  }
  return DEFAULT_PANE_URL
}
