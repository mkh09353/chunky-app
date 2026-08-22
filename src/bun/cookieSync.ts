/**
 * Chrome → CEF cookie sync.
 *
 * Reads the user's Chrome cookie DB, decrypts the legacy v10 values with the
 * Keychain "Chrome Safe Storage" secret, filters by a domain allowlist, and
 * injects the result into the app's CEF pane via CDP `Storage.setCookies`.
 *
 * Cookie plaintext and the Keychain secret never leave this module: they are
 * not logged, not written to disk, and not returned over RPC.
 */
import { createDecipheriv, createHash, pbkdf2Sync, randomBytes } from "node:crypto"
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { Database } from "bun:sqlite"
import {
  DEFAULT_COOKIE_DOMAINS,
  type CookieDomainPolicy,
  type CookieSyncDomainsResult,
  type CookieSyncProfilesResult,
  type CookieSyncRunResult,
  type CookieSyncSettings,
  type CookieSyncState,
  type CookieSyncStatus,
  type ChromeProfile,
  type DiscoveredDomain,
} from "../shared/cookieSync"
import { stateDir } from "./desktopState"

const SETTINGS_FILE = "cookieSync.json"
const DEFAULT_PROFILE = "Default"
const DEFAULT_INTERVAL_MS = 15 * 60 * 1000
const MAX_DOMAINS = 32
const MAX_DOMAIN_LENGTH = 253
const MAX_PROFILE_LENGTH = 64
const MAX_ERROR_LENGTH = 160
const MAX_DISCOVERED_DOMAINS = 200
const CHROME_EPOCH_OFFSET_SECONDS = 11_644_473_600
const CHROME_EPOCH_OFFSET_MS = 11_644_473_600_000
const TWO_PART_PUBLIC_SUFFIXES = new Set([
  "co.uk",
  "org.uk",
  "ac.uk",
  "gov.uk",
  "com.au",
  "net.au",
  "org.au",
  "co.jp",
  "co.nz",
  "co.in",
  "com.br",
])
const PBKDF2_ITERATIONS = 1003
const PBKDF2_KEYLEN = 16
const V10_PREFIX = Buffer.from("v10")
const AES_IV = Buffer.alloc(16, 0x20)
const CDP_TIMEOUT_MS = 10_000
const VERSION_TIMEOUT_MS = 2_000

export type CookieSyncTarget = {
  cdpPort: number
  renderer: "cef" | "native"
  debuggable: boolean
}

export type CdpCookie = {
  name: string
  value: string
  domain: string
  path: string
  secure: boolean
  httpOnly: boolean
  sameSite?: "None" | "Lax" | "Strict"
  expires?: number
  sourceScheme?: "Unset" | "NonSecure" | "Secure"
  sourcePort?: number
}

export type PersistedCookieSync = CookieSyncSettings & {
  lastSync: CookieSyncStatus | null
}

export type CookieSyncDeps = {
  resolveTarget: () => Promise<CookieSyncTarget>
  fetch?: typeof fetch
  chromeUserDataDir?: string
  securityCli?: () => Promise<string>
  readPersisted?: () => PersistedCookieSync | null
  writePersisted?: (next: PersistedCookieSync) => void
  injectCookies?: (port: number, cookies: CdpCookie[]) => Promise<void>
  intervalMs?: number
  now?: () => number
  stateHome?: NodeJS.ProcessEnv
}

export type CookieSyncService = {
  getState(): CookieSyncState
  setSettings(patch: unknown): CookieSyncState
  runNow(): Promise<CookieSyncRunResult>
  listProfiles(): CookieSyncProfilesResult
  listDomains(): CookieSyncDomainsResult
  setPolicy(domain: unknown, policy: unknown): CookieSyncState
  syncDomains(filter: string[] | null): Promise<CookieSyncRunResult>
  completeFirstRun(): CookieSyncState
  start(): void
  stop(): void
  onPaneDebuggable(): void
}

type ChromeCookieRow = {
  host_key: string
  name: string
  encrypted_value: Uint8Array | Buffer | string | null
  path: string | null
  expires_utc: number | bigint | null
  is_secure: number | null
  is_httponly: number | null
  samesite: number | null
  has_expires: number | null
  is_persistent: number | null
  source_scheme: number | null
  source_port: number | null
  last_access_utc?: number | bigint | null
}

