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

export type ResearchSessionDeps = {
  resolveBaseUrl: (baseUrl?: string | null) => Promise<string | null>
  listInsights: typeof zooListInsights
  create: typeof createSession
  goal: typeof setGoal
  update: typeof zooUpdateItem
}

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

  const started = await startResearchSession(item, idea, repoId, { ...opts, decisionNote: "Promoted for research" })
  return started.ok ? started : noteFailure(started.error)
}

/** Start the canonical goal session for an existing research item. This is also
 * the repair path for agent-promoted items, whose fixed server tool deliberately
 * creates an item without a session. */
export async function startResearchSessionWithDeps(item: ZooItem, idea: ZooIdea, repoId: string | null | undefined, opts: { baseUrl?: string | null; decisionNote?: string }, deps: ResearchSessionDeps): Promise<ItemFlowResult> {
  if (!repoId) return { ok: false, error: "Research needs a selected repository.", item }
  if (item.stage !== "research") return { ok: false, error: "Only a research-stage item can start research.", item }
  if (item.sessionIds.length) return { ok: false, error: "This item already has a research session.", item }
  if (item.ideaId !== idea.id) return { ok: false, error: "The item does not match its originating idea.", item }
  const baseUrl = await deps.resolveBaseUrl(opts.baseUrl); if (!baseUrl) return { ok: false, error: "No Chunky server is available.", item }
  const listed = await deps.listInsights(); const brief = buildResearchBrief(idea, listed.ok ? listed.insights : [])
  let sessionId: string
  try { sessionId = (await deps.create(baseUrl, repoId)).sessionId } catch (err) { return { ok: false, error: errorMessage(err, "Could not create a research session."), item } }
  try { await deps.goal(baseUrl, sessionId, { objective: brief, mode: "direct" }) } catch (err) { return { ok: false, error: errorMessage(err, "Could not set the research goal."), item } }
  const updated = await deps.update(item.id, { addSessionId: sessionId, addDecision: { actor: "user", note: opts.decisionNote ?? "Research session started" } })
  return updated.ok ? { ok: true, item: updated.item, sessionId } : { ok: false, error: `Research started, but the Zoo could not link the session: ${updated.error}`, item }
}

export const startResearchSession = (item: ZooItem, idea: ZooIdea, repoId: string | null | undefined, opts: { baseUrl?: string | null; decisionNote?: string } = {}) => startResearchSessionWithDeps(item, idea, repoId, opts, { resolveBaseUrl, listInsights: zooListInsights, create: createSession, goal: setGoal, update: zooUpdateItem })

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
