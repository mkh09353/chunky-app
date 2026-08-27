// Reconnect backoff + the "app came back to the front" wake.
// Run with: bun test src/mainview/lib/reconnect.test.ts
import { describe, expect, test } from "bun:test"
import {
  installVisibilityWake,
  reconnectDelay,
  ReconnectWaker,
  sleepUntilWoken,
  type VisibilityTarget,
} from "./reconnect"

class FakeDocument implements VisibilityTarget {
  visibilityState = "hidden"
  private readonly listeners = new Set<() => void>()
  addEventListener(_type: "visibilitychange", fn: () => void): void { this.listeners.add(fn) }
  removeEventListener(_type: "visibilitychange", fn: () => void): void { this.listeners.delete(fn) }
  emit(state: string): void {
    this.visibilityState = state
    for (const fn of [...this.listeners]) fn()
  }
  get listenerCount(): number { return this.listeners.size }
}

describe("reconnect backoff", () => {
  test("is bounded and exponential", () => {
    expect(reconnectDelay(0)).toBe(500)
    expect(reconnectDelay(3)).toBe(4_000)
    expect(reconnectDelay(99)).toBe(30_000)
  })
})

describe("visibilitychange wakes a reconnect early", () => {
  test("a woken sleep resolves long before its delay", async () => {
    const waker = new ReconnectWaker()
    const doc = new FakeDocument()
    let reconnecting = true
    const remove = installVisibilityWake(waker, () => reconnecting, doc)

    const started = Date.now()
    const sleeping = sleepUntilWoken(30_000, undefined, waker)
    // Give the sleeper a tick to register.
    await Promise.resolve()
    expect(waker.waiting).toBe(1)
    doc.emit("visible")
    await sleeping
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(waker.waiting).toBe(0)
    remove()
    expect(doc.listenerCount).toBe(0)
    // Sanity: the guard is what stops a foreground event waking a live stream.
    reconnecting = false
  })

  test("does nothing while hidden, or while the stream is connected", async () => {
    const waker = new ReconnectWaker()
    const doc = new FakeDocument()
    let reconnecting = false
    installVisibilityWake(waker, () => reconnecting, doc)
    let resolved = false
    void sleepUntilWoken(50, undefined, waker).then(() => { resolved = true })
    await Promise.resolve()

    doc.emit("hidden")
    expect(resolved).toBe(false)
    // Connected: a foreground event must not spawn/short-circuit anything.
    doc.emit("visible")
    expect(resolved).toBe(false)

    reconnecting = true
    doc.emit("visible")
    await Promise.resolve()
    expect(resolved).toBe(true)
  })

  test("an abort still rejects a woken-capable sleep", async () => {
    const waker = new ReconnectWaker()
    const ac = new AbortController()
    const sleeping = sleepUntilWoken(10_000, ac.signal, waker)
    ac.abort()
    await expect(sleeping).rejects.toThrow()
    expect(waker.waiting).toBe(0)
  })
})