export function chromeExpiresToUnixSeconds(expiresUtc: number): number {
  return expiresUtc / 1e6 - CHROME_EPOCH_OFFSET_SECONDS
}

export function mapChromeSameSite(value: unknown): "None" | "Lax" | "Strict" | undefined {
  const n = typeof value === "number" ? value : typeof value === "bigint" ? Number(value) : Number.NaN
  if (n === 0) return "None"
  if (n === 1) return "Lax"
  if (n === 2) return "Strict"
  return undefined
}

/** host_key matches an allowlist entry by equality or proper suffix. */
export function cookieHostMatchesDomain(hostKey: string, domain: string): boolean {
  const host = hostKey.replace(/^\./, "").toLowerCase()
  const needle = domain.replace(/^\./, "").toLowerCase()
  if (!host || !needle) return false
  return host === needle || host.endsWith(`.${needle}`)
}

export function chromeAccessToUnixMs(lastAccessUtc: number): number | null {
  if (!Number.isFinite(lastAccessUtc) || lastAccessUtc <= 0) return null
  return lastAccessUtc / 1000 - CHROME_EPOCH_OFFSET_MS
}

/** Pragmatic eTLD+1: last two labels, or last three for a small public-suffix set. */
export function registrableDomain(host: string): string {
  const value = host.replace(/^\./, "").toLowerCase().replace(/\.$/, "")
  if (!value) return ""
  if (value === "localhost" || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(value)) return value
  const labels = value.split(".").filter(Boolean)
  if (labels.length <= 1) return value
  const lastTwo = `${labels[labels.length - 2]}.${labels[labels.length - 1]}`
  if (TWO_PART_PUBLIC_SUFFIXES.has(lastTwo) && labels.length >= 3) {
    return `${labels[labels.length - 3]}.${lastTwo}`
  }
  return lastTwo
}

export function sanitizePersisted(raw: unknown): PersistedCookieSync {
  return sanitizePersistedInternal(raw)
}

export function decryptChromeV10(encrypted: Uint8Array, secret: string, hostKey: string): string {
  if (encrypted.length <= V10_PREFIX.length) throw new Error("truncated")
  if (!Buffer.from(encrypted.subarray(0, V10_PREFIX.length)).equals(V10_PREFIX)) throw new Error("scheme")
  const key = pbkdf2Sync(secret, "saltysalt", PBKDF2_ITERATIONS, PBKDF2_KEYLEN, "sha1")
  const decipher = createDecipheriv("aes-128-cbc", key, AES_IV)
  const plain = Buffer.concat([
    decipher.update(encrypted.subarray(V10_PREFIX.length)),
    decipher.final(),
  ])
  // Current Chrome prefixes the plaintext with SHA-256(host_key). Older cookies
  // do not. Only strip when the digest actually matches — never blindly.
  if (plain.length >= 32) {
    const expected = createHash("sha256").update(hostKey).digest()
    if (plain.subarray(0, 32).equals(expected)) return plain.subarray(32).toString("utf8")
  }
  return plain.toString("utf8")
}

function settingsPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(stateDir(env), SETTINGS_FILE)
}

function defaultChromeUserDataDir(): string {
  return join(homedir(), "Library", "Application Support", "Google", "Chrome")
}

function cleanDomain(raw: unknown): string | null {
  if (typeof raw !== "string") return null
  let value = raw.trim().toLowerCase()
  if (value.startsWith(".")) value = value.slice(1)
  if (!value || value.length > MAX_DOMAIN_LENGTH) return null
  if (value.includes("\0") || value.includes("/") || value.includes("\\") || value.includes("..")) return null
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/.test(value)) return null
  return value
}

function cleanDomains(raw: unknown, fallback: string[]): string[] {
  if (!Array.isArray(raw)) return fallback
  const out: string[] = []
  for (const item of raw) {
    const domain = cleanDomain(item)
    if (!domain || out.includes(domain)) continue
    out.push(domain)
    if (out.length >= MAX_DOMAINS) break
  }
  return out
}

