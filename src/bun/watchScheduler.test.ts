// The daily watch scheduler: arming, launch catch-up, and the guarantee that
// those two can never both fire the same check. Fake clock + fake timers, so
// this suite never sleeps.
// Run with: bun test src/bun/watchScheduler.test.ts
import { describe, expect, it } from "bun:test"
import { createWatchScheduler, needsCatchUp, nextSlot, STALE_AFTER_MS } from "./watchScheduler"

const HOUR = 3_600_000

/** Local-time helper: the scheduler arms on the user's morning, not on UTC. */
function localAt(year: number, month: number, day: number, hour: number, minute = 0): number {
  return new Date(year, month, day, hour, minute, 0, 0).getTime()
}

function harness(options: { hour?: number; lastCheckAt?: number | null; start?: number; run?: () => Promise<unknown> } = {}) {
  let clock = options.start ?? localAt(2026, 0, 10, 9, 30)
  let lastCheckAt = options.lastCheckAt === undefined ? null : options.lastCheckAt
  const runs: number[] = []
  const timers: { at: number; fn: () => void }[] = []

  const scheduler = createWatchScheduler({
    state: () => ({ hour: options.hour ?? 8, lastCheckAt }),
    run: async () => {
      runs.push(clock)
      lastCheckAt = clock
      if (options.run) await options.run()
    },
    now: () => clock,
    setTimer: (ms, fn) => {
      const timer = { at: clock + ms, fn }
      timers.push(timer)
      return timer
    },
    clearTimer: (handle) => {
      const index = timers.indexOf(handle as { at: number; fn: () => void })
      if (index >= 0) timers.splice(index, 1)
    },
    onError: () => {},
  })

  return {
    scheduler,
    runs,
    timers,
    get now() {
      return clock
    },
    set now(value: number) {
      clock = value
    },
    /** Fire every timer whose moment has arrived, like a real event loop would. */
    async advanceTo(target: number) {
      clock = target
      for (let guard = 0; guard < 10; guard += 1) {
        const due = timers.filter((timer) => timer.at <= clock)
        if (!due.length) break
        for (const timer of due) {
          const index = timers.indexOf(timer)
          if (index >= 0) timers.splice(index, 1)
          timer.fn()
        }
        await Promise.resolve()
        await Promise.resolve()
        await Promise.resolve()
      }
    },
  }
}

describe("nextSlot", () => {
  it("arms the next occurrence of the configured local hour", () => {
    expect(nextSlot(8, localAt(2026, 0, 10, 6, 0))).toBe(localAt(2026, 0, 10, 8, 0))
    // Already past this morning's slot -> tomorrow's.
    expect(nextSlot(8, localAt(2026, 0, 10, 9, 30))).toBe(localAt(2026, 0, 11, 8, 0))
  })

  it("never arms a zero or negative delay, even exactly on the hour", () => {
    const onTheHour = localAt(2026, 0, 10, 8, 0)
    expect(nextSlot(8, onTheHour)).toBe(localAt(2026, 0, 11, 8, 0))
    expect(nextSlot(8, onTheHour) - onTheHour).toBeGreaterThan(0)
  })

  it("clamps a nonsense hour to the default rather than refusing to run", () => {
    expect(nextSlot(99, localAt(2026, 0, 10, 6, 0))).toBe(localAt(2026, 0, 10, 23, 0))
    expect(nextSlot(-5, localAt(2026, 0, 10, 6, 0))).toBe(localAt(2026, 0, 11, 0, 0))
    expect(nextSlot(Number.NaN, localAt(2026, 0, 10, 6, 0))).toBe(localAt(2026, 0, 10, 8, 0))
  })
})

describe("needsCatchUp", () => {
  const now = localAt(2026, 0, 10, 9, 0)
  it("catches up when we have never checked or missed a day", () => {
    expect(needsCatchUp(null, now)).toBe(true)
    expect(needsCatchUp(now - STALE_AFTER_MS - 1, now)).toBe(true)
  })
  it("leaves a recent check alone", () => {
    expect(needsCatchUp(now - HOUR, now)).toBe(false)
    expect(needsCatchUp(now - STALE_AFTER_MS + 1000, now)).toBe(false)
  })
  it("ignores a clock that jumped backwards instead of re-running", () => {
    expect(needsCatchUp(now + HOUR, now)).toBe(false)
  })
})

