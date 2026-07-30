import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Factory,
  FolderOpen,
  LoaderCircle,
  MessageSquare,
  Quote,
  RefreshCw,
  Sparkles,
  Trash2,
  X,
} from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { FormEvent, ReactNode } from "react"
import { cn } from "~/lib/cn"
import { relativeTime } from "~/lib/format"
import { openExternal } from "~/lib/openExternal"
import { nativePickerAvailable, pickFolder } from "~/lib/pickFolder"
import {
  ZOO_UNAVAILABLE,
  zooAvailable,
  zooConnectLinear,
  zooConnectTranscripts,
  zooGetArtifact,
  zooListIdeas,
  zooListInsights,
  zooListItems,
  zooSetIdeaStatus,
  zooStartBackfill,
  zooStatus,
  type ZooArtifactDetail,
  type ZooIdea,
  type ZooIdeaType,
  type ZooInsight,
  type ZooItem,
  type ZooItemStage,
  type ZooSource,
  type ZooStatus,
} from "~/lib/zoo"
import { runExtraction, type ExtractionPhase } from "~/lib/zooExtraction"
import {
  advanceItem,
  dropItem,
  latestSessionId,
  nextStage,
  promoteIdea,
  sendItemFeedback,
} from "~/lib/zooItemFlow"
import { runSynthesis, runTriage } from "~/lib/zooSynthesis"
import { Button } from "./ui/button"
import { Input } from "./ui/input"

const POLL_MS = 2000

const PHASE_LABEL: Record<ExtractionPhase, string> = {
  exporting: "Bundling evidence",
  starting: "Starting a session",
  thinking: "Working",
  recording: "Recording results",
}

const IDEA_TYPE_LABEL: Record<ZooIdeaType, string> = {
  close: "Close",
  investigate: "Investigate",
  build: "Build",
  "needs-detail": "Needs detail",
}

const IDEA_TYPE_TONE: Record<ZooIdeaType, string> = {
  close: "border-border bg-muted/40 text-muted-foreground",
  investigate: "border-primary/30 bg-primary/10 text-primary",
  build: "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  "needs-detail": "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400",
}

const STAGE_LABEL: Record<ZooItemStage, string> = {
  research: "Research",
  decision: "Decision",
  building: "Building",
  review: "Review",
  shipped: "Shipped",
  dropped: "Dropped",
}

type RunKind = "extraction" | "synthesis" | "triage"

type RunState =
  | { kind: "idle" }
  | { kind: "running"; phase: ExtractionPhase; startedAt: number }
  | { kind: "done"; note: string }
  | { kind: "error"; error: string }

const IDLE_RUNS: Record<RunKind, RunState> = {
  extraction: { kind: "idle" },
  synthesis: { kind: "idle" },
  triage: { kind: "idle" },
}

function backfillLabel(source: ZooSource): string {
  const { state, fetched, completedAt } = source.backfill
  if (state === "running") return `Backfilling — ${fetched} fetched`
  if (state === "done") {
    return `${fetched} fetched${completedAt ? ` · ${relativeTime(completedAt)}` : ""}`
  }
  if (state === "error") return "Backfill failed"
  return "Not backfilled yet"
}

function priorityTone(priority: number): string {
  if (priority <= 2) return "border-destructive/40 bg-destructive/10 text-destructive"
  if (priority === 3) return "border-primary/30 bg-primary/10 text-primary"
  return "border-border bg-muted/40 text-muted-foreground"
}

function Section({ title, count, action, children }: { title: string; count?: number; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <header className="flex min-h-6 items-center justify-between gap-2">
        <h3 className="font-medium text-[11px] uppercase tracking-wide text-muted-foreground">
          {title}
          {count !== undefined && count > 0 ? ` · ${count}` : ""}
        </h3>
        {action}
      </header>
      {children}
    </section>
  )
}

function Notice({ text, tone = "error" }: { text: string; tone?: "error" | "muted" }) {
  return (
    <p
      className={cn(
        "flex items-start gap-1.5 rounded-lg border px-2.5 py-2 text-[12px] leading-relaxed",
        tone === "error"
          ? "border-destructive/30 bg-destructive/10 text-destructive"
          : "border-border/70 bg-muted/30 text-muted-foreground",
      )}
    >
      {tone === "error" && <AlertCircle className="mt-px size-3.5 shrink-0" />}
      <span className="min-w-0 break-words">{text}</span>
    </p>
  )
}

