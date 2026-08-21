// Renderer → Bun RPC wrapper for the Chrome→in-app-browser cookie sync.
// UI only: every read/decrypt/inject step lives in Bun (src/bun/cookieSync.ts).
// Cookie VALUES never cross this boundary — only domains, counts and status.
import type {
  ChromeProfile,
  CookieSyncProfilesResult,
  CookieSyncRunResult,
  CookieSyncSettings,
  CookieSyncState,
} from "../../shared/cookieSync"
import { getRpc } from "./rpc"

export type { ChromeProfile, CookieSyncRunResult, CookieSyncSettings, CookieSyncState }
export { DEFAULT_COOKIE_DOMAINS } from "../../shared/cookieSync"

function isState(value: unknown): value is CookieSyncState {
  if (!value || typeof value !== "object") return false
  const v = value as Partial<CookieSyncState>
  return (
    v.ok === true &&
    typeof v.enabled === "boolean" &&
    Array.isArray(v.domains) &&
    v.domains.every((d) => typeof d === "string") &&
    typeof v.sourceProfile === "string" &&
    typeof v.chromeAvailable === "boolean"
  )
}

function isProfiles(value: unknown): value is CookieSyncProfilesResult {
  if (!value || typeof value !== "object") return false
  const v = value as Partial<CookieSyncProfilesResult>
  return (
    v.ok === true &&
    Array.isArray(v.profiles) &&
    v.profiles.every(
      (p) => !!p && typeof p === "object" && typeof p.id === "string" && typeof p.name === "string",
    )
  )
}

const UNAVAILABLE = "Cookie sync is only available in the Chunky desktop app."

function fail(error: unknown, fallback: string): never {
  throw new Error(error instanceof Error ? error.message : fallback)
}

/** Current cookie-sync state. Bun owns persistence — never localStorage. */
export async function cookieSyncGetSettings(): Promise<CookieSyncState> {
  try {
    const fn = (await getRpc())?.request?.cookieSyncGetSettings
    if (!fn) throw new Error(UNAVAILABLE)
    const raw = await fn()
    if (!isState(raw)) throw new Error("Could not read cookie sync settings.")
    return raw
  } catch (error) {
    fail(error, "Could not read cookie sync settings.")
  }
}

/** Patch settings; the returned state is the source of truth. */
export async function cookieSyncSetSettings(
  patch: Partial<CookieSyncSettings>,
): Promise<CookieSyncState> {
  try {
    const fn = (await getRpc())?.request?.cookieSyncSetSettings
    if (!fn) throw new Error(UNAVAILABLE)
    const raw = await fn(patch)
    if (!isState(raw)) throw new Error("Could not save cookie sync settings.")
    return raw
  } catch (error) {
    fail(error, "Could not save cookie sync settings.")
  }
}

/** Run a sync now. Resolves with the outcome rather than throwing on a soft failure. */
export async function cookieSyncRunNow(): Promise<CookieSyncRunResult> {
  try {
    const fn = (await getRpc())?.request?.cookieSyncRunNow
    if (!fn) return { ok: false, count: 0, error: UNAVAILABLE }
    const raw = await fn()
    if (!raw || typeof raw !== "object") return { ok: false, count: 0, error: "Sync failed." }
    const body = raw as { ok?: unknown; count?: unknown; error?: unknown }
    return {
      ok: body.ok === true,
      count: typeof body.count === "number" ? body.count : 0,
      ...(typeof body.error === "string" ? { error: body.error } : {}),
    }
  } catch (error) {
    return { ok: false, count: 0, error: error instanceof Error ? error.message : "Sync failed." }
  }
}

/** Chrome profiles available as a source. Empty list when none can be read. */
export async function cookieSyncListProfiles(): Promise<ChromeProfile[]> {
  try {
    const fn = (await getRpc())?.request?.cookieSyncListProfiles
    if (!fn) return []
    const raw = await fn()
    return isProfiles(raw) ? raw.profiles : []
  } catch {
    return []
  }
}

/**
 * Normalize user input to a bare lowercase host: strips a scheme, any path,
 * credentials/port, a leading dot and surrounding whitespace.
 */
export function normalizeDomain(input: string): string {
  let s = input.trim().toLowerCase()
  if (!s) return ""
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
  s = s.split("/")[0] ?? ""
  s = s.split("?")[0] ?? ""
  const at = s.lastIndexOf("@")
  if (at >= 0) s = s.slice(at + 1)
  s = s.replace(/:\d+$/, "")
  s = s.replace(/^\.+/, "").replace(/\.+$/, "")
  if (!/^[a-z0-9.-]+$/.test(s) || !s.includes(".")) return ""
  // Every label must be non-empty and must not start/end with a hyphen.
  const labels = s.split(".")
  if (labels.some((l) => l === "" || l.startsWith("-") || l.endsWith("-"))) return ""
  return s
}
