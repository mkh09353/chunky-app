// Open/close scheduling for hover-revealed surfaces.
//
// Lives here rather than inline in the component because the interesting part
// is timing, and timing is exactly what cannot be checked by looking at JSX:
//
//   - Crossing the trigger on the way somewhere else must NOT flash it open,
//     so opening waits for a dwell.
//   - Moving from the trigger to the panel crosses a seam where the pointer is
//     briefly over neither. Closing therefore waits too, and any re-entry
//     cancels the pending close. That grace is what stops the flicker.
//   - An explicit click/Escape must beat both timers rather than queue behind
//     them.
//
// Timers are injected so tests can drive a clock instead of sleeping.
// Pure — run with: bun test src/mainview/lib/hoverIntent.test.ts

export interface HoverTimer {
  set(fn: () => void, ms: number): unknown
  clear(handle: unknown): void
}

const realTimer: HoverTimer = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

export interface HoverIntentOptions {
  openDelayMs: number
  closeDelayMs: number
  /** Called only when the open state actually changes. */
  onChange: (open: boolean) => void
  timer?: HoverTimer
}

export class HoverIntent {
  private open = false
  private pending: unknown = null
  private readonly timer: HoverTimer

  constructor(private readonly opts: HoverIntentOptions) {
    this.timer = opts.timer ?? realTimer
  }

  get isOpen(): boolean {
    return this.open
  }

  private cancel(): void {
    if (this.pending != null) {
      this.timer.clear(this.pending)
      this.pending = null
    }
  }

  private commit(next: boolean): void {
    if (this.open === next) return
    this.open = next
    this.opts.onChange(next)
  }

  /** Pointer entered the trigger: open after the dwell. */
  enter(): void {
    this.cancel()
    if (this.open) return
    this.pending = this.timer.set(() => {
      this.pending = null
      this.commit(true)
    }, this.opts.openDelayMs)
  }

  /** Pointer left the trigger and the panel: close after the grace period. */
  leave(): void {
    this.cancel()
    if (!this.open) return
    this.pending = this.timer.set(() => {
      this.pending = null
      this.commit(false)
    }, this.opts.closeDelayMs)
  }

  /** Pointer is over the trigger or the panel: open now, cancel any close. */
  hold(): void {
    this.cancel()
    this.commit(true)
  }

  /** Explicit close (Escape, navigation) — immediate, beating any timer. */
  close(): void {
    this.cancel()
    this.commit(false)
  }

  /** Explicit toggle (click) — immediate in both directions. */
  toggle(): void {
    this.cancel()
    this.commit(!this.open)
  }

  dispose(): void {
    this.cancel()
  }
}