function Badge({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <span className={cn("shrink-0 rounded-full border px-1.5 py-0.5 font-medium text-[10px]", className)}>
      {children}
    </span>
  )
}

function RunLine({ state, elapsed }: { state: RunState; elapsed: number }) {
  if (state.kind === "running") {
    return (
      <p className="flex items-center gap-2 text-[11.5px] text-muted-foreground">
        <LoaderCircle className="size-3.5 animate-spin text-primary" />
        {PHASE_LABEL[state.phase]} · {Math.floor(elapsed / 1000)}s
      </p>
    )
  }
  if (state.kind === "done") return <p className="text-[11.5px] text-muted-foreground">{state.note}</p>
  if (state.kind === "error") return <Notice text={state.error} />
  return null
}

/**
 * The product-factory surface: an attention queue over the
 * Sources -> Insights -> Ideas -> Items pipeline.
 *
 * "Needs you" is the primary view (proposed ideas plus items waiting on a
 * decision); raw insights and their evidence stay reachable under "Signals".
 * Everything store- and server-side goes through lib/zoo.ts,
 * lib/zooExtraction.ts, lib/zooSynthesis.ts and lib/zooItemFlow.ts — this
 * component never touches the RPC bridge or the server itself.
 *
 * @param baseUrl Live Chunky server used for runs and item sessions, or null
 *   when there is none (offline/demo) — run actions stay disabled.
 * @param repoId Currently selected repository; triage and promotion bind their
 *   sessions to it, and both are disabled without one.
 * @param onOpenSession Select an item's session in the main chat view.
 */
