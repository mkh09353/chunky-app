// Decide what to do with each event of a replayed session stream.
//
// The protocol has no replay cursor (ROUTES.events always starts at history
// event zero), so a client that already holds a projection has to recognise its
// own past: discard the persisted prefix it has already reduced, and start
// reducing at the first event that is genuinely new.
//
// Two things this must get right, both of which used to be wrong or fragile:
//   * once the replay has DIVERGED from the cache, comparison stops for good —
//     a later event that happens to equal `cached.events[index]` must not be
//     swallowed out of the rebuild;
//   * "the prefix is exhausted" is reported explicitly, because that is the
//     moment the projection on screen stops being last-seen state and becomes
//     live again.
//
// Pure — run with: bun test src/mainview/lib/replayReconciler.test.ts
import type { AgentEvent } from "@chunky/protocol"

export type ReplayDecision =
  /** Already reduced into the cached projection. `complete` marks the last one. */
  | { kind: "skip"; complete: boolean }
  /** History diverged: rebuild from `prefix`, then reduce this event onto it. */
  | { kind: "rebuild"; prefix: AgentEvent[] }
  /** New: reduce it onto the current projection. */
  | { kind: "accept" }

/** Cheap first, exact second: most replayed events differ by type. */
export function sameReplayEvent(a: AgentEvent | undefined, b: AgentEvent | undefined): boolean {
  if (!a || !b) return false
  if (a.type !== b.type) return false
  return JSON.stringify(a) === JSON.stringify(b)
}

export class ReplayReconciler {
  private events: readonly AgentEvent[] = []
  private index = 0
  private diverged = false

  constructor(cachedEvents?: readonly AgentEvent[] | null) {
    this.reset(cachedEvents)
  }

  /** Start a fresh replay (attach, or a reconnect that replays from zero). */
  reset(cachedEvents?: readonly AgentEvent[] | null): void {
    this.events = cachedEvents ?? []
    this.index = 0
    this.diverged = false
  }

  /** Has the replay reached live ground — prefix exhausted, or rebuilding? */
  get live(): boolean {
    return this.diverged || this.index >= this.events.length
  }

  /** How much of the cached prefix has been recognised. */
  get matchedCount(): number {
    return this.index
  }

  next(ev: AgentEvent): ReplayDecision {
    if (this.diverged || this.index >= this.events.length) return { kind: "accept" }
    if (sameReplayEvent(ev, this.events[this.index])) {
      this.index += 1
      return { kind: "skip", complete: this.index >= this.events.length }
    }
    this.diverged = true
    return { kind: "rebuild", prefix: this.events.slice(0, this.index) }
  }
}
