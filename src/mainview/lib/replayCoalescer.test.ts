import { describe, expect, test } from "bun:test"
import type { AgentEvent } from "@chunky/protocol"
import { initialState, reduce, type TranscriptState } from "./transcript"
import { TranscriptCoalescer, type CoalescerClock } from "./replayCoalescer"

class FakeClock implements CoalescerClock {
  time = 0
  private nextId = 1
  private readonly timers = new Map<number, { at: number; fn: () => void }>()

  now(): number {
    return this.time
  }

  setTimer(fn: () => void, ms: number): number {
    const id = this.nextId++
    this.timers.set(id, { at: this.time + ms, fn })
    return id
  }

  clearTimer(handle: number): void {
    this.timers.delete(handle)
  }

  advance(ms: number): void {
    const target = this.time + ms
    for (;;) {
      let dueId: number | null = null
      let due: { at: number; fn: () => void } | null = null
      for (const [id, timer] of this.timers) {
        if (timer.at <= target && (!due || timer.at < due.at)) {
          dueId = id
          due = timer
        }
      }
      if (dueId == null || !due) break
      this.timers.delete(dueId)
      this.time = due.at
      due.fn()
    }
    this.time = target
  }

  get pending(): number {
    return this.timers.size
  }
}

const delta = (text: string): AgentEvent => ({ type: "message.delta", text })
const burst = (n: number): AgentEvent[] => [
  { type: "message.start", role: "assistant" },
  ...Array.from({ length: n }, (_, i) => delta(`${i} `)),
  { type: "message.end" },
]

function harness(options: Parameters<typeof makeCoalescer>[0] = {}) {
  return makeCoalescer(options)
}

function makeCoalescer(options: { holdQuietMs?: number; holdMaxMs?: number } = {}) {
  const clock = new FakeClock()
  const emits: TranscriptState[] = []
  const coalescer = new TranscriptCoalescer(initialState, (s) => emits.push(s), {
    flushMs: 50,
    clock,
    ...options,
  })
  return { clock, emits, coalescer }
}

describe("TranscriptCoalescer", () => {
  test("collapses a replay burst into a couple of commits, not one per event", () => {
    const { clock, emits, coalescer } = harness()
    const events = burst(500)

    for (const ev of events) coalescer.push(ev)
    clock.advance(50)

    // Leading edge + one trailing commit — versus 502 without coalescing.
    expect(emits.length).toBeLessThanOrEqual(2)
    expect(emits.at(-1)).toEqual(events.reduce(reduce, initialState))
    expect(coalescer.state).toEqual(events.reduce(reduce, initialState))
  })

  test("publishes the first event of a burst immediately (leading edge)", () => {
    const { emits, coalescer } = harness()
    coalescer.push({ type: "message.user", text: "hi" })
    expect(emits).toHaveLength(1)
    expect(emits[0]!.threads.main!.items).toHaveLength(1)
  })

  test("keeps steady-state streaming at the cadence", () => {
    const { clock, emits, coalescer } = harness()
    coalescer.push({ type: "message.start", role: "assistant" })
    expect(emits).toHaveLength(1)
    for (let i = 0; i < 5; i++) {
      clock.advance(60)
      coalescer.push(delta("x"))
    }
    expect(emits).toHaveLength(6)
  })

  test("always publishes the tail of a burst (trailing flush)", () => {
    const { clock, emits, coalescer } = harness()
    coalescer.push(delta("a"))
    const emittedFirst = emits.length
    coalescer.push(delta("b"))
    coalescer.push(delta("c"))
    expect(emits.length).toBe(emittedFirst)
    clock.advance(50)
    expect(emits.length).toBe(emittedFirst + 1)
    expect(emits.at(-1)).toEqual(coalescer.state)
  })

  test("a hold keeps the rebuild off screen until the burst goes quiet", () => {
    const { clock, emits, coalescer } = harness({ holdQuietMs: 120, holdMaxMs: 1_000 })
    coalescer.replaceState(initialState)
    coalescer.hold()
    for (const ev of burst(20)) coalescer.push(ev)

    clock.advance(100)
    expect(emits).toHaveLength(0)
    clock.advance(30)
    expect(emits).toHaveLength(1)
    expect(emits[0]).toEqual(coalescer.state)
    expect(coalescer.holding).toBe(false)
  })

  test("a hold on a session that never goes quiet still releases at the cap", () => {
    const { clock, emits, coalescer } = harness({ holdQuietMs: 120, holdMaxMs: 1_000 })
    coalescer.hold()
    // A still-running session keeps streaming: quiet never arrives.
    for (let i = 0; i < 40; i++) {
      coalescer.push(delta(`${i}`))
      clock.advance(50)
    }
    expect(emits.length).toBeGreaterThanOrEqual(1)
    expect(coalescer.holding).toBe(false)
    expect(emits.at(-1)!.threads.main!.items).toHaveLength(1)
  })

  test("reset drops a pending commit and rearms the leading edge", () => {
    const { clock, emits, coalescer } = harness()
    coalescer.push(delta("a"))
    coalescer.push(delta("b"))
    coalescer.reset(initialState)
    clock.advance(200)
    expect(emits).toHaveLength(1) // only the leading-edge commit
    coalescer.push(delta("fresh"))
    expect(emits).toHaveLength(2)
    expect(emits.at(-1)!.threads.main!.items).toHaveLength(1)
  })

  test("dispose stops every timer and ignores later events", () => {
    const { clock, emits, coalescer } = harness()
    coalescer.push(delta("a"))
    coalescer.push(delta("b"))
    coalescer.dispose()
    coalescer.push(delta("c"))
    clock.advance(500)
    expect(emits).toHaveLength(1)
    expect(clock.pending).toBe(0)
  })

  test("push returns the working state for per-event cache bookkeeping", () => {
    const { coalescer } = harness()
    const first = coalescer.push({ type: "message.user", text: "one" })
    const second = coalescer.push({ type: "message.user", text: "two" })
    expect(first.threads.main!.items).toHaveLength(1)
    expect(second.threads.main!.items).toHaveLength(2)
    expect(second).toBe(coalescer.state)
  })
})
