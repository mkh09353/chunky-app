// Optimistic user rows: the message a reader just sent, on screen before the
// server has echoed it back.
//
// WHY THIS IS PRESENTATION STATE, NOT TRANSCRIPT STATE
// ---------------------------------------------------
// The session cache and ReplayReconciler exist to mirror the server's event log
// exactly (see replayReconciler.ts). A locally invented "the user said this"
// event in that log would be indistinguishable from history on the next attach,
// and any divergence handling would have to reason about events the server
// never sent. So a pending send lives OUTSIDE TranscriptState entirely: it is
// carried in renderer state, resolved against the reduced transcript, and
// spliced into the mapped Message[] at the presentation seam
// (mapTranscript.buildActiveThread). Two properties fall out of that for free:
//   * a divergent replay rebuilding the projection from event zero cannot wipe
//     a still-pending row — the rebuild only ever touches TranscriptState;
//   * the reconciler never sees an event it did not receive from the server.
//
// HOW THE ECHO IS MATCHED (there is no client id)
// -----------------------------------------------
// @chunky/protocol's SendMessageRequest carries no client-supplied id, and
// `message.user` carries only { text, threadId?, from?, imageCount? }. So the
// match is by CONTENT + ORDERING, which the server makes reliable: it echoes
// `visibleText` verbatim (packages/server/src/index.ts deliverMessage), the
// same string the composer posted.
//
// Resolution is DERIVED, never event-driven. An event handler that deleted the
// pending row on `message.user` would race the transcript's publish cadence
// (TranscriptCoalescer, up to 50ms): the optimistic row would vanish a frame
// before the authoritative one appeared — a visible flicker, and briefly a
// message that looks unsent again. Deriving "is it resolved?" from the
// transcript that is ACTUALLY ON SCREEN makes the swap atomic: the same render
// that gains the server row loses the pending one.
//
// Pure — run with: bun test src/mainview/lib/pendingSends.test.ts
import type { MessageDelivery, QueueEntry } from "@chunky/protocol"
import type { Message } from "./mock"
import type { Item } from "./transcript"

export interface PendingSend {
  /** Renderer-side row id (never a server id, never in the event log). */
  id: string
  /** Exactly what was posted — the string the server will echo back. */
  text: string
  /** Compact attachment metadata: a count, never the base64 that was sent. */
  imageCount: number
  /** How many user items the transcript held when this was posted. The echo
   *  can only be at or after this point, which is what stops a repeat of an
   *  earlier message ("ok" twice) matching the OLD row and vanishing at once. */
  baselineUserCount: number
  /** Set when the POST itself failed. The row stays, marked failed, rather
   *  than disappearing as if it had never been typed. */
  error?: string
}

/** Server-side, a send that arrives while a turn is running is QUEUED: no
 *  `message.user` until the drainer reaches it, and the composer's queue chips
 *  already show it. Optimistically appending those would double-render the
 *  same text in two surfaces for as long as the queue takes to drain. */
export function shouldAppendOptimistically(delivery?: MessageDelivery): boolean {
  return delivery !== "queue"
}

/** User items in a reduced transcript, in order. Items carrying `from` are
 *  another session's injection (send_to_session / a monitor), never ours. */
function ownUserItems(items: readonly Item[]): { text: string }[] {
  const out: { text: string }[] = []
  for (const it of items) {
    if (it.kind !== "user") continue
    if (it.from) continue
    out.push({ text: it.text })
  }
  return out
}

/** Baseline for a send issued against `items` right now. */
export function userItemCount(items: readonly Item[]): number {
  return ownUserItems(items).length
}

export function createPendingSend(input: {
  id: string
  text: string
  imageCount?: number
  items: readonly Item[]
}): PendingSend {
  return {
    id: input.id,
    text: input.text,
    imageCount: input.imageCount ?? 0,
    baselineUserCount: userItemCount(input.items),
  }
}

/** The POST failed: keep the row, mark why. */
export function markPendingSendFailed(
  list: readonly PendingSend[],
  id: string,
  error: string,
): PendingSend[] {
  return list.map((p) => (p.id === id ? { ...p, error } : p))
}

/** Remove a row whose send provably never happened — the cache guard's 409, for
 *  instance, where the turn did not run and the confirm bar takes over. */
export function dropPendingSend(list: readonly PendingSend[], id: string): PendingSend[] {
  return list.filter((p) => p.id !== id)
}

function sameText(a: string, b: string): boolean {
  return a === b || a.trim() === b.trim()
}

/** Is this text sitting in the server's prompt queue? A queued send gets its
 *  chip instead of a transcript row (and its `message.user` only at drain). */
function queuedAlready(queue: readonly QueueEntry[], text: string): boolean {
  return queue.some((e) => sameText(e.shown ?? "", text) || sameText(e.text ?? "", text))
}

/**
 * The pending rows still worth showing, given what the transcript now holds.
 *
 * A pending entry is resolved (and so omitted) when a user item it could be —
 * same text, at or after its baseline, not already claimed by an earlier
 * pending — is present, or when the prompt queue is holding it. Anything else
 * stays: an unmatched entry is never silently dropped, and a claimed item is
 * never claimed twice, so identical messages sent back to back resolve
 * first-in-first-out instead of collapsing into one row.
 */
export function unresolvedPendingSends(
  list: readonly PendingSend[],
  items: readonly Item[],
  queue: readonly QueueEntry[] = [],
): PendingSend[] {
  if (list.length === 0) return []
  const users = ownUserItems(items)
  const claimed = new Set<number>()
  const out: PendingSend[] = []
  for (const pending of list) {
    let at = -1
    for (let i = pending.baselineUserCount; i < users.length; i++) {
      if (claimed.has(i)) continue
      if (sameText(users[i]!.text, pending.text)) {
        at = i
        break
      }
    }
    if (at >= 0) {
      claimed.add(at)
      continue
    }
    if (queuedAlready(queue, pending.text)) continue
    out.push(pending)
  }
  return out
}

/** True when `list` is already exactly `next` — lets the caller prune resolved
 *  entries from state without a render loop. */
export function samePendingSends(
  list: readonly PendingSend[],
  next: readonly PendingSend[],
): boolean {
  return list.length === next.length && list.every((p, i) => p === next[i])
}

/** Presentation shape: the rows appended after the mapped transcript. */
export function pendingMessages(list: readonly PendingSend[]): Message[] {
  return list.map((p) => ({
    id: p.id,
    role: "user" as const,
    blocks: [{ type: "text" as const, content: p.text }],
    ...(p.imageCount ? { imageCount: p.imageCount } : {}),
    ...(p.error ? { sendError: p.error } : { sending: true }),
  }))
}
