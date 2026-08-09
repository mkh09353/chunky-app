// The agent asking the DESKTOP app to collect a provider API key.
//
// `app.request_api_key` is a live-only control frame (like `app.open_url`): the
// server sends it only to attached desktop clients, never persists it and never
// replays it. It is claimed on the stream before the transcript reducer sees
// it, so the request — and the secret it leads to — can never become a
// transcript item.
//
// This module is the pure half: the parked request plus its subscribers. The UI
// half is <ApiKeyRequestHost /> (components/ApiKeyDialog.tsx), mounted once at
// the app root so the prompt appears whatever the user is looking at. Keeping
// them apart means the claim/replace rules are testable without a DOM.
//
// The key itself never passes through here. It lives in the dialog's state for
// as long as it takes to POST it, and nowhere else.

export interface ApiKeyRequest {
  requestId: string
  providerId: string
  /** Human name for the provider, for the dialog title. */
  label: string
}

type Listener = (current: ApiKeyRequest | null) => void

let current: ApiKeyRequest | null = null
const listeners = new Set<Listener>()

function emit(): void {
  for (const listener of Array.from(listeners)) listener(current)
}

/**
 * Read a request out of a server `app.request_api_key` frame, or null when this
 * is not one.
 *
 * Typed against `unknown` on purpose: the check has to survive a protocol
 * package that does not carry the variant yet (and a server that sends a
 * malformed one), so the shape is verified structurally instead of trusting the
 * union. A frame without both ids is unanswerable, so it is not a request.
 */
export function apiKeyRequestFrom(ev: unknown): ApiKeyRequest | null {
  if (!ev || typeof ev !== "object") return null
  const { type, requestId, providerId, label } = ev as {
    type?: unknown
    requestId?: unknown
    providerId?: unknown
    label?: unknown
  }
  if (type !== "app.request_api_key") return null
  if (typeof requestId !== "string" || typeof providerId !== "string") return null
  const id = requestId.trim()
  const provider = providerId.trim()
  if (!id || !provider) return null
  const name = typeof label === "string" ? label.trim() : ""
  return { requestId: id, providerId: provider, label: name || provider }
}

/**
 * Ask the user for `request`'s key.
 *
 * Newest wins: a second request replaces the one on screen rather than queuing
 * behind it. A stale prompt is worse than a dropped one here — the user would
 * be typing a key for a provider the agent has already moved on from, and the
 * abandoned request is answered by the server's own timeout.
 */
export function askForApiKey(request: ApiKeyRequest): void {
  current = request
  emit()
}

/** The request the host should be showing, if any. */
export function currentApiKeyRequest(): ApiKeyRequest | null {
  return current
}

/** Subscribe to request changes. Returns an unsubscribe. */
export function subscribeApiKeyRequests(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * Take the prompt down.
 *
 * `requestId` guards against a late answer closing a NEWER prompt: pass the id
 * the dialog was showing and the clear is ignored once it has been replaced.
 */
export function clearApiKeyRequest(requestId?: string): void {
  if (current === null) return
  if (requestId !== undefined && current.requestId !== requestId) return
  current = null
  emit()
}

/**
 * Handle an `app.request_api_key` event.
 *
 * Returns true when the event was CLAIMED, which the caller must treat as "do
 * not pass this to the transcript reducer": it is a live-only control frame,
 * never a transcript item.
 */
export function consumeApiKeyRequest(ev: unknown): boolean {
  const request = apiKeyRequestFrom(ev)
  if (request === null) return false
  askForApiKey(request)
  return true
}

/** Test-only: forget any parked request. */
export function resetApiKeyRequests(): void {
  current = null
  emit()
}
