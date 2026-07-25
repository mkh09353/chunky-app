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
