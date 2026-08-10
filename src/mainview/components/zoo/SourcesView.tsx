// Sources: where evidence comes from, and where the runs that turn it into
// signals are kicked off. Connect/backfill/run wiring is unchanged from the old
// FactoryPane — it all lives in lib/zoo.ts, lib/zooExtraction.ts and
// lib/zooSynthesis.ts; this view only lays it out with room to breathe.

import { FolderOpen, LoaderCircle, MessageSquarePlus, Plug, RefreshCw, Sparkles } from "lucide-react"
import { useState, type FormEvent } from "react"
import { relativeTime } from "~/lib/format"
import { NO_DRAG_REGION } from "~/lib/dragRegion"
import { nativePickerAvailable, pickFolder } from "~/lib/pickFolder"
import { zooConnectLinear, zooConnectTranscripts, zooStartBackfill, type ZooArea, type ZooRepoWatch, type ZooXWatch, type ZooSource, type ZooStatus } from "~/lib/zoo"
import type { AreaSelection } from "~/lib/zooAreas"
import type { ExtractionPhase } from "~/lib/zooExtraction"
import { Button } from "../ui/button"
import { Input } from "../ui/input"
import type { AreaRepo, CreateAreaResult } from "./AreaSwitcher"
import { EmptyState, Notice, ViewHeader } from "./parts"
import { WatchList } from "./WatchList"
import { XWatchList } from "./XWatchList"

export type RunKind = "extraction" | "synthesis" | "triage"

export type RunState =
  | { kind: "idle" }
  | { kind: "running"; phase: ExtractionPhase; startedAt: number }
  | { kind: "done"; note: string }
  | { kind: "error"; error: string }

export const IDLE_RUNS: Record<RunKind, RunState> = {
  extraction: { kind: "idle" },
  synthesis: { kind: "idle" },
  triage: { kind: "idle" },
}

const PHASE_LABEL: Record<ExtractionPhase, string> = {
  exporting: "Bundling evidence",
  starting: "Starting a session",
  thinking: "Working",
  recording: "Recording results",
}

function backfillLabel(source: ZooSource): string {
  const { state, fetched, completedAt } = source.backfill
  if (state === "running") return `Backfilling — ${fetched} fetched`
  if (state === "done") return `${fetched} fetched${completedAt ? ` · ${relativeTime(completedAt)}` : ""}`
  if (state === "error") return "Backfill failed"
  return "Not backfilled yet"
}

export function RunLine({ state, elapsed }: { state: RunState; elapsed: number }) {
  if (state.kind === "running") {
    return (
      <p className="flex items-center gap-2 text-[12px] text-muted-foreground">
        <LoaderCircle className="size-3.5 animate-spin text-primary" />
        {PHASE_LABEL[state.phase]} · {Math.floor(elapsed / 1000)}s
      </p>
    )
  }
  if (state.kind === "done") return <p className="text-[12px] text-muted-foreground">{state.note}</p>
  if (state.kind === "error") return <Notice text={state.error} />
  return null
}

