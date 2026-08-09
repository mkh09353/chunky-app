export const DEFAULT_X_WATCH_INTERVAL_MINUTES = 60
export const MIN_X_WATCH_INTERVAL_MINUTES = 30
export const MAX_X_WATCH_INTERVAL_MINUTES = 180

export type XSchedulerState = { intervalMinutes: number; lastSuccessAt: number | null }
export type XWatchScheduler<T = unknown> = { start(): Promise<void>; checkNow(): Promise<{ ran: true; result: T } | { ran: false }>; reschedule(): Promise<void>; stop(): void; nextRunAt(): number | null; running(): boolean }

export function nextXRun(state: XSchedulerState, now: number): number {
  const interval = Number.isFinite(state.intervalMinutes)
    ? Math.max(MIN_X_WATCH_INTERVAL_MINUTES, Math.min(MAX_X_WATCH_INTERVAL_MINUTES, Math.floor(state.intervalMinutes)))
    : DEFAULT_X_WATCH_INTERVAL_MINUTES
  const elapsed = state.lastSuccessAt === null || state.lastSuccessAt > now ? Number.POSITIVE_INFINITY : now - state.lastSuccessAt
  return elapsed >= interval * 60_000 ? now : state.lastSuccessAt! + interval * 60_000
}

export function createXWatchScheduler<T>(deps: { state(): XSchedulerState | Promise<XSchedulerState>; run(): Promise<T>; now?(): number; setTimer?(ms: number, fn: () => void): unknown; clearTimer?(handle: unknown): void; onError?(error: unknown): void }): XWatchScheduler<T> {
  const now = deps.now ?? Date.now
  const setTimer = deps.setTimer ?? ((ms, fn) => setTimeout(fn, ms))
  const clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>))
  let handle: unknown = null; let armed: number | null = null; let inFlight = false; let started = false; let stopped = false; let lastAttemptAt: number | null = null
  const disarm = () => { if (handle !== null) clearTimer(handle); handle = null; armed = null }
  const run = async () => { if (inFlight || stopped) return { ran: false as const }; inFlight = true; lastAttemptAt = now(); try { return { ran: true as const, result: await deps.run() } } catch (error) { deps.onError?.(error); return { ran: true as const, result: undefined as T } } finally { inFlight = false } }
  const arm = async () => { if (stopped) return; disarm(); const state = await deps.state(); const interval = Math.max(MIN_X_WATCH_INTERVAL_MINUTES, Math.min(MAX_X_WATCH_INTERVAL_MINUTES, state.intervalMinutes || DEFAULT_X_WATCH_INTERVAL_MINUTES)) * 60_000; armed = Math.max(nextXRun(state, now()), lastAttemptAt === null ? 0 : lastAttemptAt + interval); handle = setTimer(Math.max(0, armed - now()), () => { handle = null; armed = null; void (async () => { await run(); await arm() })() }) }
  return {
    async start() { if (started || stopped) return; started = true; const state = await deps.state(); if (nextXRun(state, now()) <= now()) await run(); await arm() },
    async checkNow() { const result = await run(); if (result.ran) await arm(); return result },
    async reschedule() { if (started && !stopped) await arm() },
    stop() { stopped = true; disarm() }, nextRunAt: () => armed, running: () => inFlight,
  }
}
