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
//     live again;
//   * the cached prefix is a SNAPSHOT, never the caller's live array. The
//     session cache appends to its retained `events` in place (see
//     SessionCache.remember), so aliasing it made the prefix grow underneath
//     this reconciler: the first genuinely-new live event was pushed into the
//     array it was still comparing against, `index >= length` stopped holding,
//     and the NEXT event was diffed against that freshly-remembered one. The
//     mismatch looked like a divergent history, and the rebuild that followed
//     started from a prefix that excluded it — which is how a just-sent
//     `message.user` disappeared from the transcript while the agent worked.
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
  /** Prefix length frozen at `reset`. Compared against instead of
   *  `events.length` so that even a future caller handing in a live array
   *  cannot extend what this replay believes it has to recognise. */
  private expectedLength = 0
  private index = 0
  private diverged = false

  constructor(cachedEvents?: readonly AgentEvent[] | null) {
    this.reset(cachedEvents)
  }

  /** Start a fresh replay (attach, or a reconnect that replays from zero).
   *
   *  Copies the prefix: the caller's array is the session cache's own mutable
   *  event log, which keeps growing as live events are remembered. */
  reset(cachedEvents?: readonly AgentEvent[] | null): void {
    this.events = cachedEvents ? [...cachedEvents] : []
    this.expectedLength = this.events.length
    this.index = 0
    this.diverged = false
  }

  /** Has the replay reached live ground — prefix exhausted, or rebuilding? */
  get live(): boolean {
    return this.diverged || this.index >= this.expectedLength
  }

  /** How much of the cached prefix has been recognised. */
  get matchedCount(): number {
    return this.index
  }

  next(ev: AgentEvent): ReplayDecision {
    if (this.diverged || this.index >= this.expectedLength) return { kind: "accept" }
    if (sameReplayEvent(ev, this.events[this.index])) {
      this.index += 1
      return { kind: "skip", complete: this.index >= this.expectedLength }
    }
    this.diverged = true
    return { kind: "rebuild", prefix: this.events.slice(0, this.index) }
  }
}
