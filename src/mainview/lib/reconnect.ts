// SSE reconnect policy (mirrors old app / TUI). Every reattach replays full
// history — callers must reset their transcript projection before retrying.

export const RECONNECT_MAX_DELAY_MS = 30_000

/** Bounded exponential delay: 500ms, 1s, 2s, 4s … 30s. */
export function reconnectDelay(attempt: number): number {
  const n = Math.max(0, Math.floor(attempt))
  return Math.min(RECONNECT_MAX_DELAY_MS, 500 * 2 ** n)
}

/** True when WE ended the stream (session switch / unmount). */
export function isIntentionalAbort(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (error instanceof Error && error.name === "AbortError")
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"))
      return
    }
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(t)
      reject(new DOMException("Aborted", "AbortError"))
    }
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

/**
 * A one-to-many "stop waiting" signal for the reconnect backoff.
 *
 * Backgrounding the app is exactly when the stream dies, and coming back is
 * exactly when the reader wants it alive again — but the loop may be sitting in
 * a 30s sleep. Waking it cuts that short IN PLACE: no second attachment, no
 * competing stream.
 */
export class ReconnectWaker {
  private readonly waiters = new Set<() => void>()

  /** Resolve every sleeper waiting on this waker. */
  wake(): void {
    for (const waiter of [...this.waiters]) waiter()
  }

  get waiting(): number { return this.waiters.size }

  /** @internal */
  add(fn: () => void): () => void {
    this.waiters.add(fn)
    return () => { this.waiters.delete(fn) }
  }
}

/** `sleep`, but `waker.wake()` ends it early. Aborts still reject. */
export function sleepUntilWoken(ms: number, signal?: AbortSignal, waker?: ReconnectWaker): Promise<void> {
  if (!waker) return sleep(ms, signal)
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"))
      return
    }
    let done = false
    const finish = (fn: () => void) => {
      if (done) return
      done = true
      clearTimeout(timer)
      unregister()
      signal?.removeEventListener("abort", onAbort)
      fn()
    }
    const timer = setTimeout(() => finish(resolve), ms)
    const unregister = waker.add(() => finish(resolve))
    const onAbort = () => finish(() => reject(new DOMException("Aborted", "AbortError")))
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

/** The slice of `document` this needs; injectable so it can be tested. */
export interface VisibilityTarget {
  visibilityState: string
  addEventListener(type: "visibilitychange", fn: () => void): void
  removeEventListener(type: "visibilitychange", fn: () => void): void
}

/**
 * Wake `waker` when the document becomes visible again AND the caller says it
 * is currently reconnecting. Returns the unsubscribe.
 */
export function installVisibilityWake(
  waker: ReconnectWaker,
  isReconnecting: () => boolean,
  target?: VisibilityTarget | null,
): () => void {
  const doc = target ?? (typeof document === "undefined" ? null : (document as unknown as VisibilityTarget))
  if (!doc) return () => {}
  const onChange = () => {
    if (doc.visibilityState !== "visible") return
    if (!isReconnecting()) return
    waker.wake()
  }
  doc.addEventListener("visibilitychange", onChange)
  return () => doc.removeEventListener("visibilitychange", onChange)
}
