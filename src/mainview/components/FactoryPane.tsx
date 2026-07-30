import {
  AlertCircle,
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Factory,
  LoaderCircle,
  Quote,
  RefreshCw,
  Sparkles,
  X,
} from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { FormEvent, ReactNode } from "react"
import { cn } from "~/lib/cn"
import { relativeTime } from "~/lib/format"
import { openExternal } from "~/lib/openExternal"
import {
  ZOO_UNAVAILABLE,
  zooAvailable,
  zooConnectLinear,
  zooGetArtifact,
  zooListInsights,
  zooStartBackfill,
  zooStatus,
  type ZooArtifactDetail,
  type ZooInsight,
  type ZooSource,
  type ZooStatus,
} from "~/lib/zoo"
import { runExtraction, type ExtractionPhase } from "~/lib/zooExtraction"
import { Button } from "./ui/button"
import { Input } from "./ui/input"

const POLL_MS = 2000

const PHASE_LABEL: Record<ExtractionPhase, string> = {
  exporting: "Bundling evidence",
  starting: "Starting a session",
  thinking: "Clustering signals",
  recording: "Recording insights",
}

type RunState =
  | { kind: "idle" }
  | { kind: "running"; phase: ExtractionPhase; startedAt: number }
  | { kind: "done"; insightCount: number }
  | { kind: "error"; error: string }

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

function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <header className="flex min-h-6 items-center justify-between gap-2">
        <h3 className="font-medium text-[11px] uppercase tracking-wide text-muted-foreground">{title}</h3>
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

/**
 * The product-factory surface: connect sources, watch their backfill, run an
 * extraction pass, and read the resulting insights with their evidence.
 *
 * Everything server- and store-side goes through lib/zoo.ts and
 * lib/zooExtraction.ts — this component never touches the RPC bridge itself.
 *
 * @param baseUrl Live Chunky server used for the extraction session, or null
 *   when there is none (offline/demo) — the run button then stays disabled.
 */
