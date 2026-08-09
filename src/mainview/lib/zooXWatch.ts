import { relativeTime } from "./format"
import { zooCheckXWatches, zooMarkXWatchExtracted, type ZooXWatch, type ZooXWatchResult } from "./zoo"
import { runExtraction, type ExtractionPhase } from "./zooExtraction"

export type XWatchRunPhase = "checking" | ExtractionPhase
export type XWatchRunResult = { results: ZooXWatchResult[]; added: number; insightCount: number | null; error?: string }

export function normalizeXHandleInput(value: string): string {
  return value.trim().replace(/^@+/, "")
}
export function xWatchNeedsExtraction(watch: ZooXWatch): boolean {
  return watch.lastArtifactAt !== undefined && (watch.lastExtractAt === undefined || watch.lastExtractAt < watch.lastArtifactAt)
}
export function xWatchStatusLabel(watch: ZooXWatch, now = Date.now()): string {
  if (!watch.lastStatus) return "Never checked"
  const attempt = watch.lastAttemptAt ? ` · ${relativeTime(watch.lastAttemptAt, now)}` : ""
  const success = watch.lastSuccessAt ? ` · last success ${relativeTime(watch.lastSuccessAt, now)}` : ""
  return `${watch.lastStatus === "error" ? "Failed — " : ""}${watch.lastNote ?? (watch.lastStatus === "ok" ? "Checked" : "Check failed")}${attempt}${success}`
}
export function summarizeXCheck(results: readonly ZooXWatchResult[]): string {
  if (!results.length) return "Nothing to check yet."
  const added = results.reduce((sum, row) => sum + row.added, 0)
  const failed = results.filter((row) => row.status === "error").length
  return `${added ? `${added} new post${added === 1 ? "" : "s"}` : "no new posts"}${failed ? ` · ${failed} failed` : ""}`
}
async function extract(watch: ZooXWatch, opts: { baseUrl?: string | null; onPhase?: (phase: XWatchRunPhase) => void }): Promise<XWatchRunResult> {
  const base = { results: [], added: 0, insightCount: null as number | null }
  if (!xWatchNeedsExtraction(watch)) return base
  if (!opts.baseUrl) return { ...base, error: "Extracting X activity needs a connected Chunky server." }
  const result = await runExtraction({ baseUrl: opts.baseUrl, areaId: watch.areaId ?? null, sourceId: watch.sourceId, ...(watch.lastExtractAt !== undefined ? { sinceFetchedAt: watch.lastExtractAt } : {}), focus: "competitor", ...(opts.onPhase ? { onPhase: opts.onPhase } : {}) })
  if (!result.ok) return { ...base, error: result.error }
  const marked = await zooMarkXWatchExtracted(watch.id)
  if (!marked.ok) return { ...base, error: marked.error }
  return { ...base, insightCount: result.insightCount }
}
export async function checkXAndExtract(watch: ZooXWatch | null, opts: { baseUrl?: string | null; onPhase?: (phase: XWatchRunPhase) => void } = {}): Promise<XWatchRunResult> {
  opts.onPhase?.("checking")
  const checked = await zooCheckXWatches(watch?.id ?? null)
  if (!checked.ok) return { results: [], added: 0, insightCount: null, error: checked.error }
  const added = checked.results.reduce((sum, row) => sum + row.added, 0)
  const failures = checked.results.filter((row) => row.status === "error").map((row) => `${row.label}: ${row.note ?? "Grok check failed"}`)
  const base = { results: checked.results, added, insightCount: null as number | null, ...(failures.length ? { error: failures.join(" · ") } : {}) }
  if (!watch || added === 0) return base
  const extraction = await extract({ ...watch, lastArtifactAt: checked.checkedAt }, opts)
  return { ...base, insightCount: extraction.insightCount, ...(extraction.error ? { error: extraction.error } : {}) }
}
export const extractPendingXWatch = extract
