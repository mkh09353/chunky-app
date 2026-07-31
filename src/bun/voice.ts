import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { stateDir } from "./connectionManager"

const VOICE_SETTINGS = "voice.json"
const AUTH_SETTINGS = "auth.json"
const XAI_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828"
const TOKEN_URL = "https://auth.x.ai/oauth2/token"
const REFRESH_SKEW_MS = 120_000

type VoiceSettings = { xaiApiKey?: string }
type GrokOAuth = { type: "oauth"; access: string; refresh: string; expires: number }
type AuthSettings = Record<string, unknown> & { grok?: GrokOAuth }
export type VoiceTokenResult =
  | { ok: true; token: string; expiresAt: number }
  | { ok: false; error: string }

function settingsPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(stateDir(env), VOICE_SETTINGS)
}

function authPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.CHUNKY_AUTH || join(stateDir(env), AUTH_SETTINGS)
}

function grokOAuth(env: NodeJS.ProcessEnv = process.env): GrokOAuth | undefined {
  try {
    const parsed = JSON.parse(readFileSync(authPath(env), "utf8")) as AuthSettings
    const auth = parsed.grok
    return auth && auth.type === "oauth" && typeof auth.access === "string" && typeof auth.refresh === "string" && typeof auth.expires === "number"
      ? auth
      : undefined
  } catch {
    return undefined
  }
}

/** Re-read immediately before writing so another provider's credentials survive. */
export function mergeGrokOAuth(auth: GrokOAuth, env: NodeJS.ProcessEnv = process.env): void {
  const path = authPath(env)
  let all: AuthSettings = {}
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"))
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) all = parsed as AuthSettings
  } catch {}
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, JSON.stringify({ ...all, grok: auth }, null, 2), { mode: 0o600 })
  renameSync(temp, path)
}

function savedKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
  try {
    const data = JSON.parse(readFileSync(settingsPath(env), "utf8")) as VoiceSettings
    return typeof data.xaiApiKey === "string" && data.xaiApiKey.trim() ? data.xaiApiKey.trim() : undefined
  } catch {
    return undefined
  }
}

/** Environment credentials win so managed deployments never persist their key. */
export function getVoiceApiKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.XAI_API_KEY?.trim() || savedKey(env)
}

export function hasVoiceApiKey(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!getVoiceApiKey(env) || !!grokOAuth(env)
}

/** Persist only the provider credential, outside renderer-accessible assets. */
export function setVoiceApiKey(raw: unknown, env: NodeJS.ProcessEnv = process.env): { ok: true } | { ok: false; error: string } {
  const key = typeof raw === "string" ? raw.trim() : ""
  if (!key || key.length > 4096 || key.includes("\0")) return { ok: false, error: "A valid xAI API key is required." }
  try {
    const path = settingsPath(env)
    mkdirSync(dirname(path), { recursive: true })
    const temp = `${path}.${process.pid}.tmp`
    writeFileSync(temp, JSON.stringify({ xaiApiKey: key }, null, 2), { mode: 0o600 })
    renameSync(temp, path)
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Could not save xAI API key." }
  }
}

async function mintClientSecret(credential: string): Promise<VoiceTokenResult> {
  try {
    const response = await fetch("https://api.x.ai/v1/realtime/client_secrets", {
      method: "POST",
      headers: { Authorization: `Bearer ${credential}`, "Content-Type": "application/json" },
      body: JSON.stringify({ expires_after: { seconds: 3600 } }),
    })
    const body = await response.json().catch(() => ({})) as { value?: unknown; expires_at?: unknown; error?: { message?: unknown } }
    if (!response.ok) {
      const detail = typeof body.error?.message === "string" ? body.error.message : `xAI token request failed (${response.status})`
      return { ok: false, error: detail }
    }
    if (typeof body.value !== "string" || !body.value || typeof body.expires_at !== "number") {
      return { ok: false, error: "xAI returned an invalid realtime token." }
    }
    return { ok: true, token: body.value, expiresAt: body.expires_at }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Could not contact xAI." }
  }
}

let cachedOAuth: GrokOAuth | undefined
let refreshFlight: Promise<GrokOAuth> | undefined

function expiresSoon(auth: GrokOAuth): boolean {
  return !auth.expires || auth.expires - Date.now() <= REFRESH_SKEW_MS
}

async function refreshGrokOAuth(auth: GrokOAuth, env: NodeJS.ProcessEnv): Promise<GrokOAuth> {
  if (!expiresSoon(auth)) return auth
  if (!refreshFlight) {
    refreshFlight = (async () => {
      const form = new URLSearchParams({ grant_type: "refresh_token", refresh_token: auth.refresh, client_id: XAI_CLIENT_ID })
      const response = await fetch(TOKEN_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" }, body: form })
      const body = await response.json().catch(() => ({})) as { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown; error_description?: unknown; error?: unknown }
      if (!response.ok || typeof body.access_token !== "string" || !body.access_token) {
        const detail = typeof body.error_description === "string" ? body.error_description : typeof body.error === "string" ? body.error : `OAuth refresh failed (${response.status})`
        throw new Error(detail)
      }
      const seconds = typeof body.expires_in === "number" && body.expires_in > 0 ? body.expires_in : 3600
      const fresh: GrokOAuth = { type: "oauth", access: body.access_token, refresh: typeof body.refresh_token === "string" && body.refresh_token ? body.refresh_token : auth.refresh, expires: Date.now() + seconds * 1000 }
      mergeGrokOAuth(fresh, env)
      cachedOAuth = fresh
      return fresh
    })().finally(() => { refreshFlight = undefined })
  }
  return refreshFlight
}

/** Exchange a long-lived key or Grok subscription OAuth access token for a renderer-safe realtime secret. */
export async function mintVoiceToken(env: NodeJS.ProcessEnv = process.env): Promise<VoiceTokenResult> {
  // Explicit API-key sources are intentionally terminal: an invalid configured
  // key must not silently select a different subscription identity.
  const key = getVoiceApiKey(env)
  if (key) return mintClientSecret(key)
  const oauth = cachedOAuth ?? grokOAuth(env)
  if (!oauth) return { ok: false, error: "xAI API key or Grok subscription login is not configured." }
  try {
    const fresh = await refreshGrokOAuth(oauth, env)
    cachedOAuth = fresh
    return await mintClientSecret(fresh.access)
  } catch (error) {
    return { ok: false, error: `Grok login could not be refreshed; configure an API key to use voice. ${error instanceof Error ? error.message : ""}`.trim() }
  }
}
