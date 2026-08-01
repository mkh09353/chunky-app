// The relay pairing state machine — pure, so the whole flow (including the
// rules that clear the one-time QR payload) is testable without React or a
// server.
//
// PAYLOAD HYGIENE, enforced here rather than in the component: `qrPayload`
// holds a one-time pairing secret. It exists only while the phone still needs
// to scan it, and EVERY terminal transition (claimed, expired, error, reset)
// drops it. Nothing in this module persists or logs it.
import type { RelayPairingStart, RelayPeer, RelayPollResult } from "./relayApi"

/** Poll cadence, matching the provider-login flow's 2s tick. */
export const RELAY_POLL_INTERVAL_MS = 2000
/**
 * Backstop only — `expiresAt` from the server is the real clock.
 *
 * The canonical pairing TTL is 10 minutes, so this cap sits DELIBERATELY past
 * it (330 × 2s = 11 minutes): a shorter cap would give up on a code the relay
 * still considers valid. It exists solely for a poll route that never reports
 * expiry, and should always be reached after `expiresAt`, never before.
 */
export const RELAY_MAX_POLL_ATTEMPTS = 330

export type RelayPairingPhase =
  | "idle"
  | "starting"
  | "waiting"
  | "claimed"
  | "expired"
  | "error"

export interface RelayPairingState {
  phase: RelayPairingPhase
  /** The one-time pairing string. Non-null ONLY while phase === "waiting". */
  qrPayload: string | null
  /** Relay this pairing runs against (shown so the user knows where it goes). */
  relayUrl: string | null
  /** This computer's display name, as the phone will list it. */
  name: string | null
  /** Epoch ms when the pairing code dies. */
  expiresAt: number | null
  /** Set once a phone claims the code. */
  peer: RelayPeer | null
  error: string | null
  /** Poll ticks spent on this attempt (drives the timeout backstop). */
  attempts: number
}

export type RelayPairingEvent =
  /** The user asked to pair; the begin request is in flight. */
  | { type: "start" }
  /** begin resolved — the QR can be shown. */
  | { type: "started"; start: RelayPairingStart }
  /** One poll tick fired. */
  | { type: "poll" }
  /** A poll resolved. */
  | { type: "polled"; result: RelayPollResult }
  /** begin (or a poll) failed hard. */
  | { type: "failed"; error: string }
  /** The attempt cap or `expiresAt` ran out. */
  | { type: "timeout" }
  /** Dismiss/retry — back to a clean slate. */
  | { type: "reset" }

export function initialRelayPairing(): RelayPairingState {
  return {
    phase: "idle",
    qrPayload: null,
    relayUrl: null,
    name: null,
    expiresAt: null,
    peer: null,
    error: null,
    attempts: 0,
  }
}

/** Every terminal transition funnels through here so the payload can never
 *  outlive the wait — there is exactly one place that decides this. */
function settle(
  state: RelayPairingState,
  phase: Extract<RelayPairingPhase, "claimed" | "expired" | "error">,
  extra: { peer?: RelayPeer | null; error?: string | null } = {},
): RelayPairingState {
  return {
    ...state,
    phase,
    qrPayload: null,
    expiresAt: null,
    peer: extra.peer ?? null,
    error: extra.error ?? null,
  }
}

export function reduceRelayPairing(
  state: RelayPairingState,
  event: RelayPairingEvent,
): RelayPairingState {
  switch (event.type) {
    case "start":
      return { ...initialRelayPairing(), phase: "starting" }

    case "started":
      // A late `started` after the user cancelled must not resurrect the QR.
      if (state.phase !== "starting") return state
      return {
        ...state,
        phase: "waiting",
        qrPayload: event.start.qrPayload,
        relayUrl: event.start.relayUrl,
        name: event.start.name,
        expiresAt: event.start.expiresAt,
        peer: null,
        error: null,
        attempts: 0,
      }

    case "poll":
      if (state.phase !== "waiting") return state
      return { ...state, attempts: state.attempts + 1 }

    case "polled": {
      // Ignore anything that arrives after we stopped waiting.
      if (state.phase !== "waiting") return state
      switch (event.result.status) {
        case "pending":
          return { ...state, expiresAt: event.result.expiresAt }
        case "claimed":
          return settle(state, "claimed", { peer: event.result.peer })
        case "expired":
          return settle(state, "expired")
        case "error":
          return settle(state, "error", { error: event.result.error })
      }
      return state
    }

    case "failed":
      if (state.phase !== "starting" && state.phase !== "waiting") return state
      return settle(state, "error", { error: event.error })

    case "timeout":
      if (state.phase !== "waiting") return state
      return settle(state, "expired")

    case "reset":
      return initialRelayPairing()
  }
}

/** True once the server-declared expiry has passed. */
export function isPairingExpired(state: RelayPairingState, now: number): boolean {
  return state.expiresAt !== null && now >= state.expiresAt
}

/** Whole seconds left before expiry, floored at 0 (drives the countdown). */
export function secondsUntilExpiry(expiresAt: number | null, now: number): number {
  if (expiresAt === null) return 0
  return Math.max(0, Math.ceil((expiresAt - now) / 1000))
}

/** mm:ss for the countdown label. */
export function formatCountdown(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds))
  const mins = Math.floor(safe / 60)
  const secs = safe % 60
  return `${mins}:${secs.toString().padStart(2, "0")}`
}

/** Should the caller keep polling? Encapsulates the attempt cap. */
export function shouldKeepPolling(state: RelayPairingState): boolean {
  return state.phase === "waiting" && state.attempts < RELAY_MAX_POLL_ATTEMPTS
}

/**
 * May an in-flight begin/poll response still be applied?
 *
 * Async replies outlive the attempt that asked for them: the user cancels and
 * re-pairs, or the server connection drops, while a request is on the wire. A
 * reply is applied ONLY when it belongs to the current attempt (`gen`) and the
 * app is still connected — otherwise a stale reply could resurrect a QR that
 * was deliberately cleared, or report "claimed" for an attempt nobody is
 * watching. Pure so the rule is testable without React.
 */
export function isCurrentAttempt(input: {
  gen: number
  currentGen: number
  active: boolean
}): boolean {
  return input.active && input.gen === input.currentGen
}
