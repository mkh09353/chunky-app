// Coalesce a session's SSE event stream into React commits.
//
// WHY: a legacy attach (and every reconnect to an old server) still streams
// the session's whole history from event zero before live events resume. The
// v2 cursor stream skips that, but live tokens still arrive faster than React
// should commit. Reducing is cheap (~6ms for an 11k-event session); COMMITTING
// to React once per event is not, because each commit re-projects and
// re-renders the entire transcript. That is what made switching to a session
// which had been running in the background sit on a stale projection for many
// seconds before snapping to its finished state.
//
// So the split is: reduce EAGERLY (callers still see every event, in order, and
// their side effects still fire per event), publish on a CADENCE.
//
// Pure and clock-injectable so the cadence can be tested without React or a
// server. Run with: bun test src/mainview/lib/replayCoalescer.test.ts
import type { AgentEvent } from "@chunky/protocol"
import { reduce, type TranscriptState } from "./transcript"

/** Publish cadence. Fast enough that token streaming still reads as live,
 *  slow enough that a replay burst costs a handful of renders, not thousands. */
export const FLUSH_MS = 50

/** How long a held (rebuilding) projection waits for the replay burst to go
 *  quiet before swapping to the rebuild. */
export const HOLD_QUIET_MS = 120

/** Hard cap on holding a rebuilt projection back. A session that is still
 *  RUNNING never goes quiet, so quiet alone must never be the only way out —
 *  that is exactly the freeze this cap exists to prevent. */
export const HOLD_MAX_MS = 1_000

export interface CoalescerClock {
  now(): number
  setTimer(fn: () => void, ms: number): number
  clearTimer(handle: number): void
}

export const systemClock: CoalescerClock = {
  now: () => Date.now(),
  setTimer: (fn, ms) => setTimeout(fn, ms) as unknown as number,
  clearTimer: (handle) => clearTimeout(handle as unknown as ReturnType<typeof setTimeout>),
}

export interface CoalescerOptions {
  flushMs?: number
  holdQuietMs?: number
  holdMaxMs?: number
  clock?: CoalescerClock
}

/**
 * Throttled publisher for a transcript projection.
 *
 * `push` reduces immediately and returns the new working state (so the caller
 * can keep its own caches in step event-by-event); `emit` is called at most
 * once per `flushMs`, leading edge first so the first event of a burst is on
 * screen straight away and the rest ride the cadence.
 */
export class TranscriptCoalescer {
  private working: TranscriptState
  private dirty = false
  private lastEmit = Number.NEGATIVE_INFINITY
  private timer: number | null = null
  private held = false
  private quietTimer: number | null = null
  private maxHoldTimer: number | null = null
  private disposed = false
  private readonly flushMs: number
  private readonly holdQuietMs: number
  private readonly holdMaxMs: number
  private readonly clock: CoalescerClock

  constructor(
    initial: TranscriptState,
    private readonly emit: (state: TranscriptState) => void,
    options: CoalescerOptions = {},
  ) {
    this.working = initial
    this.flushMs = options.flushMs ?? FLUSH_MS
    this.holdQuietMs = options.holdQuietMs ?? HOLD_QUIET_MS
    this.holdMaxMs = options.holdMaxMs ?? HOLD_MAX_MS
    this.clock = options.clock ?? systemClock
  }

  /** The reduction of everything pushed so far — always current, even when the
   *  last commit to React is up to `flushMs` (or a hold) behind. */
  get state(): TranscriptState {
    return this.working
  }

  /** True while a rebuilt projection is deliberately kept off screen. */
  get holding(): boolean {
    return this.held
  }

  /** Reduce one event and schedule a publish. Returns the new working state. */
  push(ev: AgentEvent): TranscriptState {
    if (this.disposed) return this.working
    this.working = reduce(this.working, ev)
    this.dirty = true
    if (this.held) this.armHoldTimers()
    else this.schedule()
    return this.working
  }

  /**
   * Adopt an externally-reduced projection and publish it on the cadence.
   *
   * The v2 cursor stream reduces its own projections (see sessionStream.ts:
   * visible and durable are separate), so it hands finished states here rather
   * than pushing events through `push`.
   */
  publish(state: TranscriptState): TranscriptState {
    if (this.disposed) return this.working
    this.working = state
    this.dirty = true
    if (this.held) this.armHoldTimers()
    else this.schedule()
    return this.working
  }

  /**
   * Adopt `state` as the working projection WITHOUT publishing it.
   *
   * Used when a divergent replay forces a rebuild from event zero: the screen
   * keeps the previous projection (see `hold`) so the reader never watches the
   * transcript shrink and grow back.
   */
  replaceState(state: TranscriptState): void {
    if (this.disposed) return
    this.working = state
    this.dirty = true
  }

  /** Keep publishing suspended until the burst goes quiet or `holdMaxMs`. */
  hold(): void {
    if (this.disposed || this.held) return
    this.held = true
    this.cancelFlush()
    this.armHoldTimers()
    if (this.maxHoldTimer == null) {
      this.maxHoldTimer = this.clock.setTimer(() => {
        this.maxHoldTimer = null
        this.release()
      }, this.holdMaxMs)
    }
  }

  /** Publish the working state now (ending any hold), if anything changed. */
  flush(): void {
    if (this.disposed) return
    this.held = false
    this.cancelHoldTimers()
    this.emitNow()
  }

  /** Drop everything and start again from `state` (attach / session switch).
   *  Never publishes: the caller owns the visible state at that moment. */
  reset(state: TranscriptState): void {
    this.cancelFlush()
    this.cancelHoldTimers()
    this.held = false
    this.dirty = false
    this.working = state
    // A fresh attach may publish immediately — the burst that follows is what
    // the cadence is for, not the first frame of it.
    this.lastEmit = Number.NEGATIVE_INFINITY
  }

  /** Stop all timers permanently; later pushes are ignored. */
  dispose(): void {
    this.disposed = true
    this.cancelFlush()
    this.cancelHoldTimers()
  }

  private release(): void {
    if (this.disposed || !this.held) return
    this.held = false
    this.cancelHoldTimers()
    this.emitNow()
  }

  private armHoldTimers(): void {
    if (this.quietTimer != null) this.clock.clearTimer(this.quietTimer)
    this.quietTimer = this.clock.setTimer(() => {
      this.quietTimer = null
      this.release()
    }, this.holdQuietMs)
  }

  private cancelHoldTimers(): void {
    if (this.quietTimer != null) this.clock.clearTimer(this.quietTimer)
    if (this.maxHoldTimer != null) this.clock.clearTimer(this.maxHoldTimer)
    this.quietTimer = null
    this.maxHoldTimer = null
  }

  private cancelFlush(): void {
    if (this.timer != null) this.clock.clearTimer(this.timer)
    this.timer = null
  }

  private schedule(): void {
    if (this.timer != null) return
    const waited = this.clock.now() - this.lastEmit
    if (waited >= this.flushMs) {
      this.emitNow()
      return
    }
    this.timer = this.clock.setTimer(() => {
      this.timer = null
      this.emitNow()
    }, this.flushMs - waited)
  }

  private emitNow(): void {
    this.cancelFlush()
    if (this.disposed || this.held || !this.dirty) return
    this.dirty = false
    this.lastEmit = this.clock.now()
    this.emit(this.working)
  }
}
