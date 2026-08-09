// Competitor watch, renderer half.
//
// The Bun process fetches from GitHub and stores the delta as an artifact; this
// module does the part that needs the Chunky server: run the ORDINARY
// extraction pass over the new artifacts, with the competitor framing, so the
// signals land in the Inbox like any other uncited insight. No GitHub call is
// ever made here.

import { relativeTime } from "./format"
import {
  zooCheckRepoWatches,
  zooMarkWatchExtracted,
  type ZooRepoWatch,
  type ZooWatchResult,
} from "./zoo"
import { runExtraction, type ExtractionPhase } from "./zooExtraction"

export type WatchRunPhase = "checking" | ExtractionPhase

export type WatchRunResult = {
  /** Per-watch fetch outcomes, including skips — always reported. */
  results: ZooWatchResult[]
  /** Artifacts stored by this pass across every checked watch. */
  added: number
  /** Insights recorded from them; null when no synthesis was needed or possible. */
  insightCount: number | null
  /** A synthesis failure does not undo the check — it is reported alongside it. */
  error?: string
}

/** Does this watch have deltas the extraction pass has not read yet? */
export function needsSynthesis(watch: ZooRepoWatch): boolean {
  if (watch.lastArtifactAt === undefined) return false
  return watch.lastExtractAt === undefined || watch.lastExtractAt < watch.lastArtifactAt
}

/** One line for the Sources row: what happened at the last check. */
export function watchStatusLabel(watch: ZooRepoWatch, now = Date.now()): string {
  if (!watch.lastStatus) return "Never checked"
  const when = watch.lastCheckAt ? relativeTime(watch.lastCheckAt, now) : "recently"
  if (watch.lastStatus === "ok") return `${watch.lastNote ?? "Checked"} · ${when}`
  if (watch.lastStatus === "skipped") return `Skipped — ${watch.lastNote ?? "rate limited"}`
  return `Failed — ${watch.lastNote ?? "check failed"}`
}

export function summarizeCheck(results: readonly ZooWatchResult[]): string {
  if (!results.length) return "Nothing to check yet."
  const added = results.reduce((total, row) => total + row.added, 0)
  const skipped = results.filter((row) => row.status === "skipped").length
  const failed = results.filter((row) => row.status === "error").length
  const parts = [added ? `${added} new delta${added === 1 ? "" : "s"}` : "no new activity"]
  if (skipped) parts.push(`${skipped} skipped`)
  if (failed) parts.push(`${failed} failed`)
  return parts.join(" · ")
}

/**
 * Check one watch (or all of them) and, when something landed, synthesize it.
 *
 * The synthesis is `runExtraction` with `focus: "competitor"` — the same export,
 * session runner, fence parser and recorder every other pass uses. Scoping to
 * the watch's own source and to artifacts newer than its last pass keeps a
 * check from re-summarizing history.
 */
export async function checkAndSynthesize(
  watch: ZooRepoWatch | null,
  opts: {
    baseUrl?: string | null
    onPhase?: (phase: WatchRunPhase) => void
  } = {},
): Promise<WatchRunResult> {
  opts.onPhase?.("checking")
  const checked = await zooCheckRepoWatches(watch?.id ?? null)
  if (!checked.ok) return { results: [], added: 0, insightCount: null, error: checked.error }

  const added = checked.results.reduce((total, row) => total + row.added, 0)
  const base = { results: checked.results, added, insightCount: null as number | null }
  // Only a single-watch check can be synthesized on the spot: the pass is scoped
  // to one source, and "check all" may have touched several.
  if (!watch || added === 0) return base
  if (!opts.baseUrl) {
    return { ...base, error: "Stored the new activity — synthesizing it needs a connected Chunky server." }
  }

  const extraction = await runExtraction({
    baseUrl: opts.baseUrl,
    areaId: watch.areaId ?? null,
    sourceId: watch.sourceId,
    ...(watch.lastExtractAt !== undefined ? { sinceFetchedAt: watch.lastExtractAt } : {}),
    focus: "competitor",
    ...(opts.onPhase ? { onPhase: opts.onPhase } : {}),
  })
  if (!extraction.ok) return { ...base, error: extraction.error }

  await zooMarkWatchExtracted(watch.id)
  return { ...base, insightCount: extraction.insightCount }
}

/** Synthesize deltas that a scheduled (background) check already stored. */
export async function synthesizePending(
  watch: ZooRepoWatch,
  opts: { baseUrl?: string | null; onPhase?: (phase: WatchRunPhase) => void } = {},
): Promise<WatchRunResult> {
  const base = { results: [], added: 0, insightCount: null as number | null }
  if (!needsSynthesis(watch)) return base
  if (!opts.baseUrl) return { ...base, error: "Synthesizing needs a connected Chunky server." }
  const extraction = await runExtraction({
    baseUrl: opts.baseUrl,
    areaId: watch.areaId ?? null,
    sourceId: watch.sourceId,
    ...(watch.lastExtractAt !== undefined ? { sinceFetchedAt: watch.lastExtractAt } : {}),
    focus: "competitor",
    ...(opts.onPhase ? { onPhase: opts.onPhase } : {}),
  })
  if (!extraction.ok) return { ...base, error: extraction.error }
  await zooMarkWatchExtracted(watch.id)
  return { ...base, insightCount: extraction.insightCount }
}
