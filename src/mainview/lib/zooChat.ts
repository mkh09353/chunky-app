// "Talk to the Factory": hand the board to an ordinary Chunky session.
//
// The agent reads the board itself through the zoo_* tools the app announces
// (lib/appZoo.ts) rather than being handed a snapshot, so this is just a session
// plus an opening turn — no dedicated endpoint.

import { createSession, sendMessage } from "./api"
import type { ZooArea } from "./zoo"
import { resolveRepoForArea } from "./zooDecisions"
import { errorMessage } from "./zooExtraction"

export const FACTORY_OPENER =
  "You have zoo_* tools for my product-factory board. Pull up zoo_board and give me a quick read: what needs attention, what's stalled, and any suggestions."

export type FactoryChatResult = { ok: true; sessionId: string } | { ok: false; error: string }

export async function startFactoryChat(
  baseUrl: string | null | undefined,
  repoId: string | null | undefined,
  /** Area in view: its repo binds the conversation, and it frames the opener. */
  opts: { area?: ZooArea | null; opener?: string } = {},
): Promise<FactoryChatResult> {
  if (!baseUrl) return { ok: false, error: "Talking to the Factory needs a connected Chunky server." }
  const area = opts.area ?? null
  const opener =
    opts.opener ??
    (area
      ? `${FACTORY_OPENER}\n\nI am looking at the "${area.name}" area — focus there, but say so if something outside it matters.`
      : FACTORY_OPENER)
  try {
    const bound = await resolveRepoForArea(baseUrl, area, repoId)
    const { sessionId } = await createSession(baseUrl, bound)
    await sendMessage(baseUrl, sessionId, opener)
    return { ok: true, sessionId }
  } catch (err) {
    return { ok: false, error: errorMessage(err, "Could not start a Factory session.") }
  }
}