export function FactoryPane({
  onClose,
  baseUrl,
  repoId,
  onOpenSession,
}: {
  onClose: () => void
  baseUrl?: string | null
  repoId?: string | null
  onOpenSession?: (sessionId: string) => void
}) {
  const [available] = useState(zooAvailable)
  const [tab, setTab] = useState<"queue" | "signals">("queue")
  const [status, setStatus] = useState<ZooStatus | null>(null)
  const [statusError, setStatusError] = useState<string | null>(null)
  const [insights, setInsights] = useState<ZooInsight[]>([])
  const [ideas, setIdeas] = useState<ZooIdea[]>([])
  const [items, setItems] = useState<ZooItem[]>([])

  const [apiKey, setApiKey] = useState("")
  const [folder, setFolder] = useState("")
  const [connecting, setConnecting] = useState<"linear" | "transcripts" | null>(null)
  const [connectError, setConnectError] = useState<string | null>(null)

  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [artifact, setArtifact] = useState<ZooArtifactDetail | null>(null)
  const [artifactLoading, setArtifactLoading] = useState(false)
  const [artifactError, setArtifactError] = useState<string | null>(null)

  const [runs, setRuns] = useState<Record<RunKind, RunState>>(IDLE_RUNS)
  const [elapsed, setElapsed] = useState(0)
  const runningRef = useRef<Set<RunKind>>(new Set())

  const [busyId, setBusyId] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [feedbackFor, setFeedbackFor] = useState<string | null>(null)
  const [feedbackText, setFeedbackText] = useState("")

  const refresh = useCallback(async () => {
    const [next, insightList, ideaList, itemList] = await Promise.all([
      zooStatus(),
      zooListInsights(),
      zooListIdeas(),
      zooListItems(),
    ])
    if (next.ok) {
      setStatus({
        sources: next.sources,
        artifactCount: next.artifactCount,
        insightCount: next.insightCount,
        ideaCount: next.ideaCount,
        itemCount: next.itemCount,
        passes: next.passes,
      })
      setStatusError(null)
    } else if (!next.unavailable) {
      setStatusError(next.error)
    }
    if (insightList.ok) setInsights(insightList.insights)
    if (ideaList.ok) setIdeas(ideaList.ideas)
    if (itemList.ok) setItems(itemList.items)
  }, [])

  useEffect(() => {
    if (!available) return
    void refresh()
  }, [available, refresh])

  // Poll only while a backfill is actually in flight.
  const backfilling = !!status?.sources.some((source) => source.backfill.state === "running")
  useEffect(() => {
    if (!available || !backfilling) return
    const timer = setInterval(() => void refresh(), POLL_MS)
    return () => clearInterval(timer)
  }, [available, backfilling, refresh])

  const anyRunning = Object.values(runs).some((run) => run.kind === "running")
  useEffect(() => {
    if (!anyRunning) return
    const startedAt = Math.min(
      ...Object.values(runs)
        .filter((run): run is Extract<RunState, { kind: "running" }> => run.kind === "running")
        .map((run) => run.startedAt),
    )
    setElapsed(Date.now() - startedAt)
    const timer = setInterval(() => setElapsed(Date.now() - startedAt), 1000)
    return () => clearInterval(timer)
  }, [anyRunning, runs])

  const setRun = (kind: RunKind, state: RunState) =>
    setRuns((prev) => ({ ...prev, [kind]: state }))

  const startRun = async (kind: RunKind) => {
    if (runningRef.current.has(kind)) return
    runningRef.current.add(kind)
    setRun(kind, { kind: "running", phase: "exporting", startedAt: Date.now() })
    const onPhase = (phase: ExtractionPhase) =>
      setRuns((prev) => {
        const current = prev[kind]
        return current.kind === "running" ? { ...prev, [kind]: { ...current, phase } } : prev
      })

    let state: RunState
    if (kind === "extraction") {
      const result = await runExtraction({ baseUrl, onPhase })
      state = result.ok
        ? { kind: "done", note: `Extraction complete — ${result.insightCount} insight${result.insightCount === 1 ? "" : "s"} recorded.` }
        : { kind: "error", error: result.error }
    } else if (kind === "synthesis") {
      const result = await runSynthesis({ baseUrl, onPhase })
      state = result.ok
        ? { kind: "done", note: `Synthesis complete — ${result.ideaCount} idea${result.ideaCount === 1 ? "" : "s"} proposed${result.dropped ? `, ${result.dropped} entry ignored` : ""}.` }
        : { kind: "error", error: result.error }
    } else {
      const result = await runTriage(repoId ?? "", { baseUrl, onPhase })
      state = result.ok
        ? { kind: "done", note: `Triage complete — ${result.ideaCount} idea${result.ideaCount === 1 ? "" : "s"} proposed${result.dropped ? `, ${result.dropped} entry ignored` : ""}.` }
        : { kind: "error", error: result.error }
    }
    runningRef.current.delete(kind)
    setRun(kind, state)
    await refresh()
  }

  const connectLinear = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const key = apiKey.trim()
    if (!key || connecting) return
    setConnecting("linear")
    setConnectError(null)
    const result = await zooConnectLinear(key)
    setConnecting(null)
    if (!result.ok) {
      setConnectError(result.error)
      return
    }
    setApiKey("")
    await refresh()
  }

  const connectTranscripts = async (path?: string) => {
    const target = (path ?? folder).trim()
    if (!target || connecting) return
    setConnecting("transcripts")
    setConnectError(null)
    const result = await zooConnectTranscripts(target)
    setConnecting(null)
    if (!result.ok) {
      setConnectError(result.error)
      return
    }
    setFolder("")
    await refresh()
  }

  const browseFolder = async () => {
    const picked = await pickFolder()
    if (!picked) return
    setFolder(picked)
    await connectTranscripts(picked)
  }

  const startBackfill = async (sourceId: string) => {
    const result = await zooStartBackfill(sourceId)
    if (!result.ok) setStatusError(result.error)
    await refresh()
  }

  const openArtifact = async (id: string) => {
    setArtifactLoading(true)
    setArtifactError(null)
    setArtifact(null)
    const result = await zooGetArtifact(id)
    setArtifactLoading(false)
    if (result.ok) setArtifact(result.artifact)
    else setArtifactError(result.error)
  }

  /** Every queue mutation shares the same busy/error/refresh handling. */
  const act = async (id: string, run: () => Promise<{ ok: boolean; error?: string }>) => {
    if (busyId) return
    setBusyId(id)
    setActionError(null)
    const result = await run()
    setBusyId(null)
    if (!result.ok && result.error) setActionError(result.error)
    await refresh()
  }

  const promote = (idea: ZooIdea) =>
    act(idea.id, async () => {
      const result = await promoteIdea(idea, repoId ?? null, { baseUrl })
      return result.ok ? { ok: true } : { ok: false, error: result.error }
    })

  const dismiss = (idea: ZooIdea) =>
    act(idea.id, async () => {
      const result = await zooSetIdeaStatus(idea.id, "dismissed")
      return result.ok ? { ok: true } : { ok: false, error: result.error }
    })

  const approve = (item: ZooItem) =>
    act(item.id, async () => {
      const result = await advanceItem(item)
      return result.ok ? { ok: true } : { ok: false, error: result.error }
    })

  const drop = (item: ZooItem) =>
    act(item.id, async () => {
      const result = await dropItem(item)
      return result.ok ? { ok: true } : { ok: false, error: result.error }
    })

  const submitFeedback = (item: ZooItem) =>
    act(item.id, async () => {
      const result = await sendItemFeedback(item, feedbackText, { baseUrl })
      if (result.ok) {
        setFeedbackFor(null)
        setFeedbackText("")
        return { ok: true }
      }
      return { ok: false, error: result.error }
    })

  const toggle = (id: string) => setExpanded((prev) => ({ ...prev, [id]: prev[id] !== true }))

  const insightById = useMemo(() => {
    const map = new Map<string, ZooInsight>()
    for (const insight of insights) map.set(insight.id, insight)
    return map
  }, [insights])

  const sources = status?.sources ?? []
  const artifactCount = status?.artifactCount ?? 0
  const proposed = useMemo(() => ideas.filter((idea) => idea.status === "proposed"), [ideas])
  const waiting = useMemo(
    () => items.filter((item) => item.stage === "decision" || item.stage === "review"),
    [items],
  )
  const inFlight = useMemo(
    () => items.filter((item) => item.stage === "research" || item.stage === "building"),
    [items],
  )
  const needsYou = proposed.length + waiting.length

  const detailOpen = !!artifact || artifactLoading || !!artifactError
  const closeDetail = () => {
    setArtifact(null)
    setArtifactError(null)
  }

  const evidenceList = (insight: ZooInsight) =>
    insight.evidence.length ? (
      <ul className="flex flex-col gap-1">
        {insight.evidence.map((cite, index) => (
          <li key={`${cite.artifactId}-${index}`}>
            <button
              type="button"
              onClick={() => void openArtifact(cite.artifactId)}
              className="flex w-full cursor-pointer items-start gap-1.5 rounded-lg px-1.5 py-1 text-left text-[11.5px] leading-relaxed text-muted-foreground hover:bg-accent/60 hover:text-foreground"
              title="Open artifact"
            >
              <Quote className="mt-0.5 size-3 shrink-0" />
              <span className="min-w-0 break-words">{cite.quote}</span>
            </button>
          </li>
        ))}
      </ul>
    ) : null

  const header = (
    <div className="no-drag flex h-[52px] shrink-0 items-center gap-2 border-border/70 border-b px-3">
      {detailOpen ? (
        <Button variant="ghost" size="icon-sm" aria-label="Back to factory" onClick={closeDetail}>
          <ArrowLeft />
        </Button>
      ) : (
        <Factory className="size-4 shrink-0 text-primary" />
      )}
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium text-[13px] text-foreground">
          {artifact ? artifact.title : "Factory"}
        </p>
        {!detailOpen && available && status && (
          <p className="truncate text-[11px] text-muted-foreground">
            {artifactCount} artifact{artifactCount === 1 ? "" : "s"} · {status.insightCount} insight
            {status.insightCount === 1 ? "" : "s"} · {status.ideaCount} idea
            {status.ideaCount === 1 ? "" : "s"} · {status.itemCount} item
            {status.itemCount === 1 ? "" : "s"}
          </p>
        )}
      </div>
      {!detailOpen && available && (
        <Button variant="ghost" size="icon-sm" aria-label="Refresh factory" onClick={() => void refresh()}>
          <RefreshCw />
        </Button>
      )}
      <Button variant="ghost" size="icon-sm" aria-label="Close factory" onClick={onClose}>
        <X />
      </Button>
    </div>
  )

  if (!available) {
    return (
      <aside className="flex min-h-0 min-w-[18rem] basis-[38%] flex-col border-border/70 border-l bg-background/70" aria-label="Factory pane">
        {header}
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-7 text-center">
          <div className="flex size-10 items-center justify-center rounded-xl border border-primary/20 bg-primary/10 text-primary">
            <Factory className="size-5" />
          </div>
          <div>
            <p className="font-medium text-[13px] text-foreground">{ZOO_UNAVAILABLE}</p>
            <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">
              Connected sources and their evidence live in the desktop app's local store. The web
              development build has no access to it.
            </p>
          </div>
        </div>
      </aside>
    )
  }

  if (detailOpen) {
    return (
      <aside className="flex min-h-0 min-w-[18rem] basis-[38%] flex-col border-border/70 border-l bg-background/70" aria-label="Factory pane">
        {header}
        <div className="flex min-h-0 flex-1 flex-col">
          {artifactLoading && (
            <p className="flex items-center gap-2 px-3 py-3 text-[12px] text-muted-foreground">
              <LoaderCircle className="size-3.5 animate-spin" />
              Loading artifact…
            </p>
          )}
          {artifactError && <div className="p-3">{<Notice text={artifactError} />}</div>}
          {artifact && (
            <>
              <div className="flex shrink-0 flex-wrap items-center gap-2 border-border/70 border-b px-3 py-2 text-[11px] text-muted-foreground">
                <span className="font-mono">{artifact.externalId}</span>
                <span>{artifact.kind}</span>
                <span>{relativeTime(artifact.fetchedAt)}</span>
                {artifact.url && (
                  <Button size="sm" variant="outline" className="ml-auto" onClick={() => openExternal(String(artifact.url))}>
                    <ExternalLink />
                    Open in Linear
                  </Button>
                )}
              </div>
              <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-[11.5px] leading-relaxed text-foreground">
                {artifact.content}
              </pre>
            </>
          )}
        </div>
      </aside>
    )
  }

  const tabs = (
    <div className="flex shrink-0 items-center gap-1 border-border/70 border-b px-2 py-1.5">
      {([
        ["queue", `Queue${needsYou ? ` · ${needsYou}` : ""}`],
        ["signals", "Signals"],
      ] as const).map(([id, label]) => (
        <button
          key={id}
          type="button"
          onClick={() => setTab(id)}
          className={cn(
            "cursor-pointer rounded-full px-2.5 py-1 text-[11.5px]",
            tab === id ? "bg-primary/10 font-medium text-primary" : "text-muted-foreground hover:bg-accent/60",
          )}
        >
          {label}
        </button>
      ))}
    </div>
  )

  const ideaCard = (idea: ZooIdea) => {
    const open = expanded[idea.id] === true
    const cited = idea.insightIds
      .map((id) => insightById.get(id))
      .filter((insight): insight is ZooInsight => !!insight)
    return (
      <li key={idea.id} className="rounded-xl border border-border/70 bg-muted/20">
        <button
          type="button"
          className="flex w-full cursor-pointer items-start gap-2 p-2.5 text-left"
          onClick={() => toggle(idea.id)}
          aria-expanded={open}
        >
          {open ? (
            <ChevronDown className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
          )}
          <span className="min-w-0 flex-1">
            <span className="flex items-start gap-2">
              <span className="min-w-0 flex-1 font-medium text-[12.5px] text-foreground">{idea.title}</span>
              <Badge className={IDEA_TYPE_TONE[idea.type]}>{IDEA_TYPE_LABEL[idea.type]}</Badge>
            </span>
            <span className="mt-1 block text-[11.5px] leading-relaxed text-muted-foreground">{idea.rationale}</span>
            {!open && idea.insightIds.length > 0 && (
              <span className="mt-1 block text-[11px] text-muted-foreground/70">
                {idea.insightIds.length} cited insight{idea.insightIds.length === 1 ? "" : "s"}
              </span>
            )}
          </span>
        </button>
        {open && (
          <div className="flex flex-col gap-1.5 border-border/70 border-t px-2.5 py-2">
            {cited.length === 0 ? (
              <p className="text-[11px] text-muted-foreground">No cited insights.</p>
            ) : (
              cited.map((insight) => (
                <div key={insight.id} className="flex flex-col gap-1">
                  <p className="font-medium text-[11.5px] text-foreground">{insight.title}</p>
                  <p className="text-[11.5px] leading-relaxed text-muted-foreground">{insight.summary}</p>
                  {evidenceList(insight)}
                </div>
              ))
            )}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-1.5 border-border/70 border-t px-2.5 py-2">
          <Button
            size="sm"
            disabled={busyId !== null || !repoId}
            title={repoId ? undefined : "Select a repository first"}
            onClick={() => void promote(idea)}
          >
            {busyId === idea.id ? <LoaderCircle className="animate-spin" /> : <ArrowRight />}
            Promote
          </Button>
          <Button size="sm" variant="outline" disabled={busyId !== null} onClick={() => void dismiss(idea)}>
            Dismiss
          </Button>
          {!repoId && <span className="text-[11px] text-muted-foreground">Needs a selected repository</span>}
        </div>
      </li>
    )
  }

  const itemCard = (item: ZooItem, mode: "decision" | "flight") => {
    const sessionId = latestSessionId(item)
    const advanceTo = nextStage(item.stage)
    return (
      <li key={item.id} className="flex flex-col gap-1.5 rounded-xl border border-border/70 bg-muted/20 p-2.5">
        <div className="flex items-start gap-2">
          <span className="min-w-0 flex-1 font-medium text-[12.5px] text-foreground">{item.title}</span>
          <Badge className="border-primary/30 bg-primary/10 text-primary">{STAGE_LABEL[item.stage]}</Badge>
        </div>
        <p className="text-[11px] text-muted-foreground">
          Updated {relativeTime(item.updatedAt)} · {item.sessionIds.length} session
          {item.sessionIds.length === 1 ? "" : "s"}
        </p>
        {item.decisions.length > 0 && (
          <p className="truncate text-[11px] text-muted-foreground/70">
            {item.decisions[item.decisions.length - 1]!.note}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-1.5">
          {mode === "decision" && advanceTo && (
            <Button size="sm" disabled={busyId !== null} onClick={() => void approve(item)}>
              {busyId === item.id ? <LoaderCircle className="animate-spin" /> : null}
              Approve
            </Button>
          )}
          {mode === "decision" && (
            <Button
              size="sm"
              variant="outline"
              disabled={busyId !== null || !sessionId}
              title={sessionId ? undefined : "This item has no session yet"}
              onClick={() => {
                setFeedbackFor(feedbackFor === item.id ? null : item.id)
                setFeedbackText("")
              }}
            >
              <MessageSquare />
              Change
            </Button>
          )}
          {mode === "decision" && (
            <Button size="sm" variant="outline" disabled={busyId !== null} onClick={() => void drop(item)}>
              <Trash2 />
              Drop
            </Button>
          )}
          {sessionId && onOpenSession && (
            <Button size="sm" variant="ghost" onClick={() => onOpenSession(sessionId)}>
              Open session
            </Button>
          )}
        </div>
        {feedbackFor === item.id && (
          <div className="flex flex-col gap-1.5">
            <textarea
              value={feedbackText}
              onChange={(event) => setFeedbackText(event.target.value)}
              placeholder="What should change?"
              className="min-h-16 w-full rounded-lg border border-input bg-transparent p-2 text-[12px] outline-none focus:border-ring focus:ring-[3px] focus:ring-ring/25"
            />
            <div className="flex gap-1.5">
              <Button size="sm" disabled={busyId !== null || !feedbackText.trim()} onClick={() => void submitFeedback(item)}>
                Send
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setFeedbackFor(null)}>
                Cancel
              </Button>
            </div>
          </div>
        )}
      </li>
    )
  }

  const queueView = (
    <>
      <Section title="Needs you" count={needsYou}>
        {needsYou === 0 ? (
          <p className="text-[12px] text-muted-foreground">Nothing waiting on you.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {waiting.map((item) => itemCard(item, "decision"))}
            {proposed.map((idea) => ideaCard(idea))}
          </ul>
        )}
      </Section>

      <Section title="In flight" count={inFlight.length}>
        {inFlight.length === 0 ? (
          <p className="text-[12px] text-muted-foreground">No work in flight.</p>
        ) : (
          <ul className="flex flex-col gap-2">{inFlight.map((item) => itemCard(item, "flight"))}</ul>
        )}
      </Section>

      <Section title="Later">
        <div className="flex flex-col gap-2 rounded-xl border border-border/70 bg-muted/20 p-2.5">
          {sources.length > 0 && (
            <ul className="flex flex-col gap-2">
              {sources.map((source) => (
                <li key={source.id} className="flex flex-col gap-1">
                  <div className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-[12px] text-foreground" title={source.label}>
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
                  <p className="text-[11px] text-muted-foreground">{backfillLabel(source)}</p>
                  {source.backfill.error && <Notice text={source.backfill.error} />}
                </li>
              ))}
            </ul>
          )}

          <form onSubmit={connectLinear} className="flex flex-col gap-1.5">
            <p className="font-medium text-[12px] text-foreground">Connect Linear</p>
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

          <div className="flex flex-col gap-1.5">
            <p className="font-medium text-[12px] text-foreground">Connect transcripts folder</p>
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
          {connectError && <Notice text={connectError} />}
        </div>

        <div className="flex flex-col gap-2 rounded-xl border border-border/70 bg-muted/20 p-2.5">
          <div className="flex flex-wrap gap-1.5">
            <Button
              size="sm"
              variant="outline"
              disabled={runs.extraction.kind === "running" || artifactCount === 0 || !baseUrl}
              onClick={() => void startRun("extraction")}
            >
              {runs.extraction.kind === "running" ? <LoaderCircle className="animate-spin" /> : <Sparkles />}
              Run extraction
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={runs.synthesis.kind === "running" || insights.length === 0 || !baseUrl}
              onClick={() => void startRun("synthesis")}
            >
              {runs.synthesis.kind === "running" ? <LoaderCircle className="animate-spin" /> : <Sparkles />}
              Synthesize ideas
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={runs.triage.kind === "running" || artifactCount === 0 || !baseUrl || !repoId}
              title={repoId ? undefined : "Select a repository first"}
              onClick={() => void startRun("triage")}
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
          {artifactCount > 0 && !baseUrl && (
            <Notice text="Runs need a connected Chunky server." tone="muted" />
          )}
        </div>
      </Section>
    </>
  )

  const signalsView = (
    <Section title="Signals" count={insights.length}>
      {insights.length === 0 ? (
        <p className="text-[12px] text-muted-foreground">No insights yet. Run extraction from the queue.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {insights.map((insight) => {
            const open = expanded[insight.id] === true
            return (
              <li key={insight.id} className="rounded-xl border border-border/70 bg-muted/20">
                <button
                  type="button"
                  className="flex w-full cursor-pointer items-start gap-2 p-2.5 text-left"
                  onClick={() => toggle(insight.id)}
                  aria-expanded={open}
                >
                  {open ? (
                    <ChevronDown className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                  ) : (
                    <ChevronRight className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="flex items-start gap-2">
                      <span className="min-w-0 flex-1 font-medium text-[12.5px] text-foreground">{insight.title}</span>
                      {insight.priority !== undefined && (
                        <Badge className={priorityTone(insight.priority)}>P{insight.priority}</Badge>
                      )}
                    </span>
                    <span className="mt-1 block text-[11.5px] leading-relaxed text-muted-foreground">{insight.summary}</span>
                    {!open && insight.evidence.length > 0 && (
                      <span className="mt-1 block text-[11px] text-muted-foreground/70">
                        {insight.evidence.length} evidence quote{insight.evidence.length === 1 ? "" : "s"}
                      </span>
                    )}
                  </span>
                </button>
                {open && insight.evidence.length > 0 && (
                  <div className="border-border/70 border-t px-2.5 py-2">{evidenceList(insight)}</div>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </Section>
  )

  return (
    <aside className="flex min-h-0 min-w-[18rem] basis-[38%] flex-col border-border/70 border-l bg-background/70" aria-label="Factory pane">
      {header}
      {tabs}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-y-auto p-3">
        {statusError && <Notice text={statusError} />}
        {actionError && <Notice text={actionError} />}
        {tab === "queue" ? queueView : signalsView}
      </div>
    </aside>
  )
}
