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

/**
 * The persisted intent for a site.
 * - "continuous": kept in sync on every refresh (added to the allowlist).
 * - "block":      never synced, and hidden from "Sync All".
 * - "none":       no standing intent (may still be one-off synced on demand).
 */
export type CookieDomainPolicy = "continuous" | "block" | "none"

/** A registrable site discovered in the user's Chrome cookie store. */
export type DiscoveredDomain = {
  /** Registrable domain (eTLD+1), e.g. "google.com". */
  domain: string
  /** How many cookies in Chrome belong to this site. */
  cookieCount: number
  /** Unix ms of the most recently accessed cookie for this site, or null. */
  lastAccess: number | null
  /** The user's standing intent for this site. */
  policy: CookieDomainPolicy
  /** True when the user has already chosen a policy (continuous or block). */
  known: boolean
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
   * Continuous-sync allowlist (host suffixes, no leading dot), e.g.
   * ["google.com"]. A cookie is synced when its host_key, stripped of a leading
   * dot, equals or ends with ".<domain>" for some entry.
   */
  domains: string[]
  /** Blocked sites (same suffix semantics); never synced, excluded from Sync All. */
  blocked: string[]
  /** Source Chrome profile directory name; defaults to "Default". */
  sourceProfile: string
  /**
   * Whether the user has seen the first-launch "Sync from Chrome?" prompt. The
   * browser pane shows that prompt exactly once, when this is false.
   */
  firstRunComplete: boolean
}

/** Reply shape for cookieSyncGetSettings / cookieSyncSetSettings / cookieSyncSetPolicy. */
export type CookieSyncState = CookieSyncSettings & {
  ok: true
  /** Whether a readable Chrome cookie store exists for sourceProfile right now. */
  chromeAvailable: boolean
  /** Last sync outcome, or null if never run. */
  lastSync: CookieSyncStatus | null
}

/** Reply shape for cookieSyncRunNow / cookieSyncSyncDomains. */
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

/** Reply shape for cookieSyncListDomains. */
export type CookieSyncDomainsResult = {
  ok: true
  /** Ranked: known (continuous first, then blocked) at the top, then by recency. */
  domains: DiscoveredDomain[]
}

/** Sensible default allowlist: Google account + common Google properties. */
export const DEFAULT_COOKIE_DOMAINS: readonly string[] = [
  "google.com",
  "youtube.com",
]
