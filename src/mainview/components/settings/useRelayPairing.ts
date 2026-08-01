// React binding for the relay pairing flow. All decisions live in the pure
// reducer (~/lib/relayPairing); this owns only the timers and the requests,
// mirroring how useProviderLogin drives the provider login poll.
//
// CONNECTIVITY: every network call is gated on `active` (the section passes
// "live + connected"). While inactive the hook never begins and never polls,
// and the moment connectivity is lost it clears the pairing state — including
// the QR — and stops all timers.
//
// RACES: async replies outlive the attempt that asked for them (cancel →
// re-pair, or a disconnect mid-request). Every attempt carries a generation
// number; a reply is applied only when `isCurrentAttempt` still holds, so a
// late begin/poll can never resurrect a cleared QR or a claimed/error state.
//
// The one-time QR payload lives in reducer state and nowhere else: it is never
// written to storage, never logged, and it dies with this hook.
import { useCallback, useEffect, useReducer, useRef, useState } from "react"
import { beginRelayPairing, pollRelayPairing, relayErrorMessage } from "~/lib/relayApi"
import {
  initialRelayPairing,
  isCurrentAttempt,
  isPairingExpired,
  RELAY_POLL_INTERVAL_MS,
  reduceRelayPairing,
  shouldKeepPolling,
  type RelayPairingState,
} from "~/lib/relayPairing"

export interface RelayPairingController {
  state: RelayPairingState
  /** Now-ish, refreshed once a second while a code is live (countdown). */
  now: number
  start: () => void
  reset: () => void
}

/**
 * @param active   Whether the app is connected to a live server. False =>
 *                 no requests at all, and any in-flight pairing is dropped.
 * @param onPaired Called once a phone claims the code, so the caller can
 *                 reload the (now paired) relay status.
 */
export function useRelayPairing(active: boolean, onPaired?: () => void): RelayPairingController {
  const [state, dispatch] = useReducer(reduceRelayPairing, undefined, initialRelayPairing)
  const [now, setNow] = useState(() => Date.now())

  // Interval/async callbacks close over the render that created them; read
  // live values through refs.
  const stateRef = useRef(state)
  stateRef.current = state
  const onPairedRef = useRef(onPaired)
  onPairedRef.current = onPaired
  const activeRef = useRef(active)
  activeRef.current = active
  /** Bumped by start/reset/disconnect/unmount; stamps each attempt. */
  const genRef = useRef(0)
  /** Guards against a slow poll overlapping the next tick. */
  const inFlight = useRef(false)

  /** Invalidate every in-flight begin/poll for the previous attempt. */
  const invalidate = useCallback(() => {
    genRef.current += 1
    inFlight.current = false
  }, [])

  /** True when a reply from attempt `gen` may still be applied. */
  const canApply = useCallback(
    (gen: number) => isCurrentAttempt({ gen, currentGen: genRef.current, active: activeRef.current }),
    [],
  )

  const start = useCallback(() => {
    // Never begin while disconnected/demo — the button is disabled there too,
    // but the guard belongs where the request is made.
    if (!activeRef.current) return
    invalidate()
    const gen = genRef.current
    dispatch({ type: "start" })
    void (async () => {
      try {
        const started = await beginRelayPairing()
        // Cancelled, restarted, disconnected, or unmounted while in flight:
        // drop the payload rather than display a QR nobody is waiting on.
        if (!canApply(gen)) return
        dispatch({ type: "started", start: started })
      } catch (err) {
        if (!canApply(gen)) return
        dispatch({ type: "failed", error: relayErrorMessage(err) })
      }
    })()
  }, [invalidate, canApply])

  const reset = useCallback(() => {
    invalidate()
    dispatch({ type: "reset" })
  }, [invalidate])

  // Connectivity lost: clear the QR and the rest of the pairing state at once,
  // and invalidate anything still on the wire. The poll/countdown effects below
  // also stop, because they are gated on `active`.
  useEffect(() => {
    if (active) return
    invalidate()
    if (stateRef.current.phase !== "idle") dispatch({ type: "reset" })
  }, [active, invalidate])

  // Unmount: invalidate so a reply landing afterwards does nothing.
  useEffect(() => () => invalidate(), [invalidate])

  // Poll while a code is live AND we're connected. Cleared on unmount, on any
  // phase change, and on disconnect.
  useEffect(() => {
    if (!active || state.phase !== "waiting") return
    const id = window.setInterval(() => {
      const current = stateRef.current
      if (!activeRef.current || current.phase !== "waiting") return
      if (!shouldKeepPolling(current)) {
        dispatch({ type: "timeout" })
        return
      }
      if (inFlight.current) return
      inFlight.current = true
      const gen = genRef.current
      dispatch({ type: "poll" })
      void (async () => {
        try {
          const result = await pollRelayPairing()
          if (!canApply(gen)) return
          dispatch({ type: "polled", result })
          if (result.status === "claimed") onPairedRef.current?.()
        } catch (err) {
          if (!canApply(gen)) return
          dispatch({ type: "failed", error: relayErrorMessage(err) })
        } finally {
          // Only the current attempt may release the lock; a stale reply must
          // not unblock polling for the attempt that replaced it.
          if (gen === genRef.current) inFlight.current = false
        }
      })()
    }, RELAY_POLL_INTERVAL_MS)
    return () => window.clearInterval(id)
  }, [active, state.phase, canApply])

  // Countdown ticker: also ends the wait the moment the code expires, so the
  // user isn't told to scan a code the relay has already dropped.
  useEffect(() => {
    if (!active || state.phase !== "waiting") return
    setNow(Date.now())
    const id = window.setInterval(() => {
      const stamp = Date.now()
      setNow(stamp)
      if (isPairingExpired(stateRef.current, stamp)) dispatch({ type: "timeout" })
    }, 1000)
    return () => window.clearInterval(id)
  }, [active, state.phase])

  return { state, now, start, reset }
}
