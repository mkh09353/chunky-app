// Insights -> Ideas. Two passes share the ideas contract:
//
//   runSynthesis  cross-references recorded insights into proposed work.
//   runTriage     reads the Linear artifact bundle AND the repo's code, then
//                 proposes work for the ~10 most valuable backlog tickets.
//
// Both reuse the session runner and the fenced-JSON shape check in
// lib/zooExtraction.ts, and both record through lib/zoo.ts wrappers.

import {
  IDEA_TYPES,
  zooExportForExtraction,
  zooExportInsightsForSynthesis,
  zooFailPass,
  zooRecordIdeas,
  type ZooIdeaInput,
  type ZooIdeaType,
} from "./zoo"
import { parseFencedRows, runSessionPrompt, type ExtractionPhase } from "./zooExtraction"

/** Triage explores a codebase, so it gets a much longer leash than a pure
 *  reasoning pass. */
const TRIAGE_TIMEOUT_MS = 30 * 60_000

export type IdeasPhase = ExtractionPhase
export type IdeasResult =
  | { ok: true; passId: string; ideaCount: number; dropped: number }
  | { ok: false; error: string; passId?: string }

export type ParsedIdeas =
  | { ok: true; ideas: ZooIdeaInput[]; dropped: number }
  | { ok: false; error: string }

const IDEA_TYPE_SET = new Set<string>(IDEA_TYPES)

/**
 * Parse the model's reply into proposed ideas.
 *
 * DELIBERATELY LENIENT, unlike the insights parser: an entry with an unknown
 * `type` or a missing title/rationale is DROPPED and counted, and only a reply
 * with no usable entry at all fails the pass. These runs are expensive (triage
 * explores a whole repository), so losing nine good proposals to one
 * hallucinated type would be the worse failure. The Bun store validates every
 * surviving entry again before it is written, and the drop count is surfaced in
 * the pane so a sloppy model is still visible.
 */
export function parseFencedIdeas(text: string): ParsedIdeas {
  const fenced = parseFencedRows(text)
  if (!fenced.ok) return fenced
  const ideas: ZooIdeaInput[] = []
  let dropped = 0
  for (const row of fenced.rows) {
    const type = typeof row.type === "string" ? row.type.trim().toLowerCase() : ""
    const title = typeof row.title === "string" ? row.title.trim() : ""
    const rationale = typeof row.rationale === "string" ? row.rationale.trim() : ""
    if (!IDEA_TYPE_SET.has(type) || !title || !rationale) {
      dropped += 1
      continue
    }
    const insightIds: string[] = []
    if (Array.isArray(row.insightIds)) {
      for (const raw of row.insightIds) {
        const id = typeof raw === "string" ? raw.trim() : ""
        if (id) insightIds.push(id)
      }
    }
    ideas.push({ type: type as ZooIdeaType, title, rationale, insightIds })
  }
  if (!ideas.length) {
    return {
      ok: false,
      error: dropped
        ? `The model returned ${dropped} idea${dropped === 1 ? "" : "s"}, none in the required shape.`
        : "The model returned an empty idea array.",
    }
  }
  return { ok: true, ideas, dropped }
}

const IDEA_SCHEMA = [
  "Reply with ONLY a fenced ```json block containing an array of objects:",
  '{ "type": "close" | "investigate" | "build" | "needs-detail",',
  '  "title": string, "rationale": string, "insightIds": [string] }',
  "No prose before or after the block.",
]

export function buildSynthesisPrompt(bundle: string): string {
  return [
    "You are the product lead for this codebase, reviewing insights already",
    "extracted from connected sources. Each insight below carries an insightId.",
    "",
    "Synthesize these insights into proposed work ideas. Cross-reference across",
    "sources: an idea supported by several independent insights is stronger than",
    "one raised once. Say plainly in the rationale which evidence supports it and",
    "what makes it worth doing (or worth closing).",
    "",
    'Use "close" for work the evidence says should be dropped, "investigate" for',
    'open questions, "build" for work ready to be specified, and "needs-detail"',
    "when the signal is real but too thin to act on.",
    "",
    ...IDEA_SCHEMA,
    'Cite the supporting insightIds in "insightIds" — do not invent ids.',
    "",
    "--- INSIGHTS ---",
    bundle,
  ].join("\n")
}

