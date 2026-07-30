// Ideas -> Items. Promoting an idea is the point where the factory hands work
// to Chunky itself: a repo-bound session with a goal built from the idea and
// the evidence quotes behind it, recorded on the item as durable provenance.

import { createSession, loadConfig, sendMessage, setGoal } from "./api"
import {
  zooCreateItem,
  zooListInsights,
  zooUpdateItem,
  type ZooIdea,
  type ZooInsight,
  type ZooItem,
  type ZooItemStage,
} from "./zoo"
import { errorMessage } from "./zooExtraction"

export type ItemFlowResult =
  | { ok: true; item: ZooItem; sessionId?: string }
  | { ok: false; error: string; item?: ZooItem }

/** Quotes are capped so a chatty insight cannot crowd out the brief itself. */
const MAX_QUOTES = 12
const MAX_QUOTE_CHARS = 600

/**
 * The research objective handed to the promoted item's session. Pure so it can
 * be asserted on directly: title and rationale always appear, and every cited
 * insight contributes its evidence quotes verbatim.
 */
export function buildResearchBrief(idea: ZooIdea, insights: ZooInsight[]): string {
  const cited = insights.filter((insight) => idea.insightIds.includes(insight.id))
  const lines: string[] = [
    `Research this product idea and report what should happen next: ${idea.title}`,
    "",
    "Why it was proposed:",
    idea.rationale,
    "",
    `Proposed disposition: ${idea.type}`,
  ]

  if (cited.length) {
    lines.push("", "Evidence behind it:")
    let quotes = 0
    for (const insight of cited) {
      lines.push(`- ${insight.title}: ${insight.summary}`)
      for (const cite of insight.evidence) {
        if (quotes >= MAX_QUOTES) break
        quotes += 1
        lines.push(`  "${cite.quote.slice(0, MAX_QUOTE_CHARS)}"`)
      }
    }
  } else {
    lines.push("", "No recorded insight evidence is attached to this idea.")
  }

  lines.push(
    "",
    "Work in this repository: confirm what already exists, what the change would",
    "touch, and the risks. Do not implement anything yet. Finish with a short",
    "recommendation (do it / drop it / needs a spike) and the reasoning behind it.",
  )
  return lines.join("\n")
}

async function resolveBaseUrl(baseUrl?: string | null): Promise<string | null> {
  if (baseUrl) return baseUrl
  try {
    return (await loadConfig()).baseUrl || null
  } catch {
    return null
  }
}

/**
 * Promote an idea: create the item, start a repo-bound research session with a
 * goal built from the idea's evidence, and log both on the item.
 *
 * A failure AFTER the item exists is recorded as an agent decision rather than
 * discarded, so the item never appears in the queue without an explanation.
 */
export async function promoteIdea(
  idea: ZooIdea,
  repoId: string | null | undefined,
  opts: { baseUrl?: string | null } = {},
): Promise<ItemFlowResult> {
  if (!repoId) return { ok: false, error: "Promoting needs a selected repository." }

  const created = await zooCreateItem(idea.id)
  if (!created.ok) return { ok: false, error: created.error }
  const item = created.item

  const noteFailure = async (error: string): Promise<ItemFlowResult> => {
    const logged = await zooUpdateItem(item.id, {
      addDecision: { actor: "agent", note: `Research session could not start: ${error}` },
    })
    return { ok: false, error, item: logged.ok ? logged.item : item }
  }

  const baseUrl = await resolveBaseUrl(opts.baseUrl)
  if (!baseUrl) return noteFailure("No Chunky server is available.")

  // Best effort: a brief without quotes still beats no research session.
  const listed = await zooListInsights()
  const brief = buildResearchBrief(idea, listed.ok ? listed.insights : [])

  let sessionId: string
  try {
    sessionId = (await createSession(baseUrl, repoId)).sessionId
  } catch (err) {
    return noteFailure(errorMessage(err, "Could not create a research session."))
  }

  try {
    await setGoal(baseUrl, sessionId, { objective: brief, mode: "direct" })
  } catch (err) {
    return noteFailure(errorMessage(err, "Could not set the research goal."))
  }

  const updated = await zooUpdateItem(item.id, {
    addSessionId: sessionId,
    addDecision: { actor: "user", note: "Promoted for research" },
  })
  if (!updated.ok) return { ok: false, error: updated.error, item }
  return { ok: true, item: updated.item, sessionId }
}

/** The item's newest session — where feedback and follow-ups go. */
export function latestSessionId(item: ZooItem): string | null {
  return item.sessionIds.length ? item.sessionIds[item.sessionIds.length - 1]! : null
}

/**
 * Course-correct an in-flight item: the note goes to its session as a message
 * and onto its decision log. The stage is deliberately left alone.
 */
export async function sendItemFeedback(
  item: ZooItem,
  text: string,
  opts: { baseUrl?: string | null } = {},
): Promise<ItemFlowResult> {
  const note = text.trim()
  if (!note) return { ok: false, error: "Feedback cannot be empty.", item }
  const sessionId = latestSessionId(item)
  if (!sessionId) return { ok: false, error: "This item has no session to send feedback to.", item }

  const baseUrl = await resolveBaseUrl(opts.baseUrl)
  if (!baseUrl) return { ok: false, error: "No Chunky server is available.", item }

  try {
    await sendMessage(baseUrl, sessionId, note)
  } catch (err) {
    return { ok: false, error: errorMessage(err, "Could not send the feedback."), item }
  }

  const updated = await zooUpdateItem(item.id, {
    addDecision: { actor: "user", note: `Change requested: ${note}` },
  })
  if (!updated.ok) return { ok: false, error: updated.error, item }
  return { ok: true, item: updated.item, sessionId }
}

const NEXT_STAGE: Partial<Record<ZooItemStage, ZooItemStage>> = {
  research: "decision",
  decision: "building",
  building: "review",
  review: "shipped",
}

/** The stage an approval moves an item to, or null at the end of the line. */
export function nextStage(stage: ZooItemStage): ZooItemStage | null {
  return NEXT_STAGE[stage] ?? null
}

/** Approve: advance one stage and log who decided it. */
export async function advanceItem(item: ZooItem, note?: string): Promise<ItemFlowResult> {
  const stage = nextStage(item.stage)
  if (!stage) return { ok: false, error: `An item in "${item.stage}" cannot advance.`, item }
  const updated = await zooUpdateItem(item.id, {
    stage,
    addDecision: { actor: "user", note: note?.trim() || `Approved: ${item.stage} to ${stage}` },
  })
  return updated.ok ? { ok: true, item: updated.item } : { ok: false, error: updated.error, item }
}

/** Drop: park the item with a reason on the log. */
export async function dropItem(item: ZooItem, note?: string): Promise<ItemFlowResult> {
  const updated = await zooUpdateItem(item.id, {
    stage: "dropped",
    addDecision: { actor: "user", note: note?.trim() || `Dropped from ${item.stage}` },
  })
  return updated.ok ? { ok: true, item: updated.item } : { ok: false, error: updated.error, item }
}
