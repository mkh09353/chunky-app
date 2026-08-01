import { expect, test } from "bun:test"
import type { RelayPairingStart } from "./relayApi"
import {
  formatCountdown,
  initialRelayPairing,
  isCurrentAttempt,
  isPairingExpired,
  RELAY_MAX_POLL_ATTEMPTS,
  RELAY_POLL_INTERVAL_MS,
  reduceRelayPairing,
  secondsUntilExpiry,
  shouldKeepPolling,
  type RelayPairingEvent,
  type RelayPairingState,
} from "./relayPairing"

const START: RelayPairingStart = {
  qrPayload: "chunky1:PAYLOAD",
  relayUrl: "https://relay.chunky.to",
  name: "Maxs-MacBook-Pro",
  expiresAt: 10_000,
}

/** Fold a list of events from the initial state. */
function run(...events: RelayPairingEvent[]): RelayPairingState {
  return events.reduce(reduceRelayPairing, initialRelayPairing())
}

const waiting = () => run({ type: "start" }, { type: "started", start: START })

test("starts idle and moves through starting -> waiting with the QR", () => {
  const idle = initialRelayPairing()
  expect(idle.phase).toBe("idle")
  expect(idle.qrPayload).toBe(null)

  expect(run({ type: "start" }).phase).toBe("starting")

  const state = waiting()
  expect(state.phase).toBe("waiting")
  expect(state.qrPayload).toBe("chunky1:PAYLOAD")
  expect(state.relayUrl).toBe("https://relay.chunky.to")
  expect(state.name).toBe("Maxs-MacBook-Pro")
  expect(state.expiresAt).toBe(10_000)
  expect(state.error).toBe(null)
})

test("pending polls keep the QR and refresh the expiry", () => {
  const state = reduceRelayPairing(waiting(), {
    type: "polled",
    result: { status: "pending", expiresAt: 20_000 },
  })
  expect(state.phase).toBe("waiting")
  expect(state.qrPayload).toBe("chunky1:PAYLOAD")
  expect(state.expiresAt).toBe(20_000)
})

test("HYGIENE: every terminal transition clears the one-time payload", () => {
  const claimed = reduceRelayPairing(waiting(), {
    type: "polled",
    result: { status: "claimed", peer: { deviceId: "d1", name: "Max's iPhone" } },
  })
  expect(claimed.phase).toBe("claimed")
  expect(claimed.qrPayload).toBe(null)
  expect(claimed.expiresAt).toBe(null)
  expect(claimed.peer).toEqual({ deviceId: "d1", name: "Max's iPhone" })

  const expired = reduceRelayPairing(waiting(), { type: "polled", result: { status: "expired" } })
  expect(expired.phase).toBe("expired")
  expect(expired.qrPayload).toBe(null)

  const errored = reduceRelayPairing(waiting(), {
    type: "polled",
    result: { status: "error", error: "relay unreachable" },
  })
  expect(errored.phase).toBe("error")
  expect(errored.qrPayload).toBe(null)
  expect(errored.error).toBe("relay unreachable")

  const failed = reduceRelayPairing(waiting(), { type: "failed", error: "network down" })
  expect(failed.phase).toBe("error")
  expect(failed.qrPayload).toBe(null)

  const timedOut = reduceRelayPairing(waiting(), { type: "timeout" })
  expect(timedOut.phase).toBe("expired")
  expect(timedOut.qrPayload).toBe(null)

  for (const terminal of [claimed, expired, errored, failed, timedOut]) {
    expect(reduceRelayPairing(terminal, { type: "reset" })).toEqual(initialRelayPairing())
  }
})

test("a begin failure while starting surfaces as an error", () => {
  const state = run({ type: "start" }, { type: "failed", error: "begin failed" })
  expect(state.phase).toBe("error")
  expect(state.error).toBe("begin failed")
  expect(state.qrPayload).toBe(null)
})