function cleanProfile(raw: unknown, fallback: string): string {
  if (typeof raw !== "string") return fallback
  const value = raw.trim()
  if (!value || value.length > MAX_PROFILE_LENGTH) return fallback
  if (value.includes("\0") || value.includes("/") || value.includes("\\") || value.includes("..")) return fallback
  if (value === "." || value.startsWith(".")) return fallback
  if (!/^[A-Za-z0-9][A-Za-z0-9 _-]*$/.test(value)) return fallback
  return value
}

function clipError(message: string): string {
  const trimmed = message.trim() || "Cookie sync failed"
  return trimmed.length > MAX_ERROR_LENGTH ? trimmed.slice(0, MAX_ERROR_LENGTH) : trimmed
}

function defaults(): PersistedCookieSync {
  return {
    enabled: false,
    domains: [...DEFAULT_COOKIE_DOMAINS],
    blocked: [],
    sourceProfile: DEFAULT_PROFILE,
    firstRunComplete: false,
    lastSync: null,
  }
}

function withoutOverlap(domains: string[], blocked: string[], prefer: "domains" | "blocked"): { domains: string[]; blocked: string[] } {
  if (prefer === "blocked") {
    const blockedSet = new Set(blocked)
    return { domains: domains.filter((domain) => !blockedSet.has(domain)), blocked }
  }
  const allow = new Set(domains)
  return { domains, blocked: blocked.filter((domain) => !allow.has(domain)) }
}

function sanitizePersistedInternal(raw: unknown): PersistedCookieSync {
  const base = defaults()
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return base
  const value = raw as Record<string, unknown>
  const last = value.lastSync
  let lastSync: CookieSyncStatus | null = null
  if (last && typeof last === "object" && !Array.isArray(last)) {
    const at = typeof (last as CookieSyncStatus).at === "number" ? (last as CookieSyncStatus).at : null
    const count = typeof (last as CookieSyncStatus).count === "number" ? Math.max(0, Math.floor((last as CookieSyncStatus).count)) : 0
    const error = typeof (last as CookieSyncStatus).error === "string" ? clipError((last as CookieSyncStatus).error) : undefined
    lastSync = error ? { at, count, error } : { at, count }
  }
  const domains = cleanDomains(value.domains, base.domains)
  const blocked = "blocked" in value ? cleanDomains(value.blocked, []) : [...base.blocked]
  const exclusive = withoutOverlap(domains, blocked, "domains")
  return {
    enabled: value.enabled === true,
    domains: exclusive.domains,
    blocked: exclusive.blocked,
    sourceProfile: cleanProfile(value.sourceProfile, base.sourceProfile),
    firstRunComplete: value.firstRunComplete === true,
    lastSync,
  }
}

function readFilePersisted(env: NodeJS.ProcessEnv): PersistedCookieSync | null {
  try {
    return sanitizePersisted(JSON.parse(readFileSync(settingsPath(env), "utf8")))
  } catch {
    return null
  }
}

function writeFilePersisted(next: PersistedCookieSync, env: NodeJS.ProcessEnv): void {
  const path = settingsPath(env)
  mkdirSync(stateDir(env), { recursive: true })
  const temporary = `${path}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`
  try {
    writeFileSync(
      temporary,
      JSON.stringify(
        {
          enabled: next.enabled,
          domains: next.domains,
          blocked: next.blocked,
          sourceProfile: next.sourceProfile,
          firstRunComplete: next.firstRunComplete,
          lastSync: next.lastSync,
        },
        null,
        2,
      ),
      { mode: 0o600 },
    )
    renameSync(temporary, path)
  } catch (error) {
    try {
      rmSync(temporary, { force: true })
    } catch {
      /* ignore */
    }
    throw error
  }
}

function mapSourceScheme(value: unknown): "Unset" | "NonSecure" | "Secure" | undefined {
  const n = typeof value === "number" ? value : typeof value === "bigint" ? Number(value) : Number.NaN
  if (n === 0) return "Unset"
  if (n === 1) return "NonSecure"
  if (n === 2) return "Secure"
  return undefined
}

function asBytes(value: ChromeCookieRow["encrypted_value"]): Uint8Array | null {
  if (!value) return null
  if (value instanceof Uint8Array) return value
  if (typeof value === "string") return Buffer.from(value, "binary")
  return null
}