describe("createWatchScheduler", () => {
  it("catches up on launch when the last check is stale, then arms the next slot", async () => {
    const start = localAt(2026, 0, 10, 9, 30)
    const app = harness({ hour: 8, lastCheckAt: start - 30 * HOUR, start })
    await app.scheduler.start()
    expect(app.runs).toEqual([start])
    expect(app.scheduler.nextRunAt()).toBe(localAt(2026, 0, 11, 8, 0))
  })

  it("does not catch up when this morning's check already happened", async () => {
    const start = localAt(2026, 0, 10, 9, 30)
    const app = harness({ hour: 8, lastCheckAt: localAt(2026, 0, 10, 8, 0), start })
    await app.scheduler.start()
    expect(app.runs).toEqual([])
    expect(app.scheduler.nextRunAt()).toBe(localAt(2026, 0, 11, 8, 0))
  })

  it("fires once at the slot and re-arms for the following day", async () => {
    const start = localAt(2026, 0, 10, 9, 30)
    const app = harness({ hour: 8, lastCheckAt: start, start })
    await app.scheduler.start()
    expect(app.runs).toEqual([])
    await app.advanceTo(localAt(2026, 0, 11, 8, 0))
    expect(app.runs).toEqual([localAt(2026, 0, 11, 8, 0)])
    expect(app.scheduler.nextRunAt()).toBe(localAt(2026, 0, 12, 8, 0))
    await app.advanceTo(localAt(2026, 0, 12, 8, 0))
    expect(app.runs).toHaveLength(2)
  })

  it("never double-fires: a launch catch-up landing on the slot runs once", async () => {
    // Stale AND launched exactly at the configured hour — the two triggers
    // collide, and only one check may happen.
    const start = localAt(2026, 0, 10, 8, 0)
    const app = harness({ hour: 8, lastCheckAt: start - 40 * HOUR, start })
    await app.scheduler.start()
    await app.advanceTo(start)
    expect(app.runs).toEqual([start])
  })

  it("ignores a second start() instead of stacking timers or re-running", async () => {
    const start = localAt(2026, 0, 10, 9, 30)
    const app = harness({ hour: 8, lastCheckAt: null, start })
    await app.scheduler.start()
    await app.scheduler.start()
    expect(app.runs).toHaveLength(1)
    expect(app.timers).toHaveLength(1)
  })

  it("refuses to start a manual check while one is in flight", async () => {
    let release: (() => void) | null = null
    const start = localAt(2026, 0, 10, 9, 30)
    const app = harness({
      hour: 8,
      lastCheckAt: start,
      start,
      run: () => new Promise<void>((resolve) => (release = resolve)),
    })
    await app.scheduler.start()
    const first = app.scheduler.checkNow()
    await Promise.resolve()
    expect(app.scheduler.running()).toBe(true)
    expect(await app.scheduler.checkNow()).toEqual({ ran: false })
    release?.()
    expect(await first).toMatchObject({ ran: true })
    expect(app.runs).toHaveLength(1)
  })

  it("survives a failing check: the error is reported and the next slot stays armed", async () => {
    const start = localAt(2026, 0, 10, 9, 30)
    let clock = start
    const errors: unknown[] = []
    const timers: { at: number; fn: () => void }[] = []
    const scheduler = createWatchScheduler({
      state: () => ({ hour: 8, lastCheckAt: null }),
      run: async () => {
        throw new Error("GitHub is down")
      },
      now: () => clock,
      setTimer: (ms, fn) => {
        const timer = { at: clock + ms, fn }
        timers.push(timer)
        return timer
      },
      clearTimer: () => {},
      onError: (error) => errors.push(error),
    })
    await scheduler.start()
    expect((errors[0] as Error).message).toBe("GitHub is down")
    expect(scheduler.nextRunAt()).toBe(localAt(2026, 0, 11, 8, 0))
    expect(scheduler.running()).toBe(false)
    clock = localAt(2026, 0, 11, 8, 0)
    scheduler.stop()
    expect(scheduler.nextRunAt()).toBeNull()
  })

  it("re-arms when the hour changes, without running a check", async () => {
    const start = localAt(2026, 0, 10, 9, 30)
    let hour = 8
    let clock = start
    const timers: { at: number; fn: () => void }[] = []
    const runs: number[] = []
    const scheduler = createWatchScheduler({
      state: () => ({ hour, lastCheckAt: start }),
      run: async () => void runs.push(clock),
      now: () => clock,
      setTimer: (ms, fn) => {
        const timer = { at: clock + ms, fn }
        timers.push(timer)
        return timer
      },
      clearTimer: (handle) => {
        const index = timers.indexOf(handle as { at: number; fn: () => void })
        if (index >= 0) timers.splice(index, 1)
      },
    })
    await scheduler.start()
    expect(scheduler.nextRunAt()).toBe(localAt(2026, 0, 11, 8, 0))
    hour = 22
    await scheduler.reschedule()
    expect(scheduler.nextRunAt()).toBe(localAt(2026, 0, 10, 22, 0))
    expect(timers).toHaveLength(1)
    expect(runs).toEqual([])
  })
})

describe("manual checks share the guard", () => {
  it("hands back the run's own result, and refuses to overlap the daily slot", async () => {
    let clock = localAt(2026, 0, 10, 9, 30)
    let release: (() => void) | null = null
    let calls = 0
    const timers: { at: number; fn: () => void }[] = []
    const scheduler = createWatchScheduler<{ checked: number }>({
      state: () => ({ hour: 8, lastCheckAt: clock }),
      run: async () => {
        calls += 1
        await new Promise<void>((resolve) => (release = resolve))
        return { checked: calls }
      },
      now: () => clock,
      setTimer: (ms, fn) => {
        const timer = { at: clock + ms, fn }
        timers.push(timer)
        return timer
      },
      clearTimer: () => {},
    })
    await scheduler.start()
    const manual = scheduler.checkNow()
    await Promise.resolve()
    // The daily timer firing mid-check must not start a second one.
    timers[0]?.fn()
    await Promise.resolve()
    expect(calls).toBe(1)
    release?.()
    expect(await manual).toEqual({ ran: true, result: { checked: 1 } })
    expect(calls).toBe(1)
  })
})
