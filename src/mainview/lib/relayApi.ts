// Typed client for the local server's desktop relay pairing API.
//
// Routes and DTOs come from @chunky/protocol — never forked, never invented.
// There is deliberately no unpair route (the hosted relay protocol has no
// targeted revocation), so this module exposes none.
//
// Everything the server returns passes through a MAPPER before it reaches
// React. Those mappers copy the contract's fields and nothing else: if a
// server ever grew a field carrying a device token or private key, it would be
// dropped here rather than landing in component state. That is also why the
// mappers are exported — they're the unit under test.
import { ROUTES } from "@chunky/protocol"
import type {
  RelayBeginPairingResponse,
  RelayPeerStatus,
  RelayPollPairingResponse,
  RelayStatusResponse,
} from "@chunky/protocol"
import { HttpError, jsonInit, req } from "./configApi"

// ---- View models (sanitized shapes the UI is allowed to see) --------------

export interface RelayPeer {
  deviceId: string
  name: string
}

export interface RelayStatus {
  paired: boolean
  /** false when the server booted with CHUNKY_RELAY=0. */
  enabled: boolean
  relayUrl: string | null
  peers: RelayPeer[]
}

export interface RelayPairingStart {
  /** One-time pairing string. Ephemeral: never persist, log, or copy it. */
  qrPayload: string
  relayUrl: string
  name: string
  expiresAt: number
}

export type RelayPollResult =
  | { status: "pending"; expiresAt: number }
  | { status: "claimed"; peer: RelayPeer }
  | { status: "expired" }
  | { status: "error"; error: string }

// ---- Mappers --------------------------------------------------------------

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

/** Copy ONLY deviceId + name off a peer, whatever else came with it. */
function toPeer(raw: unknown): RelayPeer | null {
  if (!raw || typeof raw !== "object") return null
  const rec = raw as Partial<RelayPeerStatus>
  const deviceId = str(rec.deviceId)
  const name = str(rec.name)
  if (!deviceId) return null
  return { deviceId, name: name ?? deviceId }
}

export function toRelayStatus(raw: unknown): RelayStatus {
  const rec = (raw ?? {}) as Partial<RelayStatusResponse>
  const peers = Array.isArray(rec.peers)
    ? rec.peers.map(toPeer).filter((p): p is RelayPeer => p !== null)
    : []
  return {
    paired: rec.paired === true,
    // Absent `enabled` means an older/leaner server: assume the uplink is on
    // rather than showing a scary "disabled" state it never claimed.
    enabled: rec.enabled !== false,
    relayUrl: str(rec.relayUrl),
    peers,
  }
}

export function toPairingStart(raw: unknown): RelayPairingStart {
  const rec = (raw ?? {}) as Partial<RelayBeginPairingResponse>
  const qrPayload = str(rec.qrPayload)
  const relayUrl = str(rec.relayUrl)
  const expiresAt = num(rec.expiresAt)
  if (!qrPayload || !relayUrl || expiresAt === null) {
    throw new Error("The server returned an incomplete pairing response.")
  }
  return { qrPayload, relayUrl, name: str(rec.name) ?? "This computer", expiresAt }
}

export function toPollResult(raw: unknown): RelayPollResult {
  const rec = (raw ?? {}) as Partial<RelayPollPairingResponse> & { status?: string }
  switch (rec.status) {
    case "pending":
      return { status: "pending", expiresAt: num((rec as { expiresAt?: unknown }).expiresAt) ?? 0 }
    case "claimed": {
      const peer = toPeer((rec as { peer?: unknown }).peer)
      // Claimed without a usable peer is still a claim — the pairing worked.
      return { status: "claimed", peer: peer ?? { deviceId: "", name: "Your phone" } }
    }
    case "expired":
      return { status: "expired" }
    case "error":
      return {
        status: "error",
        error: str((rec as { error?: unknown }).error) ?? "Pairing failed.",
      }
    default:
      return { status: "error", error: "The server returned an unknown pairing status." }
  }
}

/** A user-facing sentence for a failed relay call. */
export function relayErrorMessage(err: unknown): string {
  if (err instanceof HttpError) {
    if (err.status === 404 || err.status === 501) {
      return "This Chunky server doesn't support relay pairing yet."
    }
    return err.message || `Relay request failed (${err.status})`
  }
  return (err as Error)?.message || "Relay request failed."
}

// ---- Requests -------------------------------------------------------------

/** Current pairing state of this computer. */
export async function getRelayStatus(): Promise<RelayStatus> {
  return toRelayStatus(await req<RelayStatusResponse>(ROUTES.relay))
}

/** Start a pairing and get the QR payload to display. */
export async function beginRelayPairing(): Promise<RelayPairingStart> {
  return toPairingStart(await req<RelayBeginPairingResponse>(ROUTES.relayBegin, jsonInit("POST")))
}

/** Ask whether a phone has claimed the in-flight pairing yet. */
export async function pollRelayPairing(): Promise<RelayPollResult> {
  return toPollResult(await req<RelayPollPairingResponse>(ROUTES.relayPoll, jsonInit("POST")))
}
