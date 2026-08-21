import { afterEach, expect, test } from "bun:test"
import { createCipheriv, createHash, pbkdf2Sync } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Database } from "bun:sqlite"
import { DEFAULT_COOKIE_DOMAINS } from "../shared/cookieSync"
import {
  chromeExpiresToUnixSeconds,
  cookieHostMatchesDomain,
  createCookieSyncService,
  decryptChromeV10,
  mapChromeSameSite,
  type CdpCookie,
  type CookieSyncDeps,
  type CookieSyncTarget,
  type PersistedCookieSync,
} from "./cookieSync"

const paths: string[] = []
afterEach(() => {
  for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true })
})

const V10 = Buffer.from("v10")
const IV = Buffer.alloc(16, 0x20)
const SECRET = "test-chrome-safe-storage"

function encryptV10(plain: string | Buffer, secret = SECRET): Buffer {
  const key = pbkdf2Sync(secret, "saltysalt", 1003, 16, "sha1")
  const cipher = createCipheriv("aes-128-cbc", key, IV)
  const payload = typeof plain === "string" ? Buffer.from(plain, "utf8") : plain
  return Buffer.concat([V10, cipher.update(payload), cipher.final()])
}

function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  paths.push(dir)
  return dir
}

function writeCookieDb(
  profileDir: string,
  rows: Array<{
    host_key: string
    name: string
    value: string
    path?: string
    expires_utc?: number
    is_secure?: number
    is_httponly?: number
    samesite?: number
    has_expires?: number
    is_persistent?: number
    source_scheme?: number
    source_port?: number
  }>,
) {
  mkdirSync(profileDir, { recursive: true })
  const db = new Database(join(profileDir, "Cookies"))
  db.run(`CREATE TABLE cookies (
    host_key TEXT, name TEXT, encrypted_value BLOB, path TEXT, expires_utc INTEGER,
    is_secure INTEGER, is_httponly INTEGER, samesite INTEGER, has_expires INTEGER,
    is_persistent INTEGER, source_scheme INTEGER, source_port INTEGER
  )`)
  const insert = db.prepare(
    `INSERT INTO cookies VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const yearFromNow = Math.round((Date.now() / 1000 + 365 * 24 * 3600 + 11_644_473_600) * 1e6)
  for (const row of rows) {
    insert.run(
      row.host_key,
      row.name,
      encryptV10(row.value),
      row.path ?? "/",
      row.expires_utc ?? yearFromNow,
      row.is_secure ?? 1,
      row.is_httponly ?? 1,
      row.samesite ?? 1,
      row.has_expires ?? 1,
      row.is_persistent ?? 1,
      row.source_scheme ?? 2,
      row.source_port ?? 443,
    )
  }
  db.close()
}

function harness(over: Partial<CookieSyncDeps> & { target?: CookieSyncTarget } = {}) {
  const home = scratch("chunky-cs-state-")
  const chrome = scratch("chunky-cs-chrome-")
  const injected: CdpCookie[][] = []
  let store: PersistedCookieSync | null = null
  const target: CookieSyncTarget = over.target ?? { cdpPort: 9222, renderer: "cef", debuggable: true }
  const service = createCookieSyncService({
    resolveTarget: async () => target,
    chromeUserDataDir: chrome,
    securityCli: async () => SECRET,
    readPersisted: () => store,
    writePersisted: (next) => {
      store = next
    },
    injectCookies: async (_port, cookies) => {
      injected.push(cookies)
    },
    intervalMs: 60_000,
    now: () => 1_700_000_000_000,
    stateHome: { CHUNKY_HOME: home },
    ...over,
  })
  return { service, injected, chrome, home, store: () => store }
}

test("v10 decrypt strips SHA256(host_key) prefix from current Chrome cookies", () => {
  const hostKey = "mail.google.com"
  const prefix = createHash("sha256").update(hostKey).digest()
  const blob = encryptV10(Buffer.concat([prefix, Buffer.from("80000", "utf8")]))
  expect(decryptChromeV10(blob, SECRET, hostKey)).toBe("80000")
})

test("v10 decrypt leaves legacy cookies without a host-hash prefix unchanged", () => {
  const blob = encryptV10("SID=abc.123")
  expect(decryptChromeV10(blob, SECRET, ".google.com")).toBe("SID=abc.123")
})

test("Chrome epoch microseconds convert to unix seconds", () => {
  expect(chromeExpiresToUnixSeconds(13_344_473_600_000_000)).toBe(1_700_000_000)
})

test("samesite mapping", () => {
  expect(mapChromeSameSite(-1)).toBeUndefined()
  expect(mapChromeSameSite(undefined)).toBeUndefined()
  expect(mapChromeSameSite(0)).toBe("None")
  expect(mapChromeSameSite(1)).toBe("Lax")
  expect(mapChromeSameSite(2)).toBe("Strict")
})

test("domain-suffix filtering matches subdomains, not lookalikes", () => {
  expect(cookieHostMatchesDomain(".accounts.google.com", "google.com")).toBe(true)
  expect(cookieHostMatchesDomain("google.com", "google.com")).toBe(true)
  expect(cookieHostMatchesDomain(".google.com", "google.com")).toBe(true)
  expect(cookieHostMatchesDomain("evilgoogle.com", "google.com")).toBe(false)
  expect(cookieHostMatchesDomain("notgoogle.com", "google.com")).toBe(false)
  expect(cookieHostMatchesDomain("youtube.com", "google.com")).toBe(false)
})

test("pane not debuggable returns ok:false and does not throw", async () => {
  const { service, injected, chrome } = harness({
    target: { cdpPort: 54321, renderer: "cef", debuggable: false },
  })
  writeCookieDb(join(chrome, "Default"), [{ host_key: ".google.com", name: "SID", value: "secret" }])
  const result = await service.runNow()
  expect(result).toEqual({ ok: false, count: 0, error: "Browser pane not open yet" })
  expect(injected).toEqual([])
  expect(service.getState().lastSync).toEqual({
    at: 1_700_000_000_000,
    count: 0,
    error: "Browser pane not open yet",
  })
})

test("runNow decrypts, filters, and injects via the fake CDP sender", async () => {
  const { service, injected, chrome } = harness()
  writeCookieDb(join(chrome, "Default"), [
    { host_key: ".accounts.google.com", name: "SID", value: "keep-me", samesite: 2 },
    { host_key: "evilgoogle.com", name: "nope", value: "skip" },
    { host_key: ".youtube.com", name: "VISITOR", value: "yt", samesite: 1 },
    { host_key: ".google.com", name: "session", value: "ephemeral", has_expires: 0, is_persistent: 0 },
  ])
  const result = await service.runNow()
  expect(result.ok).toBe(true)
  expect(result.count).toBe(2)
  expect(injected).toHaveLength(1)
  const names = injected[0]!.map((cookie) => cookie.name).sort()
  expect(names).toEqual(["SID", "VISITOR"])
  const sid = injected[0]!.find((cookie) => cookie.name === "SID")!
  expect(sid.value).toBe("keep-me")
  expect(sid.domain).toBe(".accounts.google.com")
  expect(sid.sameSite).toBe("Strict")
  expect(sid.httpOnly).toBe(true)
  expect(sid.secure).toBe(true)
  expect(service.getState().lastSync).toEqual({ at: 1_700_000_000_000, count: 2 })
})

test("setSettings persists a bounded allowlist and kicks a sync when enabling", async () => {
  const { service, injected, chrome } = harness()
  writeCookieDb(join(chrome, "Default"), [{ host_key: ".youtube.com", name: "VISITOR", value: "yt" }])
  const state = service.setSettings({
    enabled: true,
    domains: ["YouTube.com", ".youtube.com", "not a host", "../etc", "a".repeat(400)],
    sourceProfile: "Default",
  })
  expect(state.enabled).toBe(true)
  expect(state.domains).toEqual(["youtube.com"])
  expect(state.ok).toBe(true)
  await service.runNow()
  expect(injected.at(-1)?.map((cookie) => cookie.name)).toEqual(["VISITOR"])
})

test("listProfiles reads Preferences names and skips junk dirs", () => {
  const { service, chrome } = harness()
  mkdirSync(join(chrome, "Default"), { recursive: true })
  writeFileSync(join(chrome, "Default", "Preferences"), JSON.stringify({ profile: { name: "Person 1" } }))
  mkdirSync(join(chrome, "Profile 2"), { recursive: true })
  writeFileSync(join(chrome, "Profile 2", "Preferences"), JSON.stringify({ profile: { name: "Work" } }))
  mkdirSync(join(chrome, "System Profile"), { recursive: true })
  mkdirSync(join(chrome, "Crashpad"), { recursive: true })
  expect(service.listProfiles()).toEqual({
    ok: true,
    profiles: [
      { id: "Default", name: "Person 1" },
      { id: "Profile 2", name: "Work" },
    ],
  })
})

test("getState reports chromeAvailable and default domains without reading cookies", () => {
  const { service, chrome } = harness()
  expect(service.getState()).toMatchObject({
    ok: true,
    enabled: false,
    domains: [...DEFAULT_COOKIE_DOMAINS],
    sourceProfile: "Default",
    chromeAvailable: false,
    lastSync: null,
  })
  writeCookieDb(join(chrome, "Default"), [{ host_key: ".google.com", name: "SID", value: "x" }])
  expect(service.getState().chromeAvailable).toBe(true)
})

test("overlapping runNow shares one in-flight attempt", async () => {
  let resolveInject: (() => void) | undefined
  const gate = new Promise<void>((resolve) => {
    resolveInject = resolve
  })
  const { service, injected, chrome } = harness({
    injectCookies: async (_port, cookies) => {
      injected.push(cookies)
      await gate
    },
  })
  writeCookieDb(join(chrome, "Default"), [{ host_key: ".google.com", name: "SID", value: "one" }])
  const first = service.runNow()
  const second = service.runNow()
  for (let i = 0; i < 20 && injected.length === 0; i += 1) await Promise.resolve()
  expect(injected).toHaveLength(1)
  resolveInject?.()
  expect(await first).toEqual(await second)
  expect(injected).toHaveLength(1)
})

test("file persistence writes cookieSync.json without cookie values", () => {
  const home = scratch("chunky-cs-file-")
  const chrome = scratch("chunky-cs-chrome-file-")
  writeCookieDb(join(chrome, "Default"), [{ host_key: ".google.com", name: "SID", value: "must-not-persist" }])
  const service = createCookieSyncService({
    resolveTarget: async () => ({ cdpPort: 9222, renderer: "cef", debuggable: true }),
    chromeUserDataDir: chrome,
    securityCli: async () => SECRET,
    injectCookies: async () => {},
    stateHome: { CHUNKY_HOME: home },
  })
  service.setSettings({ enabled: false, domains: ["google.com"] })
  const raw = readFileSync(join(home, "cookieSync.json"), "utf8")
  expect(raw).not.toContain("must-not-persist")
  expect(raw).not.toContain(SECRET)
  expect(JSON.parse(raw)).toMatchObject({ enabled: false, domains: ["google.com"], sourceProfile: "Default" })
})