export function SourcesView({
  status,
  sources,
  areaId,
  areaName,
  runs,
  elapsed,
  onRun,
  onRefresh,
  baseUrl,
  canTriage,
  insightCount,
  watches,
  areas,
  watchHour,
  watchLastRunAt,
  xWatches,
  xWatchIntervalMinutes,
  xWatchLastSuccessAt,
  onAssignArea,
  repos = [],
  onCreateArea,
  onOpenSetup,
}: {
  status: ZooStatus | null
  /** Sources narrowed to the selected area (unassigned ones stay visible). */
  sources: readonly ZooSource[]
  /** Area new sources are connected into; null = unassigned. */
  areaId: AreaSelection
  areaName: string | null
  runs: Record<RunKind, RunState>
  elapsed: number
  onRun: (kind: RunKind) => void
  onRefresh: () => Promise<void>
  baseUrl?: string | null
  /** A selected repo or an area repo path can bind the triage session. */
  canTriage: boolean
  insightCount: number
  watches: ZooRepoWatch[]
  areas: ZooArea[]
  watchHour: number
  watchLastRunAt: number | null
  xWatches: ZooXWatch[]
  xWatchIntervalMinutes: number
  xWatchLastSuccessAt: number | null
  onAssignArea: (sourceId: string, areaId: string | null) => void
  /** Registered repositories, for the assignment menus' inline create dialog. */
  repos?: readonly AreaRepo[]
  /** Create an area inline; the watch being edited moves into it on success. */
  onCreateArea?: (name: string, repoPaths: string[]) => Promise<CreateAreaResult>
  onOpenSetup: () => void
}) {
  const [apiKey, setApiKey] = useState("")
  const [folder, setFolder] = useState("")
  const [connecting, setConnecting] = useState<"linear" | "transcripts" | null>(null)
  const [error, setError] = useState<string | null>(null)

  const artifactCount = status?.artifactCount ?? 0
  const connected = sources.filter((source) => source.kind !== "repo-watch" && source.kind !== "x-watch")

  const connectLinear = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const key = apiKey.trim()
    if (!key || connecting) return
    setConnecting("linear")
    setError(null)
    const result = await zooConnectLinear(key, areaId)
    setConnecting(null)
    if (!result.ok) {
      setError(result.error)
      return
    }
    setApiKey("")
    await onRefresh()
  }

  const connectTranscripts = async (path?: string) => {
    const target = (path ?? folder).trim()
    if (!target || connecting) return
    setConnecting("transcripts")
    setError(null)
    const result = await zooConnectTranscripts(target, areaId)
    setConnecting(null)
    if (!result.ok) {
      setError(result.error)
      return
    }
    setFolder("")
    await onRefresh()
  }

  const browseFolder = async () => {
    const picked = await pickFolder()
    if (!picked) return
    setFolder(picked)
    await connectTranscripts(picked)
  }

  const startBackfill = async (sourceId: string) => {
    const result = await zooStartBackfill(sourceId)
    if (!result.ok) setError(result.error)
    await onRefresh()
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <ViewHeader
        title="Sources"
        subtitle={`${artifactCount} artifact${artifactCount === 1 ? "" : "s"} · ${insightCount} insight${insightCount === 1 ? "" : "s"}${areaName ? ` · ${areaName}` : ""}`}
      />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-5 overflow-y-auto px-6 pb-8">
        {error && <Notice text={error} />}
        <section className="flex min-w-0 flex-wrap items-center gap-3 rounded-xl border border-primary/25 bg-primary/5 p-4">
          <div className="min-w-48 flex-1">
            <p className="font-medium text-[13px] text-foreground">Add a source with Chunky</p>
            <p className="mt-1 whitespace-pre-wrap break-words text-[12px] text-muted-foreground">Describe an evidence source or workflow and continue in a repository-bound setup conversation.</p>
          </div>
          <Button className={NO_DRAG_REGION} onClick={onOpenSetup}><MessageSquarePlus /> Add source</Button>
        </section>
        {areaName && (
          <Notice
            text={`Sources you connect here join the “${areaName}” area. Sources with no area stay visible in every one.`}
            tone="muted"
          />
        )}

        <WatchList
          watches={watches}
          areas={areas}
          hour={watchHour}
          lastRunAt={watchLastRunAt}
          areaId={areaId}
          baseUrl={baseUrl}
          onRefresh={onRefresh}
          onAssignArea={onAssignArea}
          repos={repos}
          {...(onCreateArea ? { onCreateArea } : {})}
        />
        <XWatchList watches={xWatches} areas={areas} intervalMinutes={xWatchIntervalMinutes} lastSuccessAt={xWatchLastSuccessAt} areaId={areaId} baseUrl={baseUrl} onRefresh={onRefresh} onAssignArea={onAssignArea} repos={repos} {...(onCreateArea ? { onCreateArea } : {})} />

        {connected.length === 0 ? (
          <EmptyState
            icon={<Plug className="size-5" />}
            title="No sources connected"
            body="Connect Linear, transcripts, competitor repositories, or X accounts — the factory reads evidence from them and nothing else."
          />
        ) : (
          <ul className="flex min-w-0 flex-col gap-2">
            {connected.map((source) => (
              <li
                key={source.id}
                className="flex min-w-0 flex-col gap-1 rounded-xl border border-border/70 bg-card/60 p-3"
              >
                <div className="flex min-w-0 items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-[13px] text-foreground" title={source.label}>
                    {source.label}
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={source.backfill.state === "running"}
                    onClick={() => void startBackfill(source.id)}
                  >
                    {source.backfill.state === "running" ? (
                      <LoaderCircle className="animate-spin" />
                    ) : (
                      <RefreshCw />
                    )}
                    {source.backfill.state === "done" || source.backfill.state === "error"
                      ? "Re-run"
                      : "Backfill"}
                  </Button>
                </div>
                <p className="text-[11.5px] text-muted-foreground">{backfillLabel(source)}</p>
                {source.backfill.error && <Notice text={source.backfill.error} />}
              </li>
            ))}
          </ul>
        )}

        <section className="grid min-w-0 gap-4 md:grid-cols-2">
          <form
            onSubmit={connectLinear}
            className="flex min-w-0 flex-col gap-2 rounded-xl border border-border/70 bg-card/60 p-3"
          >
            <p className="font-medium text-[13px] text-foreground">Connect Linear</p>
            <Input
              type="password"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder="lin_api_…"
              autoComplete="off"
              spellCheck={false}
              aria-label="Linear API key"
            />
            <Button type="submit" size="sm" disabled={connecting !== null || !apiKey.trim()} className="self-start">
              {connecting === "linear" && <LoaderCircle className="animate-spin" />}
              Connect
            </Button>
          </form>

          <div className="flex min-w-0 flex-col gap-2 rounded-xl border border-border/70 bg-card/60 p-3">
            <p className="font-medium text-[13px] text-foreground">Connect a transcripts folder</p>
            <Input
              value={folder}
              onChange={(event) => setFolder(event.target.value)}
              placeholder="/path/to/transcripts"
              spellCheck={false}
              aria-label="Transcripts folder"
            />
            <div className="flex gap-1.5">
              <Button
                size="sm"
                disabled={connecting !== null || !folder.trim()}
                onClick={() => void connectTranscripts()}
              >
                {connecting === "transcripts" && <LoaderCircle className="animate-spin" />}
                Connect
              </Button>
              {nativePickerAvailable() && (
                <Button size="sm" variant="outline" disabled={connecting !== null} onClick={() => void browseFolder()}>
                  <FolderOpen />
                  Browse
                </Button>
              )}
            </div>
          </div>
        </section>

        <section className="flex min-w-0 flex-col gap-2 rounded-xl border border-border/70 bg-card/60 p-3">
          <p className="font-medium text-[13px] text-foreground">Runs</p>
          <div className="flex flex-wrap gap-1.5">
            <Button
              size="sm"
              variant="outline"
              disabled={runs.extraction.kind === "running" || artifactCount === 0 || !baseUrl}
              onClick={() => onRun("extraction")}
            >
              {runs.extraction.kind === "running" ? <LoaderCircle className="animate-spin" /> : <Sparkles />}
              Run extraction
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={runs.synthesis.kind === "running" || insightCount === 0 || !baseUrl}
              onClick={() => onRun("synthesis")}
            >
              {runs.synthesis.kind === "running" ? <LoaderCircle className="animate-spin" /> : <Sparkles />}
              Synthesize ideas
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={runs.triage.kind === "running" || artifactCount === 0 || !baseUrl || !canTriage}
              title={canTriage ? undefined : "Select a repository or configure this area's repo path"}
              onClick={() => onRun("triage")}
            >
              {runs.triage.kind === "running" ? <LoaderCircle className="animate-spin" /> : <Sparkles />}
              Triage backlog
            </Button>
          </div>
          <RunLine state={runs.extraction} elapsed={elapsed} />
          <RunLine state={runs.synthesis} elapsed={elapsed} />
          <RunLine state={runs.triage} elapsed={elapsed} />
          {artifactCount === 0 && (
            <Notice text="Backfill a source first — the runs need artifacts to work from." tone="muted" />
          )}
          {artifactCount > 0 && !baseUrl && <Notice text="Runs need a connected Chunky server." tone="muted" />}
        </section>
      </div>
    </div>
  )
}
