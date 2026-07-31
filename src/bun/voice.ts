import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { stateDir } from "./connectionManager"

const VOICE_SETTINGS = "voice.json"

type VoiceSettings = { xaiApiKey?: string }
export type VoiceTokenResult =
  | { ok: true; token: string; expiresAt: number }
  | { ok: false; error: string }

function settingsPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(stateDir(env), VOICE_SETTINGS)
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
  return !!getVoiceApiKey(env)
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

/** Exchange the long-lived server-side key for a renderer-safe realtime secret. */
export async function mintVoiceToken(env: NodeJS.ProcessEnv = process.env): Promise<VoiceTokenResult> {
  const key = getVoiceApiKey(env)
  if (!key) return { ok: false, error: "xAI API key is not configured." }
  try {
    const response = await fetch("https://api.x.ai/v1/realtime/client_secrets", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
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
