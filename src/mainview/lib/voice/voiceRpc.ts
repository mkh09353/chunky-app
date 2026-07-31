import { getRpc } from "../rpc"

export type VoiceTokenResult =
  | { ok: true; token: string; expiresAt: number }
  | { ok: false; error: string }

export async function voiceHasApiKey(): Promise<boolean> {
  try {
    const raw = await (await getRpc())?.request?.voiceHasApiKey?.()
    return !!(raw && typeof raw === "object" && (raw as { hasApiKey?: unknown }).hasApiKey === true)
  } catch {
    return false
  }
}

export async function voiceSetApiKey(apiKey: string): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const raw = await (await getRpc())?.request?.voiceSetApiKey?.({ apiKey })
    if (raw && typeof raw === "object" && (raw as { ok?: unknown }).ok === true) return { ok: true }
    return { ok: false, error: raw && typeof raw === "object" && typeof (raw as { error?: unknown }).error === "string" ? (raw as { error: string }).error : "Voice setup is unavailable." }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Voice setup failed." }
  }
}

/** Internal: gives the WebSocket only an ephemeral xAI client secret. */
export async function voiceGetToken(): Promise<VoiceTokenResult> {
  try {
    const raw = await (await getRpc())?.request?.voiceGetToken?.()
    if (!raw || typeof raw !== "object") return { ok: false, error: "Voice service is unavailable." }
    const body = raw as { ok?: unknown; token?: unknown; expiresAt?: unknown; error?: unknown }
    if (body.ok === true && typeof body.token === "string" && typeof body.expiresAt === "number") return { ok: true, token: body.token, expiresAt: body.expiresAt }
    return { ok: false, error: typeof body.error === "string" ? body.error : "Could not start voice." }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Voice service is unavailable." }
  }
}
