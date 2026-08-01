// Acting on a queued prompt: steer it into the running turn, or drop it.
//
// The whole point of the server's promote route is that the claim is ATOMIC
// (PromptQueue.take): the entry is either still queued — in which case this
// client now owns it and the server re-delivers it as a steer — or the queue
// drainer already took it. That removes the remove-then-resend race the naive
// client-side version would have, where a run ending mid-sequence could either
// drop the message or run it twice.
//
// What's left for the client is deciding what each outcome MEANS for the text
// the user typed, which is what `followUpFor` encodes.
import { promoteQueueEntry, sendMessage } from "./api"
import type { PromoteQueueResult } from "@chunky/protocol"

/** What the client must still do after a promote attempt. */
export type QueueFollowUp =
  /** The server delivered it. Nothing left to do. */
  | "none"
  /** It was already drained into a run — it IS executing. Re-sending would
   *  duplicate the work, so the text is safe precisely by doing nothing. */
  | "already-running"
  /** The server has no such entry and never drained one (e.g. it restarted and
   *  lost the in-memory queue). The text exists only in our chip, so it must be
   *  re-sent or it is lost. */
  | "resend"

/**
 * Map a promote outcome to the follow-up that neither LOSES nor DUPLICATES the
 * user's message.
 *
 * Note the asymmetry between the two failure outcomes — they look similar but
 * demand opposite actions:
 *   - "already-running" means the server DID have the entry and the drainer
 *     claimed it (PromptQueue.take reports `drained` from its drainedIds log),
 *     so the prompt is already running as its own turn. Re-sending it here
 *     would run the same instruction twice.
 *   - "not-found" means the server has no record of it at all, so nothing is
 *     running and the text would simply vanish. That one must be re-sent.
 */
export function followUpFor(outcome: PromoteQueueResult["outcome"]): QueueFollowUp {
  switch (outcome) {
    case "promoted":
      return "none"
    case "already-running":
      return "already-running"
    case "not-found":
      return "resend"
  }
}

/** Human wording for an outcome that didn't steer, shown on the chip. */
export function followUpNotice(followUp: QueueFollowUp): string | null {
  switch (followUp) {
    case "already-running":
      return "That message already started running, so it can't be steered."
    case "resend":
      return null // the resend is silent: the message simply goes out again
    case "none":
      return null
  }
}

export interface SteerQueuedResult {
  followUp: QueueFollowUp
  /** True when the fallback re-send actually went out. */
  resent: boolean
}

/**
 * Steer a queued message into the running turn, falling back to a normal send
 * only when the server has genuinely lost the entry.
 *
 * `text` is the chip's own copy of the prompt, used for that fallback — so a
 * server that forgot the queue (restart) still can't swallow what the user
 * typed. A blocked fallback (cache guard 409) throws, so the caller keeps the
 * chip on screen with the reason instead of silently dropping it or silently
 * forcing an expensive re-send.
 */
export async function steerQueuedMessage(
  baseUrl: string,
  sessionId: string,
  entryId: string,
  text: string,
): Promise<SteerQueuedResult> {
  const result = await promoteQueueEntry(baseUrl, sessionId, entryId, "steer")
  const followUp = followUpFor(result.outcome)
  if (followUp !== "resend") return { followUp, resent: false }

  const blocked = await sendMessage(baseUrl, sessionId, text, { delivery: "auto" })
  if (blocked) {
    throw new Error(
      "The server no longer had this queued message, and re-sending it was blocked by the cold-cache guard. Send it again to confirm.",
    )
  }
  return { followUp, resent: true }
}