export function buildTriagePrompt(bundle: string): string {
  return [
    "You are triaging this repository's backlog. The tickets below come from the",
    "connected Linear workspace; each carries an artifactId.",
    "",
    "Pick roughly the ten most valuable tickets, then EXPLORE THIS CODEBASE to",
    "judge each one: is it already done, cheap, risky, or blocked by something",
    "the code makes obvious? Read the files you need before deciding.",
    "",
    "Propose work ideas from that reading. In each rationale, name the ticket and",
    "the specific files or behaviour in the code that justify your call.",
    "",
    'Use "close" for tickets the code shows are obsolete or already shipped,',
    '"investigate" for ones needing a spike, "build" for ones ready to implement,',
    'and "needs-detail" for ones too vague to act on.',
    "",
    ...IDEA_SCHEMA,
    'Leave "insightIds" as an empty array — these ideas come from tickets, not',
    "recorded insights.",
    "",
    "--- BACKLOG TICKETS ---",
    bundle,
  ].join("\n")
}

async function recordPass(
  passId: string,
  reply: { ok: true; text: string } | { ok: false; error: string },
  phase: (next: IdeasPhase) => void,
): Promise<IdeasResult> {
  const failPass = async (error: string): Promise<IdeasResult> => {
    await zooFailPass(passId, error)
    return { ok: false, error, passId }
  }
  if (!reply.ok) return failPass(reply.error)

  const parsed = parseFencedIdeas(reply.text)
  if (!parsed.ok) return failPass(parsed.error)

  phase("recording")
  const recorded = await zooRecordIdeas(passId, parsed.ideas)
  if (!recorded.ok) return failPass(recorded.error)
  return { ok: true, passId, ideaCount: recorded.ideaCount, dropped: parsed.dropped }
}

/** Insights -> proposed ideas. No repo binding: this pass only reasons. */
export async function runSynthesis(
  opts: { baseUrl?: string | null; maxChars?: number; onPhase?: (phase: IdeasPhase) => void } = {},
): Promise<IdeasResult> {
  const phase = (next: IdeasPhase) => opts.onPhase?.(next)

  phase("exporting")
  const exported = await zooExportInsightsForSynthesis(opts.maxChars)
  if (!exported.ok) return { ok: false, error: exported.error }

  phase("starting")
  const reply = await runSessionPrompt({
    prompt: buildSynthesisPrompt(exported.bundle),
    baseUrl: opts.baseUrl ?? null,
    onSession: () => phase("thinking"),
  })
  return recordPass(exported.passId, reply, phase)
}

/**
 * Backlog tickets + the repository itself -> proposed ideas. Needs a repoId:
 * the session must be bound to the workspace it is asked to read.
 */
export async function runTriage(
  repoId: string,
  opts: { baseUrl?: string | null; maxChars?: number; onPhase?: (phase: IdeasPhase) => void } = {},
): Promise<IdeasResult> {
  const phase = (next: IdeasPhase) => opts.onPhase?.(next)
  if (!repoId) return { ok: false, error: "Triage needs a selected repository." }

  phase("exporting")
  const exported = await zooExportForExtraction(opts.maxChars)
  if (!exported.ok) return { ok: false, error: exported.error }

  phase("starting")
  const reply = await runSessionPrompt({
    prompt: buildTriagePrompt(exported.bundle),
    baseUrl: opts.baseUrl ?? null,
    repoId,
    timeoutMs: TRIAGE_TIMEOUT_MS,
    onSession: () => phase("thinking"),
  })
  return recordPass(exported.passId, reply, phase)
}
