// In-app confirmation prompts.
//
// `window.confirm` is not usable here: in packaged Electrobun the WebView has
// no place to put a native modal, so the call is dropped and the caller reads
// the falsy answer as "the user said no" — the destructive action silently
// never happens (same class of problem as `window.open`; see lib/openExternal).
//
// This module is the pure half: a tiny queue of pending requests with a
// promise each. The UI half is <ConfirmHost /> (components/ConfirmDialog.tsx),
// mounted once at the app root, which renders the head of the queue and settles
// it. Keeping them apart means the queue is testable without a DOM.

export type ConfirmOptions = {
  title: string
  /** Optional second line. Newlines are preserved when rendered. */
  body?: string
  confirmLabel?: string
  cancelLabel?: string
  /** Paints the confirm button as destructive. */
  destructive?: boolean
}

export type ConfirmRequest = ConfirmOptions & {
  id: number
  /** Answer this request. Idempotent: later calls for the same request are
   *  ignored, so a click racing an Escape cannot resolve twice. */
  settle: (confirmed: boolean) => void
}

type Listener = (current: ConfirmRequest | null) => void

let queue: ConfirmRequest[] = []
let nextId = 1
const listeners = new Set<Listener>()

function emit(): void {
  const head = queue[0] ?? null
  for (const listener of Array.from(listeners)) listener(head)
}

/**
 * Ask the user to confirm. Resolves true only on an explicit confirm; Escape,
 * the backdrop and Cancel all resolve false.
 *
 * Requests queue: a second prompt raised while one is open waits its turn
 * rather than replacing it (nothing is lost, and no answer is misattributed).
 */
export function confirm(options: ConfirmOptions): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const id = nextId
    nextId += 1
    const settle = (confirmed: boolean) => {
      const remaining = queue.filter((request) => request.id !== id)
      // Already settled (or never queued): ignore, don't resolve twice.
      if (remaining.length === queue.length) return
      queue = remaining
      resolve(confirmed)
      emit()
    }
    queue = [...queue, { ...options, id, settle }]
    emit()
  })
}

/** The request the host should be showing, if any. */
export function currentConfirm(): ConfirmRequest | null {
  return queue[0] ?? null
}

/** Subscribe to head-of-queue changes. Returns an unsubscribe. */
export function subscribeConfirm(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Test-only: drop every pending request (answering each with false). */
export function resetConfirms(): void {
  // Settle through the queue rather than clearing it: `settle` is what resolves
  // the promise, and it no-ops on a request that is no longer queued.
  while (queue.length) queue[0]!.settle(false)
}