test("late responses cannot resurrect a finished or cancelled pairing", () => {
  // started arriving after a reset must not show a QR again.
  const afterReset = run({ type: "start" }, { type: "reset" }, { type: "started", start: START })
  expect(afterReset.phase).toBe("idle")
  expect(afterReset.qrPayload).toBe(null)

  // a poll landing after a claim must not move it back to waiting.
  const claimed = reduceRelayPairing(waiting(), {
    type: "polled",
    result: { status: "claimed", peer: { deviceId: "d1", name: "Phone" } },
  })
  const late = reduceRelayPairing(claimed, {
    type: "polled",
    result: { status: "pending", expiresAt: 99_999 },
  })
  expect(late).toEqual(claimed)
  expect(late.qrPayload).toBe(null)

  // failures and timeouts are ignored once terminal.
  expect(reduceRelayPairing(claimed, { type: "failed", error: "x" })).toEqual(claimed)
  expect(reduceRelayPairing(claimed, { type: "timeout" })).toEqual(claimed)
  // poll ticks only count while waiting.
  expect(reduceRelayPairing(claimed, { type: "poll" }).attempts).toBe(claimed.attempts)
})

test("restarting clears the previous attempt entirely", () => {
  const errored = reduceRelayPairing(waiting(), { type: "failed", error: "boom" })
  const restarted = reduceRelayPairing(errored, { type: "start" })
  expect(restarted.phase).toBe("starting")
  expect(restarted.error).toBe(null)
  expect(restarted.peer).toBe(null)
  expect(restarted.qrPayload).toBe(null)
  expect(restarted.attempts).toBe(0)
})

test("poll ticks accumulate and stop at the attempt cap", () => {
  let state = waiting()
  expect(shouldKeepPolling(state)).toBe(true)
  for (let i = 0; i < RELAY_MAX_POLL_ATTEMPTS; i++) state = reduceRelayPairing(state, { type: "poll" })
  expect(state.attempts).toBe(RELAY_MAX_POLL_ATTEMPTS)
  expect(shouldKeepPolling(state)).toBe(false)
  expect(shouldKeepPolling(initialRelayPairing())).toBe(false)
})

test("the attempt cap is a backstop BEYOND the 10-minute canonical pairing TTL", () => {
  const CANONICAL_TTL_MINUTES = 10
  const capMinutes = (RELAY_MAX_POLL_ATTEMPTS * RELAY_POLL_INTERVAL_MS) / 60_000
  // 330 x 2s = 11 minutes: the client must never give up on a code the relay
  // still considers valid, so expiresAt always wins the race.
  expect(capMinutes).toBe(11)
  expect(capMinutes).toBeGreaterThan(CANONICAL_TTL_MINUTES)
})

test("a full 10-minute TTL is pollable without tripping the cap", () => {
  const ticksForTtl = (10 * 60_000) / RELAY_POLL_INTERVAL_MS // 300
  let state = waiting()
  for (let i = 0; i < ticksForTtl; i++) state = reduceRelayPairing(state, { type: "poll" })
  expect(state.phase).toBe("waiting")
  expect(shouldKeepPolling(state)).toBe(true)
})

test("isCurrentAttempt: only a live attempt on a connected app may be applied", () => {
  // The current attempt while connected -> apply.
  expect(isCurrentAttempt({ gen: 3, currentGen: 3, active: true })).toBe(true)
  // Superseded by a cancel/restart (generation moved on) -> drop.
  expect(isCurrentAttempt({ gen: 2, currentGen: 3, active: true })).toBe(false)
  // Disconnected mid-flight -> drop, even for the current generation.
  expect(isCurrentAttempt({ gen: 3, currentGen: 3, active: false })).toBe(false)
  expect(isCurrentAttempt({ gen: 2, currentGen: 3, active: false })).toBe(false)
})

test("expiry helpers drive the countdown", () => {
  const state = waiting()
  expect(isPairingExpired(state, 9_999)).toBe(false)
  expect(isPairingExpired(state, 10_000)).toBe(true)
  expect(isPairingExpired(initialRelayPairing(), 10_000)).toBe(false)

  expect(secondsUntilExpiry(10_000, 0)).toBe(10)
  expect(secondsUntilExpiry(10_000, 9_500)).toBe(1)
  expect(secondsUntilExpiry(10_000, 10_500)).toBe(0)
  expect(secondsUntilExpiry(null, 0)).toBe(0)

  expect(formatCountdown(0)).toBe("0:00")
  expect(formatCountdown(9)).toBe("0:09")
  expect(formatCountdown(65)).toBe("1:05")
  expect(formatCountdown(600)).toBe("10:00")
  expect(formatCountdown(-5)).toBe("0:00")
})
