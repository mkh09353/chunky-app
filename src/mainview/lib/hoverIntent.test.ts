import { describe, expect, test } from "bun:test"
import { HoverIntent, type HoverTimer } from "./hoverIntent"

/** A clock the test drives by hand: no sleeping, no flakiness. */
function fakeClock() {
  let now = 0
  let seq = 0
  const jobs = new Map<number, { at: number; fn: () => void }>()
  const timer: HoverTimer = {
    set(fn, ms) {
      const id = ++seq
      jobs.set(id, { at: now + ms, fn })
      return id
    },
    clear(handle) {
      jobs.delete(handle as number)
    },
  }
  const advance = (ms: number) => {
    now += ms
    for (const [id, job] of [...jobs]) {
      if (job.at <= now) {
        jobs.delete(id)
        job.fn()
      }
    }
  }
  return { timer, advance, pending: () => jobs.size }
}

function setup() {
  const clock = fakeClock()
  const changes: boolean[] = []
  const intent = new HoverIntent({
    openDelayMs: 200,
    closeDelayMs: 180,
    onChange: (open) => changes.push(open),
    timer: clock.timer,
  })
  return { clock, changes, intent }
}

describe("HoverIntent", () => {
  test("opens only after the dwell", () => {
    const { clock, changes, intent } = setup()
    intent.enter()
    clock.advance(199)
    expect(changes).toEqual([])
    expect(intent.isOpen).toBe(false)
    clock.advance(1)
    expect(changes).toEqual([true])
    expect(intent.isOpen).toBe(true)
  })

  test("passing through the trigger never flashes it open", () => {
    const { clock, changes, intent } = setup()
    intent.enter()
    clock.advance(120)
    intent.leave() // gone before the dwell elapsed
    clock.advance(1_000)
    expect(changes).toEqual([])
    expect(intent.isOpen).toBe(false)
  })

  test("crossing the seam to the panel does not close it", () => {
    const { clock, changes, intent } = setup()
    intent.enter()
    clock.advance(200)
    expect(changes).toEqual([true])

    intent.leave() // left the strip...
    clock.advance(100) // ...still inside the close grace...
    intent.hold() // ...and landed on the panel.
    clock.advance(1_000)
    expect(changes).toEqual([true]) // never flickered shut
    expect(intent.isOpen).toBe(true)
  })

  test("closes once the pointer is gone for the full grace period", () => {
    const { clock, changes, intent } = setup()
    intent.enter()
    clock.advance(200)
    intent.leave()
    clock.advance(179)
    expect(intent.isOpen).toBe(true)
    clock.advance(1)
    expect(changes).toEqual([true, false])
    expect(intent.isOpen).toBe(false)
  })

  test("explicit close and toggle beat any pending timer", () => {
    const { clock, changes, intent } = setup()
    intent.enter()
    clock.advance(200)
    intent.close()
    expect(changes).toEqual([true, false])

    // A pending open must not resurrect it after an explicit close.
    intent.enter()
    intent.close()
    clock.advance(1_000)
    expect(changes).toEqual([true, false])

    intent.toggle()
    expect(changes).toEqual([true, false, true])
    intent.toggle()
    expect(changes).toEqual([true, false, true, false])
  })

  test("repeated entries while open do not re-notify or leak timers", () => {
    const { clock, changes, intent } = setup()
    intent.hold()
    intent.enter()
    intent.enter()
    clock.advance(1_000)
    expect(changes).toEqual([true])
    expect(clock.pending()).toBe(0)
  })

  test("leaving while already closed schedules nothing", () => {
    const { clock, changes, intent } = setup()
    intent.leave()
    expect(clock.pending()).toBe(0)
    clock.advance(1_000)
    expect(changes).toEqual([])
  })

  test("dispose cancels pending work", () => {
    const { clock, changes, intent } = setup()
    intent.enter()
    intent.dispose()
    clock.advance(1_000)
    expect(changes).toEqual([])
    expect(clock.pending()).toBe(0)
  })
})
