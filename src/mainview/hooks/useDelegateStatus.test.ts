// The delegate-status poll's wiring: when it runs at all, and what one
// mount/unmount cycle of the effect actually does.
//
// There is no DOM in this runner (no happy-dom/jsdom — see
// components/LiveRun.test.tsx), so React's own scheduling is not exercised
// here. Everything the effect DOES lives in `startDelegatePolling`, which takes
// injectable timers precisely so it can be driven tick by tick; the hook body
// is a `shouldPollDelegates` gate around one call to it.
import { describe, expect, test } from "bun:test"
import type { DelegatesResult } from "~/lib/api"
import {
  DELEGATE_POLL_MS,
  shouldPollDelegates,
  startDelegatePolling,
  type IntervalTimers,
} from "./useDelegateStatus"

/** A hand-cranked interval: `tick()` is the scheduler firing. */
function fakeTimers() {
  const fns = new Map<number, () => void>()
  let next = 1
  let lastMs = 0
  const timers: IntervalTimers = {
    setInterval: (fn, ms) => {
      lastMs = ms
      const id = next++
      fns.set(id, fn)
      return id
    },
    clearInterval: (handle) => {
      fns.delete(handle as number)
    },
  }
  return {
    timers,
    tick: () => {
      for (const fn of [...fns.values()]) fn()
    },
    get live() {
      return fns.size
    },
    get intervalMs() {
      return lastMs
    },
  }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

describe("shouldPollDelegates", () => {
  const base = { baseUrl: "http://localhost:4620", sessionId: "sess-1", liveRunCount: 1 }

  test("polls only while a run is actually live", () => {
    expect(shouldPollDelegates(base)).toBe(true)
    // The common case by far: a session with nothing delegated makes NO
    // requests at all.
    expect(shouldPollDelegates({ ...base, liveRunCount: 0 })).toBe(false)
  })

  test("says no without a server, a session, or the endpoint", () => {
    expect(shouldPollDelegates({ ...base, baseUrl: null })).toBe(false)
    expect(shouldPollDelegates({ ...base, sessionId: null })).toBe(false)
    expect(shouldPollDelegates({ ...base, available: false })).toBe(false)
  })

  test("the cadence is a slow one — the stream is the real channel", () => {
    expect(DELEGATE_POLL_MS).toBe(4_000)
  })
})

describe("startDelegatePolling", () => {
  test("asks once immediately, then once per tick", async () => {
    const clock = fakeTimers()
    const seen: number[] = []
    let calls = 0
    const stop = startDelegatePolling({
      baseUrl: "http://localhost:4620",
      sessionId: "sess-1",
      intervalMs: DELEGATE_POLL_MS,
      timers: clock.timers,
      fetchDelegates: async () => {
        calls += 1
        return { status: "ok", runs: [] }
      },
      onSnapshot: () => seen.push(Date.now()),
    })
    await Promise.resolve()
    expect(calls).toBe(1)
    expect(clock.intervalMs).toBe(DELEGATE_POLL_MS)
    clock.tick()
    await Promise.resolve()
    expect(calls).toBe(2)
    expect(seen).toHaveLength(2)
    stop()
  })

  test("a tick while a request is still out does not stack a second one", async () => {
    const clock = fakeTimers()
    const gate = deferred<DelegatesResult>()
    let calls = 0
    const stop = startDelegatePolling({
      baseUrl: "http://localhost:4620",
      sessionId: "sess-1",
      intervalMs: 4_000,
      timers: clock.timers,
      fetchDelegates: () => {
        calls += 1
        return gate.promise
      },
      onSnapshot: () => {},
    })
    clock.tick()
    clock.tick()
    expect(calls).toBe(1)
    gate.resolve({ status: "ok", runs: [] })
    await gate.promise
    await Promise.resolve()
    clock.tick()
    expect(calls).toBe(2)
    stop()
  })

  test("an unsupported answer stops the poll and reports the base URL once", async () => {
    const clock = fakeTimers()
    const unsupported: string[] = []
    let calls = 0
    const stop = startDelegatePolling({
      baseUrl: "http://localhost:4620",
      sessionId: "sess-1",
      intervalMs: 4_000,
      timers: clock.timers,
      fetchDelegates: async () => {
        calls += 1
        return { status: "unsupported" }
      },
      onSnapshot: () => {},
      onUnsupported: (baseUrl) => unsupported.push(baseUrl),
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(unsupported).toEqual(["http://localhost:4620"])
    // The interval is still installed (React clears it when `available` flips),
    // but every further tick is a no-op — zero requests from here on.
    clock.tick()
    clock.tick()
    await Promise.resolve()
    expect(calls).toBe(1)
    stop()
  })

  test("teardown clears the interval and disowns the response in flight", async () => {
    const clock = fakeTimers()
    const gate = deferred<DelegatesResult>()
    const snapshots: unknown[] = []
    const stop = startDelegatePolling({
      baseUrl: "http://localhost:4620",
      sessionId: "sess-1",
      intervalMs: 4_000,
      timers: clock.timers,
      fetchDelegates: () => gate.promise,
      onSnapshot: (runs) => snapshots.push(runs),
    })
    expect(clock.live).toBe(1)
    stop()
    expect(clock.live).toBe(0)
    gate.resolve({
      status: "ok",
      runs: [
        {
          kind: "sidekick",
          threadId: "sess-1:sidekick:frontend",
          title: "Sidekick (frontend)",
          status: "running",
          elapsedMs: 1_000,
        },
      ],
    })
    await gate.promise
    await Promise.resolve()
    // A session we have moved away from must never commit onto the new one.
    expect(snapshots).toHaveLength(0)
  })
})
