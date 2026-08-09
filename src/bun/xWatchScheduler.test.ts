import { expect, test } from "bun:test"
import { createXWatchScheduler, nextXRun } from "./xWatchScheduler"

test("next X run is immediate when stale and hourly after last success", () => {
  expect(nextXRun({ intervalMinutes: 60, lastSuccessAt: null }, 5_000)).toBe(5_000)
  expect(nextXRun({ intervalMinutes: 60, lastSuccessAt: 1_000 }, 5_000)).toBe(3_601_000)
})

test("scheduler catches up, prevents overlap, rearms after failure, reschedules, and stops", async () => {
  let now = 10_000; let lastSuccessAt: number | null = null; let intervalMinutes = 60; let release: (() => void) | null = null
  const timers: { at: number; fn: () => void }[] = []; let calls = 0
  const scheduler = createXWatchScheduler({ state: () => ({ intervalMinutes, lastSuccessAt }), run: async () => { calls++; await new Promise<void>((resolve) => { release = resolve }) }, now: () => now, setTimer: (ms, fn) => { const timer = { at: now + ms, fn }; timers.push(timer); return timer }, clearTimer: (handle) => { const i = timers.indexOf(handle as any); if (i >= 0) timers.splice(i, 1) } })
  const start = scheduler.start(); await Promise.resolve(); expect(calls).toBe(1); expect((await scheduler.checkNow()).ran).toBe(false); release?.(); await start
  expect(scheduler.nextRunAt()).toBe(now + 60 * 60_000)
  intervalMinutes = 30; await scheduler.reschedule(); expect(scheduler.nextRunAt()).toBe(now + 30 * 60_000)
  scheduler.stop(); expect(scheduler.nextRunAt()).toBeNull()
  void lastSuccessAt
})