function asNumber(value: number | bigint | null | undefined): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "bigint") return Number(value)
  return null
}

async function defaultSecurityCli(): Promise<string> {
  const child = Bun.spawn(
    ["security", "find-generic-password", "-wa", "Chrome", "-s", "Chrome Safe Storage"],
    { stdout: "pipe", stderr: "pipe" },
  )
  const [exitCode, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()])
  if (exitCode !== 0) throw new Error("Keychain access denied")
  const secret = stdout.endsWith("\n") ? stdout.slice(0, -1) : stdout
  if (!secret) throw new Error("Keychain access denied")
  return secret
}

async function cdpCall(wsUrl: string, method: string, params: unknown, timeoutMs = CDP_TIMEOUT_MS): Promise<unknown> {
  return await new Promise((resolve, reject) => {
    let settled = false
    const socket = new WebSocket(wsUrl)
    const timer = setTimeout(() => finish(new Error("CDP timeout")), timeoutMs)
    const finish = (error?: Error, result?: unknown) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        socket.close()
      } catch {
        /* ignore */
      }
      if (error) reject(error)
      else resolve(result)
    }
    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({ id: 1, method, params }))
    })
    socket.addEventListener("message", (event) => {
      try {
        const message = JSON.parse(String(event.data)) as { id?: unknown; error?: unknown; result?: unknown }
        if (message.id !== 1) return
        if (message.error) finish(new Error("Could not inject cookies into the browser pane"))
        else finish(undefined, message.result)
      } catch {
        finish(new Error("Could not inject cookies into the browser pane"))
      }
    })
    socket.addEventListener("error", () => finish(new Error("Could not inject cookies into the browser pane")))
    socket.addEventListener("close", () => {
      if (!settled) finish(new Error("Could not inject cookies into the browser pane"))
    })
  })
}