export function FactoryPane({ onClose, baseUrl }: { onClose: () => void; baseUrl?: string | null }) {
  const [available] = useState(zooAvailable)
  const [status, setStatus] = useState<ZooStatus | null>(null)
  const [statusError, setStatusError] = useState<string | null>(null)
  const [insights, setInsights] = useState<ZooInsight[]>([])

  const [apiKey, setApiKey] = useState("")
  const [connecting, setConnecting] = useState(false)
  const [connectError, setConnectError] = useState<string | null>(null)

  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [artifact, setArtifact] = useState<ZooArtifactDetail | null>(null)
  const [artifactLoading, setArtifactLoading] = useState(false)
  const [artifactError, setArtifactError] = useState<string | null>(null)

  const [run, setRun] = useState<RunState>({ kind: "idle" })
  const [elapsed, setElapsed] = useState(0)
  const runningRef = useRef(false)

  const refresh = useCallback(async () => {
    const [next, list] = await Promise.all([zooStatus(), zooListInsights()])
    if (next.ok) {
      setStatus({
        sources: next.sources,
        artifactCount: next.artifactCount,
        insightCount: next.insightCount,
        passes: next.passes,
      })
      setStatusError(null)
    } else if (!next.unavailable) {
      setStatusError(next.error)
    }
    if (list.ok) setInsights(list.insights)
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

  useEffect(() => {
    if (run.kind !== "running") return
    setElapsed(Date.now() - run.startedAt)
    const timer = setInterval(() => setElapsed(Date.now() - run.startedAt), 1000)
    return () => clearInterval(timer)
  }, [run])

  const connect = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const key = apiKey.trim()
    if (!key || connecting) return
    setConnecting(true)
    setConnectError(null)
    const result = await zooConnectLinear(key)
    setConnecting(false)
    if (!result.ok) {
      setConnectError(result.error)
      return
    }
    setApiKey("")
    await refresh()
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

  const startRun = async () => {
    if (runningRef.current) return
    runningRef.current = true
    setRun({ kind: "running", phase: "exporting", startedAt: Date.now() })
    const result = await runExtraction({
      baseUrl,
      onPhase: (phase) =>
        setRun((prev) => (prev.kind === "running" ? { ...prev, phase } : prev)),
    })
    runningRef.current = false
    setRun(
      result.ok
        ? { kind: "done", insightCount: result.insightCount }
        : { kind: "error", error: result.error },
    )
    await refresh()
  }

  const sources = status?.sources ?? []
  const artifactCount = status?.artifactCount ?? 0
  const passOrder = useMemo(() => {
    const order = new Map<string, number>()
    status?.passes.forEach((pass, index) => order.set(pass.id, index))
    return order
  }, [status])
  // Passes arrive newest-first from the store; keep insights in that order.
  const orderedInsights = useMemo(
    () =>
      insights.slice().sort((a, b) => {
        const rank = (passOrder.get(a.passId) ?? Number.MAX_SAFE_INTEGER) - (passOrder.get(b.passId) ?? Number.MAX_SAFE_INTEGER)
        return rank !== 0 ? rank : b.createdAt - a.createdAt
      }),
    [insights, passOrder],
  )
  const runDisabled = run.kind === "running" || artifactCount === 0 || !baseUrl

  const header = (
    <div className="no-drag flex h-[52px] shrink-0 items-center gap-2 border-border/70 border-b px-3">
      {artifact || artifactLoading || artifactError ? (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Back to factory"
          onClick={() => {
            setArtifact(null)
            setArtifactError(null)
          }}
        >
          <ArrowLeft />
        </Button>
      ) : (
        <Factory className="size-4 shrink-0 text-primary" />
      )}
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium text-[13px] text-foreground">
          {artifact ? artifact.title : "Factory"}
        </p>
        {!artifact && available && status && (
          <p className="truncate text-[11px] text-muted-foreground">
            {artifactCount} artifact{artifactCount === 1 ? "" : "s"} · {status.insightCount} insight
            {status.insightCount === 1 ? "" : "s"}
          </p>
        )}
      </div>
      {!artifact && available && (
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

  const detailView = (
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
  )

  return (
    <aside className="flex min-h-0 min-w-[18rem] basis-[38%] flex-col border-border/70 border-l bg-background/70" aria-label="Factory pane">
      {header}
      {artifact || artifactLoading || artifactError ? (
        detailView
      ) : (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-y-auto p-3">
          {statusError && <Notice text={statusError} />}

          {sources.length === 0 ? (
            <form onSubmit={connect} className="flex flex-col gap-2 rounded-xl border border-border/70 bg-muted/20 p-3">
              <p className="font-medium text-[13px] text-foreground">Connect Linear</p>
              <p className="text-[12px] leading-relaxed text-muted-foreground">
                Paste a personal API key. Issues are pulled into the local store as evidence — nothing
                is written back to Linear.
              </p>
              <Input
                type="password"
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                placeholder="lin_api_…"
                autoComplete="off"
                spellCheck={false}
                aria-label="Linear API key"
              />
              {connectError && <Notice text={connectError} />}
              <Button type="submit" disabled={connecting || !apiKey.trim()} className="self-start">
                {connecting && <LoaderCircle className="animate-spin" />}
                {connecting ? "Connecting…" : "Connect"}
              </Button>
            </form>
          ) : null}

          {sources.length > 0 && (
            <Section title="Sources">
              <ul className="flex flex-col gap-2">
                {sources.map((source) => (
                  <li key={source.id} className="flex flex-col gap-1.5 rounded-xl border border-border/70 bg-muted/20 p-2.5">
                    <div className="flex items-center gap-2">
                      <span className="min-w-0 flex-1 truncate font-medium text-[12.5px] text-foreground">{source.label}</span>
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
                          ? "Re-run backfill"
                          : "Start backfill"}
                      </Button>
                    </div>
                    <p className="text-[11px] text-muted-foreground">{backfillLabel(source)}</p>
                    {source.backfill.error && <Notice text={source.backfill.error} />}
                  </li>
                ))}
              </ul>
              <div className="rounded-xl border border-dashed border-border/70 p-2.5">
                <p className="text-[12px] text-muted-foreground">What do you want to connect next?</p>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {["Transcripts folder", "PostHog"].map((label) => (
                    <span
                      key={label}
                      className="rounded-full border border-border/70 px-2 py-0.5 text-[11px] text-muted-foreground/70"
                      title="Coming soon"
                    >
                      {label} · coming soon
                    </span>
                  ))}
                </div>
              </div>
            </Section>
          )}

          <Section
            title="Insights"
            action={
              <Button size="sm" disabled={runDisabled} onClick={() => void startRun()}>
                {run.kind === "running" ? <LoaderCircle className="animate-spin" /> : <Sparkles />}
                {run.kind === "running" ? "Running…" : "Run extraction"}
              </Button>
            }
          >
            {run.kind === "running" && (
              <p className="flex items-center gap-2 text-[11.5px] text-muted-foreground">
                <LoaderCircle className="size-3.5 animate-spin text-primary" />
                {PHASE_LABEL[run.phase]} · {Math.floor(elapsed / 1000)}s
              </p>
            )}
            {run.kind === "done" && (
              <p className="text-[11.5px] text-muted-foreground">
                Extraction complete — {run.insightCount} insight{run.insightCount === 1 ? "" : "s"} recorded.
              </p>
            )}
            {run.kind === "error" && <Notice text={run.error} />}
            {run.kind !== "running" && artifactCount === 0 && (
              <Notice text="Backfill a source first — extraction needs artifacts to work from." tone="muted" />
            )}
            {run.kind !== "running" && artifactCount > 0 && !baseUrl && (
              <Notice text="Extraction needs a connected Chunky server." tone="muted" />
            )}

            {orderedInsights.length === 0 ? (
              <p className="text-[12px] text-muted-foreground">No insights yet.</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {orderedInsights.map((insight) => {
                  const open = expanded[insight.id] === true
                  return (
                    <li key={insight.id} className="rounded-xl border border-border/70 bg-muted/20">
                      <button
                        type="button"
                        className="flex w-full cursor-pointer items-start gap-2 p-2.5 text-left"
                        onClick={() => setExpanded((prev) => ({ ...prev, [insight.id]: !open }))}
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
                              <span className={cn("shrink-0 rounded-full border px-1.5 py-0.5 font-medium text-[10px]", priorityTone(insight.priority))}>
                                P{insight.priority}
                              </span>
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
                        <ul className="flex flex-col gap-1.5 border-border/70 border-t px-2.5 py-2">
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
                      )}
                    </li>
                  )
                })}
              </ul>
            )}
          </Section>
        </div>
      )}
    </aside>
  )
}
