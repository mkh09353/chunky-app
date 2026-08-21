/**
 * Shared contract for the Chrome→CEF cookie-sync feature.
 *
 * These types cross the Bun↔renderer RPC boundary (createRPC in
 * src/bun/index.ts). Cookie VALUES never appear here: the renderer only ever
 * sees domain names, counts, and status. Decryption, Keychain access, and CDP
 * injection all stay in Bun (src/bun/cookieSync.ts).
 */

/** A source Chrome profile the user can pick from. */
export type ChromeProfile = {
  /** Directory name under the Chrome user-data dir, e.g. "Default", "Profile 1". */
  id: string
  /** Human label from the profile's Preferences (falls back to id). */
  name: string
}

export type CookieSyncStatus = {
  /** Wall-clock ms of the last completed attempt (success or failure), or null. */
  at: number | null
  /** Cookies injected on the last successful run. */
  count: number
  /** Present only when the last attempt failed; a short human-readable reason. */
  error?: string
}

export type CookieSyncSettings = {
  /** Master on/off. When false, no reads, no Keychain access, no timers. */
  enabled: boolean
  /**
   * Domain allowlist (host suffixes, no leading dot), e.g. ["google.com"].
   * A cookie is synced when its host_key, stripped of a leading dot, equals or
   * ends with ".<domain>" for some entry.
   */
  domains: string[]
  /** Source Chrome profile directory name; defaults to "Default". */
  sourceProfile: string
}

/** Reply shape for cookieSyncGetSettings / cookieSyncSetSettings. */
export type CookieSyncState = CookieSyncSettings & {
  ok: true
  /** Whether a readable Chrome cookie store exists for sourceProfile right now. */
  chromeAvailable: boolean
  /** Last sync outcome, or null if never run. */
  lastSync: CookieSyncStatus | null
}

/** Reply shape for cookieSyncRunNow. */
export type CookieSyncRunResult = {
  ok: boolean
  /** Cookies injected (0 on failure). */
  count: number
  /** Short reason when ok === false. */
  error?: string
}

/** Reply shape for cookieSyncListProfiles. */
export type CookieSyncProfilesResult = {
  ok: true
  profiles: ChromeProfile[]
}

/** Sensible default allowlist: Google account + common Google properties. */
export const DEFAULT_COOKIE_DOMAINS: readonly string[] = [
  "google.com",
  "youtube.com",
]