async function defaultInjectCookies(
  port: number,
  cookies: CdpCookie[],
  fetchImpl: typeof fetch,
): Promise<void> {
  const response = await fetchImpl(`http://127.0.0.1:${port}/json/version`, {
    signal: AbortSignal.timeout(VERSION_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error("Could not inject cookies into the browser pane")
  const body: unknown = await response.json()
  const wsUrl =
    body && typeof body === "object" ? (body as { webSocketDebuggerUrl?: unknown }).webSocketDebuggerUrl : undefined
  if (typeof wsUrl !== "string" || !wsUrl.startsWith("ws")) {
    throw new Error("Could not inject cookies into the browser pane")
  }
  await cdpCall(wsUrl, "Storage.setCookies", { cookies })
}

function copyCookieDb(sourceDir: string): string {
  const dest = mkdtempSync(join(tmpdir(), "chunky-cookies-"))
  try {
    for (const name of ["Cookies", "Cookies-wal", "Cookies-journal"]) {
      const from = join(sourceDir, name)
      if (existsSync(from)) copyFileSync(from, join(dest, name))
    }
  } catch (error) {
    rmSync(dest, { recursive: true, force: true })
    throw error
  }
  if (!existsSync(join(dest, "Cookies"))) {
    rmSync(dest, { recursive: true, force: true })
    throw new Error("Chrome not installed")
  }
  return dest
}

function readChromeRows(profileDir: string): ChromeCookieRow[] {
  const copyDir = copyCookieDb(profileDir)
  const dbPath = join(copyDir, "Cookies")
  let db: Database | undefined
  try {
    db = new Database(dbPath, { readonly: true })
    const columns = new Set(
      (db.query("PRAGMA table_info(cookies)").all() as Array<{ name?: string }>).map((column) => column.name),
    )
    const accessSelect = columns.has("last_access_utc") ? "last_access_utc" : "0 AS last_access_utc"
    return db
      .query(
        `SELECT host_key, name, encrypted_value, path, expires_utc, is_secure, is_httponly,
                samesite, has_expires, is_persistent, source_scheme, source_port, ${accessSelect}
         FROM cookies`,
      )
      .all() as ChromeCookieRow[]
  } finally {
    try {
      db?.close()
    } catch {
      /* ignore */
    }
    rmSync(copyDir, { recursive: true, force: true })
  }
}

function toCdpCookie(row: ChromeCookieRow, secret: string): CdpCookie | null {
  if (!row.name || typeof row.host_key !== "string") return null
  if (!row.has_expires || !row.is_persistent) return null
  const expiresUtc = asNumber(row.expires_utc)
  if (expiresUtc == null || expiresUtc <= 0) return null
  const bytes = asBytes(row.encrypted_value)
  if (!bytes) return null
  let value: string
  try {
    value = decryptChromeV10(bytes, secret, row.host_key)
  } catch {
    return null
  }
  const cookie: CdpCookie = {
    name: row.name,
    value,
    domain: row.host_key,
    path: typeof row.path === "string" && row.path ? row.path : "/",
    secure: !!row.is_secure,
    httpOnly: !!row.is_httponly,
    expires: chromeExpiresToUnixSeconds(expiresUtc),
  }
  const sameSite = mapChromeSameSite(row.samesite)
  if (sameSite) cookie.sameSite = sameSite
  const sourceScheme = mapSourceScheme(row.source_scheme)
  if (sourceScheme) cookie.sourceScheme = sourceScheme
  const sourcePort = asNumber(row.source_port)
  if (sourcePort != null && sourcePort > 0) cookie.sourcePort = sourcePort
  return cookie
}

export function createCookieSyncService(deps: CookieSyncDeps): CookieSyncService {
  const fetchImpl = deps.fetch ?? fetch
  const chromeUserDataDir = deps.chromeUserDataDir ?? defaultChromeUserDataDir()
  const securityCli = deps.securityCli ?? defaultSecurityCli
  const now = deps.now ?? Date.now
  const intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS
  const env = deps.stateHome ?? process.env
  const readPersisted = deps.readPersisted ?? (() => readFilePersisted(env))
  const writePersisted =
    deps.writePersisted ??
    ((next: PersistedCookieSync) => {
      writeFilePersisted(next, env)
    })
  const injectCookies =
    deps.injectCookies ?? ((port, cookies) => defaultInjectCookies(port, cookies, fetchImpl))

  let persisted = sanitizePersisted(readPersisted())
  let timer: ReturnType<typeof setInterval> | undefined
  let flight: Promise<CookieSyncRunResult> | null = null

  const save = (next: PersistedCookieSync) => {
    persisted = next
    try {
      writePersisted(next)
    } catch {
      /* in-memory state still updates; disk is best-effort */
    }
  }

  const chromeAvailable = (profile = persisted.sourceProfile): boolean =>
    existsSync(join(chromeUserDataDir, profile, "Cookies"))

  const state = (): CookieSyncState => ({
    ok: true,
    enabled: persisted.enabled,
    domains: persisted.domains,
    blocked: persisted.blocked,
    sourceProfile: persisted.sourceProfile,
    firstRunComplete: persisted.firstRunComplete,
    chromeAvailable: chromeAvailable(),
    lastSync: persisted.lastSync,
  })

  const hostAllowed = (hostKey: string, allow: string[] | null, blocked: string[]): boolean => {
    if (blocked.some((domain) => cookieHostMatchesDomain(hostKey, domain))) return false
    if (allow == null) return true
    if (allow.length === 0) return false
    return allow.some((domain) => cookieHostMatchesDomain(hostKey, domain))
  }

  const record = (result: CookieSyncRunResult): CookieSyncRunResult => {
    const lastSync: CookieSyncStatus = result.ok
      ? { at: now(), count: result.count }
      : { at: now(), count: 0, error: clipError(result.error || "Cookie sync failed") }
    save({ ...persisted, lastSync })
    return result
  }

  const extractAndInject = async (allow: string[] | null): Promise<CookieSyncRunResult> => {
    if (!chromeAvailable()) return record({ ok: false, count: 0, error: "Chrome not installed" })

    const target = await deps.resolveTarget()
    if (!target.debuggable || target.renderer !== "cef" || !Number.isInteger(target.cdpPort) || target.cdpPort <= 0) {
      return record({ ok: false, count: 0, error: "Browser pane not open yet" })
    }

    let secret: string
    try {
      secret = await securityCli()
    } catch {
      return record({ ok: false, count: 0, error: "Keychain access denied" })
    }

    let rows: ChromeCookieRow[]
    try {
      rows = readChromeRows(join(chromeUserDataDir, persisted.sourceProfile))
    } catch {
      return record({ ok: false, count: 0, error: "Could not read Chrome cookies" })
    }

    const cookies: CdpCookie[] = []
    let encryptedSeen = 0
    for (const row of rows) {
      if (typeof row.host_key !== "string") continue
      if (!hostAllowed(row.host_key, allow, persisted.blocked)) continue
      const bytes = asBytes(row.encrypted_value)
      if (bytes && bytes.length > 0) encryptedSeen += 1
      const cookie = toCdpCookie(row, secret)
      if (cookie) cookies.push(cookie)
    }

    if (encryptedSeen > 0 && cookies.length === 0) {
      return record({ ok: false, count: 0, error: "Could not decrypt Chrome cookies" })
    }

    try {
      if (cookies.length > 0) await injectCookies(target.cdpPort, cookies)
    } catch {
      return record({ ok: false, count: 0, error: "Could not inject cookies into the browser pane" })
    }

    return record({ ok: true, count: cookies.length })
  }

  const runGuarded = async (work: () => Promise<CookieSyncRunResult>): Promise<CookieSyncRunResult> => {
    if (flight) return flight
    flight = (async () => {
      try {
        return await work()
      } catch {
        return record({ ok: false, count: 0, error: "Cookie sync failed" })
      } finally {
        flight = null
      }
    })()
    return flight
  }

  const runNow = async (): Promise<CookieSyncRunResult> => runGuarded(() => extractAndInject(persisted.domains))

  const syncDomains = async (filter: string[] | null): Promise<CookieSyncRunResult> => {
    const allow =
      Array.isArray(filter) && filter.length > 0 ? cleanDomains(filter, []) : null
    if (Array.isArray(filter) && filter.length > 0 && allow && allow.length === 0) {
      return record({ ok: false, count: 0, error: "No valid domains to sync" })
    }
    return runGuarded(() => extractAndInject(allow))
  }

  const kickIfEnabled = () => {
    if (persisted.enabled) void runNow()
  }

  const applyPolicy = (domain: string, policy: CookieDomainPolicy): PersistedCookieSync => {
    const next: PersistedCookieSync = {
      ...persisted,
      domains: persisted.domains.filter((item) => item !== domain),
      blocked: persisted.blocked.filter((item) => item !== domain),
    }
    if (policy === "continuous") {
      if (next.domains.length < MAX_DOMAINS) next.domains = [...next.domains, domain]
    } else if (policy === "block") {
      if (next.blocked.length < MAX_DOMAINS) next.blocked = [...next.blocked, domain]
    }
    return next
  }

  return {
    getState: state,
    setSettings(patch: unknown) {
      const body = patch && typeof patch === "object" && !Array.isArray(patch) ? (patch as Record<string, unknown>) : {}
      const next: PersistedCookieSync = { ...persisted }
      if ("enabled" in body) next.enabled = body.enabled === true
      if ("domains" in body) next.domains = cleanDomains(body.domains, next.domains)
      if ("blocked" in body) next.blocked = cleanDomains(body.blocked, next.blocked)
      if ("sourceProfile" in body) next.sourceProfile = cleanProfile(body.sourceProfile, next.sourceProfile)
      if ("firstRunComplete" in body) next.firstRunComplete = body.firstRunComplete === true
      const exclusive = withoutOverlap(next.domains, next.blocked, "domains" in body ? "domains" : "blocked")
      next.domains = exclusive.domains
      next.blocked = exclusive.blocked
      const enabling = next.enabled && !persisted.enabled
      save(next)
      if (enabling) kickIfEnabled()
      return state()
    },
    runNow,
    syncDomains,
    setPolicy(domain: unknown, policy: unknown) {
      const cleaned = cleanDomain(domain)
      if (!cleaned || (policy !== "continuous" && policy !== "block" && policy !== "none")) return state()
      const next = applyPolicy(cleaned, policy)
      save(next)
      if (policy === "continuous" && next.enabled) {
        const target = deps.resolveTarget()
        void target.then((resolved) => {
          if (resolved.debuggable) void syncDomains([cleaned])
        })
      }
      return state()
    },
    completeFirstRun() {
      if (!persisted.firstRunComplete) save({ ...persisted, firstRunComplete: true })
      return state()
    },
    listDomains() {
      const byDomain = new Map<string, { cookieCount: number; lastAccess: number | null }>()
      try {
        for (const row of readChromeRows(join(chromeUserDataDir, persisted.sourceProfile))) {
          if (typeof row.host_key !== "string" || !row.host_key) continue
          const domain = registrableDomain(row.host_key)
          if (!domain) continue
          const access = chromeAccessToUnixMs(asNumber(row.last_access_utc) ?? 0)
          const current = byDomain.get(domain) ?? { cookieCount: 0, lastAccess: null }
          current.cookieCount += 1
          if (access != null && (current.lastAccess == null || access > current.lastAccess)) current.lastAccess = access
          byDomain.set(domain, current)
        }
      } catch {
        /* Chrome missing or unreadable — still surface known policies */
      }
      for (const domain of persisted.domains) {
        if (!byDomain.has(domain)) byDomain.set(domain, { cookieCount: 0, lastAccess: null })
      }
      for (const domain of persisted.blocked) {
        if (!byDomain.has(domain)) byDomain.set(domain, { cookieCount: 0, lastAccess: null })
      }
      const continuous = new Set(persisted.domains)
      const blocked = new Set(persisted.blocked)
      const domains: DiscoveredDomain[] = [...byDomain.entries()].map(([domain, info]) => {
        const policy: CookieDomainPolicy = continuous.has(domain) ? "continuous" : blocked.has(domain) ? "block" : "none"
        return {
          domain,
          cookieCount: info.cookieCount,
          lastAccess: info.lastAccess,
          policy,
          known: policy !== "none",
        }
      })
      const rank = (policy: CookieDomainPolicy) => (policy === "continuous" ? 0 : policy === "block" ? 1 : 2)
      domains.sort((a, b) => {
        const knownDelta = Number(b.known) - Number(a.known)
        if (knownDelta) return knownDelta
        const policyDelta = rank(a.policy) - rank(b.policy)
        if (policyDelta) return policyDelta
        if (a.lastAccess != null && b.lastAccess != null && a.lastAccess !== b.lastAccess) return b.lastAccess - a.lastAccess
        if (a.lastAccess != null && b.lastAccess == null) return -1
        if (a.lastAccess == null && b.lastAccess != null) return 1
        if (a.cookieCount !== b.cookieCount) return b.cookieCount - a.cookieCount
        return a.domain.localeCompare(b.domain)
      })
      return { ok: true as const, domains: domains.slice(0, MAX_DISCOVERED_DOMAINS) }
    },
    listProfiles() {
      const profiles: ChromeProfile[] = []
      try {
        for (const entry of readdirSync(chromeUserDataDir, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue
          if (entry.name !== DEFAULT_PROFILE && !/^Profile \d+$/.test(entry.name)) continue
          if (entry.name.includes("..") || entry.name.includes("/") || entry.name.includes("\\")) continue
          let name = entry.name
          try {
            const prefs = JSON.parse(readFileSync(join(chromeUserDataDir, entry.name, "Preferences"), "utf8")) as {
              profile?: { name?: unknown }
            }
            if (typeof prefs.profile?.name === "string" && prefs.profile.name.trim()) name = prefs.profile.name.trim()
          } catch {
            /* id is a fine label */
          }
          profiles.push({ id: entry.name, name })
        }
      } catch {
        /* Chrome missing → empty list */
      }
      profiles.sort((a, b) => {
        if (a.id === DEFAULT_PROFILE) return -1
        if (b.id === DEFAULT_PROFILE) return 1
        return a.id.localeCompare(b.id, "en", { numeric: true })
      })
      return { ok: true, profiles }
    },
    start() {
      if (timer) return
      kickIfEnabled()
      timer = setInterval(kickIfEnabled, intervalMs)
      if (typeof timer === "object" && timer && "unref" in timer) timer.unref()
    },
    stop() {
      if (timer) clearInterval(timer)
      timer = undefined
    },
    onPaneDebuggable() {
      kickIfEnabled()
    },
  }
}
