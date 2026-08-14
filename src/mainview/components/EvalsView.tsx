// Evals — the full-page review surface for auto-recorded sidekick delegations.
//
// The server keeps every delegation the recorder saw (brief, transcript,
// report, rating) under state/evals/candidates. This page is where you read
// them and decide: promote the interesting ones into the eval suite, prune the
// rest. It is a master/detail: a newest-first list on the left, one candidate
// on the right (stacked on narrow widths, where selecting swaps the panes).
//
// All server access goes through lib/evals.ts — nothing here fetches. The
// transcript is deliberately lazy: it is the big payload, so it is only asked
// for when a detail view opens, and its rows render collapsed until clicked.
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  FlaskConical,
  Loader2,
  Play,
  RefreshCw,
  Trash2,
  Upload,
} from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { cn } from "~/lib/cn"
import { listAllModels, splitModelKey } from "~/lib/configApi"
import type { ModelRow } from "~/lib/configApi"
import { confirm } from "~/lib/confirm"
import {
  briefSections,
  deleteEvalCandidate,
  errorMessage,
  getEvalCandidate,
  getEvalTranscript,
  getEvals,
  hasRunningReplay,
  isConflict,
  isUnsupported,
  listEvalCandidates,
  listEvalReplays,
  modelKey,
  modelLine,
  parseTranscript,
  promoteEvalCandidate,
  promotedBadgeLabel,
  ratingTone,
  replayStatusLabel,
  replayStatusTone,
  replayTimingLabel,
  startEvalReplay,
  statsLine,
  subScoreLine,
  taskLine,
  whenLabel,
  type EvalCandidateDetailResponse,
  type EvalCandidateSummary,
  type EvalPromoteBucket,
  type EvalReplayRequest,
  type EvalReplaySummary,
  type EvalsResponse,
  type PromoteBucketChoice,
  type TranscriptEntry,
} from "~/lib/evals"
import { relativeTime } from "~/lib/format"
import {
  EffortSelect,
  InlineError,
  ModelSelect,
  Spinner,
  useAsync,
} from "./settings/common"
import { Button } from "./ui/button"
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu"

const BUCKET_OPTIONS: { value: PromoteBucketChoice; label: string; hint: string }[] = [
  { value: "hard", label: "Hard", hint: "A brief that models get wrong" },
  { value: "regression", label: "Regression", hint: "Guard against a bug coming back" },
  { value: "random", label: "Random", hint: "An ordinary sample" },
  { value: "none", label: "No bucket", hint: "Promote without labelling it" },
]

/** How many transcript rows render before the "show more" step. */
const TRANSCRIPT_PAGE = 60

/** How often the replays list refetches WHILE a run is in flight. */
const REPLAY_POLL_MS = 4000

export function EvalsView({
  baseUrl,
  onOpenSession,
}: {
  /** Server base URL; null in demo/offline shells. */
  baseUrl: string | null
  /** Jump to the session a candidate came from, when the shell can. */
  onOpenSession?: (sessionId: string) => void
}) {
  const [candidates, setCandidates] = useState<EvalCandidateSummary[]>([])
  const [settings, setSettings] = useState<EvalsResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadedOnce, setLoadedOnce] = useState(false)
  const [unsupported, setUnsupported] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)
  const requestRef = useRef(0)

  const refresh = useCallback(() => setNonce((n) => n + 1), [])

  useEffect(() => {
    if (!baseUrl) {
      setCandidates([])
      setSettings(null)
      setLoadedOnce(true)
      return
    }
    const id = ++requestRef.current
    setLoading(true)
    void (async () => {
      let rows: EvalCandidateSummary[] = []
      let failed: string | null = null
      let missing = false
      try {
        rows = await listEvalCandidates()
      } catch (err) {
        if (isUnsupported(err)) missing = true
        else failed = errorMessage(err)
      }
      let info: EvalsResponse | null = null
      try {
        info = await getEvals()
      } catch {
        /* the mode line is a nicety; the list is the page */
      }
      if (requestRef.current !== id) return
      setCandidates(rows)
      setSettings(info)
      setUnsupported(missing)
      setError(failed)
      setLoading(false)
      setLoadedOnce(true)
    })()
  }, [baseUrl, nonce])

  // A candidate that disappeared (pruned elsewhere) must not strand the detail.
  useEffect(() => {
    if (selectedId && loadedOnce && !candidates.some((c) => c.delegationId === selectedId)) {
      setSelectedId(null)
    }
  }, [candidates, selectedId, loadedOnce])

  const selected = useMemo(
    () => candidates.find((c) => c.delegationId === selectedId) ?? null,
    [candidates, selectedId],
  )

  // The server owns the bucket (promotedBucket on the summary/detail), so the
  // row adopts whatever the promote call reported rather than remembering a
  // choice that would be lost on reload.
  const onPromoted = useCallback((id: string, bucket?: EvalPromoteBucket) => {
    setCandidates((rows) =>
      rows.map((row) =>
        row.delegationId === id
          ? { ...row, promoted: true, ...(bucket ? { promotedBucket: bucket } : {}) }
          : row,
      ),
    )
  }, [])

  const onDeleted = useCallback((id: string) => {
    setCandidates((rows) => rows.filter((row) => row.delegationId !== id))
    setSelectedId((current) => (current === id ? null : current))
  }, [])

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <header className="flex flex-wrap items-end justify-between gap-3 border-border/60 border-b px-6 pt-8 pb-4">
        <div className="min-w-0">
          <h1 className="font-semibold text-[20px] leading-tight tracking-[-0.02em]">Evals</h1>
          <p className="mt-1 min-w-0 break-words text-[12px] text-muted-foreground">
            {settings ? (
              <>
                <span className={settings.mode === "record" ? "text-success" : undefined}>
                  {settings.mode === "record" ? "Recording" : "Recording off"}
                </span>
                <span className="mx-1.5 opacity-40">·</span>
                <span className="tabular-nums">{statsLine(settings.stats)}</span>
              </>
            ) : (
              "Sidekick delegations recorded for review"
            )}
          </p>
        </div>
        <button
          type="button"
          onClick={refresh}
          disabled={!baseUrl || loading}
          aria-label="Refresh eval candidates"
          className="flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-lg border border-border bg-background/50 text-muted-foreground outline-none transition-colors hover:border-ring/40 hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-default disabled:opacity-50"
        >
          <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
        </button>
      </header>

      {!loadedOnce ? (
        <Panel>
          <Loader2 className="size-4 animate-spin text-muted-foreground" />
          <span>Loading eval candidates…</span>
        </Panel>
      ) : !baseUrl ? (
        <Panel>
          <FlaskConical className="size-4 opacity-60" />
          <span>Evals need a live Chunky server.</span>
        </Panel>
      ) : unsupported ? (
        <Panel>
          <FlaskConical className="size-4 opacity-60" />
          <span className="max-w-[46ch] text-balance">
            This server does not record evals yet. Update the Chunky server to review delegation
            candidates here.
          </span>
        </Panel>
      ) : candidates.length === 0 ? (
        <EmptyState recording={settings?.mode === "record"} error={error} />
      ) : (
        <div className="flex min-h-0 min-w-0 flex-1">
          <div
            className={cn(
              "min-h-0 min-w-0 flex-col overflow-y-auto border-border/60 lg:flex lg:w-[340px] lg:shrink-0 lg:border-r",
              selectedId ? "hidden" : "flex flex-1",
            )}
          >
            {error && (
              <p className="m-3 rounded-lg border border-destructive/35 bg-destructive/10 px-3 py-2 text-[12px] text-destructive">
                {error}
              </p>
            )}
            <ul className="flex min-w-0 flex-col p-2">
              {candidates.map((candidate) => (
                <li key={candidate.delegationId} className="min-w-0">
                  <CandidateRow
                    candidate={candidate}
                    active={candidate.delegationId === selectedId}
                    onSelect={() => setSelectedId(candidate.delegationId)}
                  />
                </li>
              ))}
            </ul>
          </div>

          <div
            className={cn(
              "min-h-0 min-w-0 flex-1 overflow-y-auto",
              selectedId ? "block" : "hidden lg:block",
            )}
          >
            {selected ? (
              <CandidateDetail
                key={selected.delegationId}
                summary={selected}
                onBack={() => setSelectedId(null)}
                onPromoted={onPromoted}
                onDeleted={onDeleted}
                onOpenSession={onOpenSession}
              />
            ) : (
              <Panel>
                <FlaskConical className="size-4 opacity-60" />
                <span>Pick a candidate to read its brief, rating, and transcript.</span>
              </Panel>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function Panel({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-6">
      <div className="flex max-w-[52ch] items-center gap-2.5 rounded-xl border border-border border-dashed bg-muted/20 px-4 py-3 text-[12.5px] text-muted-foreground">
        {children}
      </div>
    </div>
  )
}

function EmptyState({ recording, error }: { recording: boolean; error: string | null }) {
  return (
    <div className="flex min-h-0 flex-1 items-start justify-center overflow-y-auto p-6">
      <div className="mt-10 flex w-full max-w-[56ch] min-w-0 flex-col gap-3 rounded-2xl border border-border border-dashed bg-muted/20 p-6 text-center">
        <FlaskConical className="mx-auto size-5 text-muted-foreground" />
        <h2 className="font-semibold text-[15px]">No eval candidates yet</h2>
        <p className="text-balance text-[12.5px] text-muted-foreground">
          Auto-evals records each sidekick delegation — its brief, the worker's transcript, the
          final report and the rating it earned — so you can promote the interesting ones into an
          eval suite and prune the rest.
        </p>
        <p className="text-balance text-[12.5px] text-muted-foreground">
          {recording
            ? "Recording is on. Delegate some work and candidates will show up here."
            : "Recording is currently off. Turn on Auto-evals in Settings → Sidekick to start collecting candidates."}
        </p>
        {error && <p className="text-[12px] text-destructive">{error}</p>}
      </div>
    </div>
  )
}

function CandidateRow({
  candidate,
  active,
  onSelect,
}: {
  candidate: EvalCandidateSummary
  active: boolean
  onSelect: () => void
}) {
  const promotedLabel = promotedBadgeLabel(candidate.promoted, candidate.promotedBucket)
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={active}
      className={cn(
        "flex w-full min-w-0 cursor-pointer flex-col gap-1.5 rounded-xl border px-3 py-2.5 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/40",
        active
          ? "border-primary/40 bg-primary/10"
          : "border-transparent hover:border-border hover:bg-accent/50",
      )}
    >
      <span className="min-w-0 break-words font-medium text-[12.5px] leading-snug">
        {taskLine(candidate.task, 120)}
      </span>
      <span className="flex min-w-0 flex-wrap items-center gap-1.5">
        {candidate.ok === false && <Pill tone="destructive">failed</Pill>}
        {candidate.rating != null && (
          <Pill tone={ratingTone(candidate.rating)}>{candidate.rating}/10</Pill>
        )}
        {candidate.rework && <Pill tone="warning">rework</Pill>}
        {promotedLabel && <Pill tone="primary">{promotedLabel}</Pill>}
      </span>
      <span className="min-w-0 truncate text-[11px] text-muted-foreground">
        {[candidate.seat ?? "sidekick", candidate.model].filter(Boolean).join(" · ")}
        <span className="mx-1 opacity-40">·</span>
        {relativeTime(candidate.startedAt)}
      </span>
    </button>
  )
}

type PillTone = "success" | "warning" | "destructive" | "muted" | "primary"

function Pill({ tone = "muted", children }: { tone?: PillTone; children: React.ReactNode }) {
  const tones: Record<PillTone, string> = {
    success: "border-success/30 bg-success/10 text-success",
    warning: "border-warning/30 bg-warning/10 text-amber-700 dark:text-amber-300",
    destructive: "border-destructive/30 bg-destructive/10 text-destructive",
    muted: "border-border bg-muted/50 text-muted-foreground",
    primary: "border-primary/30 bg-primary/10 text-primary",
  }
  return (
    <span
      className={cn(
        "inline-flex max-w-full items-center gap-1 truncate rounded-full border px-1.5 py-0.5 font-medium text-[10px]",
        tones[tone],
      )}
    >
      {children}
    </span>
  )
}

function CandidateDetail({
  summary,
  onBack,
  onPromoted,
  onDeleted,
  onOpenSession,
}: {
  summary: EvalCandidateSummary
  onBack: () => void
  onPromoted: (id: string, bucket?: EvalPromoteBucket) => void
  onDeleted: (id: string) => void
  onOpenSession?: (sessionId: string) => void
}) {
  const id = summary.delegationId
  const [detail, setDetail] = useState<EvalCandidateDetailResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<"promote" | "delete" | "replay" | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [replayOpen, setReplayOpen] = useState(false)
  // Bumped when a replay starts, so the replays section refetches at once
  // instead of waiting out its poll interval.
  const [replayNonce, setReplayNonce] = useState(0)

  useEffect(() => {
    let live = true
    setLoading(true)
    setError(null)
    void getEvalCandidate(id)
      .then((data) => {
        if (live) setDetail(data)
      })
      .catch((err: unknown) => {
        if (live) setError(errorMessage(err))
      })
      .finally(() => {
        if (live) setLoading(false)
      })
    return () => {
      live = false
    }
  }, [id])

  const promoted = detail?.promoted ?? summary.promoted
  const promotedLabel = promotedBadgeLabel(
    promoted,
    detail?.promotedBucket ?? summary.promotedBucket,
  )

  const promote = (choice: PromoteBucketChoice) => {
    const wanted = choice === "none" ? undefined : choice
    void (async () => {
      setBusy("promote")
      setNotice(null)
      try {
        const next = await promoteEvalCandidate(id, wanted)
        setDetail(next)
        onPromoted(id, wanted)
        setNotice(wanted ? `Promoted into the ${wanted} bucket.` : "Promoted.")
      } catch (err) {
        if (isConflict(err)) {
          setNotice("Already promoted.")
          onPromoted(id)
          setDetail((d) => (d ? { ...d, promoted: true } : d))
        } else {
          setNotice(errorMessage(err))
        }
      } finally {
        setBusy(null)
      }
    })()
  }

  const remove = () => {
    void (async () => {
      const ok = await confirm({
        title: "Delete this candidate?",
        body: "Its brief, transcript, report and rating are removed from disk. This can't be undone.",
        confirmLabel: "Delete",
        destructive: true,
      })
      if (!ok) return
      setBusy("delete")
      setNotice(null)
      try {
        await deleteEvalCandidate(id)
        onDeleted(id)
      } catch (err) {
        setNotice(
          isConflict(err) ? "This candidate is promoted, so it can't be deleted." : errorMessage(err),
        )
        if (isConflict(err)) onPromoted(id)
      } finally {
        setBusy(null)
      }
    })()
  }

  const candidate = detail?.candidate
  const sections = briefSections(candidate?.briefStruct)

  const runReplay = (selection: EvalReplayRequest) => {
    void (async () => {
      setBusy("replay")
      setNotice(null)
      try {
        await startEvalReplay(id, selection)
        setReplayOpen(false)
        // Show the new run immediately; the section takes over the polling.
        setReplayNonce((n) => n + 1)
        setNotice("Replay started.")
      } catch (err) {
        if (isConflict(err)) {
          setNotice("A replay is already running for this candidate.")
          setReplayOpen(false)
          setReplayNonce((n) => n + 1)
        } else {
          setNotice(errorMessage(err))
        }
      } finally {
        setBusy(null)
      }
    })()
  }

  return (
    <div className="mx-auto flex w-full min-w-0 max-w-[880px] flex-col gap-4 px-5 pt-5 pb-16">
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-1 items-start gap-2">
          <button
            type="button"
            onClick={onBack}
            aria-label="Back to the candidate list"
            className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40 lg:hidden"
          >
            <ChevronLeft className="size-4" />
          </button>
          <div className="min-w-0">
            <h2 className="min-w-0 break-words font-semibold text-[15px] leading-snug">
              {taskLine(summary.task, 220)}
            </h2>
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              {detail?.report ? (
                <Pill tone={detail.report.ok ? "success" : "destructive"}>
                  {detail.report.ok ? "ok" : "failed"}
                </Pill>
              ) : summary.ok != null ? (
                <Pill tone={summary.ok ? "success" : "destructive"}>
                  {summary.ok ? "ok" : "failed"}
                </Pill>
              ) : (
                <Pill>no report</Pill>
              )}
              {promotedLabel && <Pill tone="primary">{promotedLabel}</Pill>}
            </div>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button size="sm" variant="outline" disabled={promoted || busy !== null}>
                  {busy === "promote" ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <Upload className="size-3.5" />
                  )}
                  Promote
                </Button>
              }
            />
            <DropdownMenuContent align="end">
              {BUCKET_OPTIONS.map((option) => (
                <DropdownMenuItem key={option.value} onClick={() => promote(option.value)}>
                  <span className="flex min-w-0 flex-col">
                    <span className="text-[13px]">{option.label}</span>
                    <span className="text-[11px] text-muted-foreground">{option.hint}</span>
                  </span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <Button
            size="sm"
            variant="outline"
            disabled={busy !== null}
            onClick={() => {
              setNotice(null)
              setReplayOpen(true)
            }}
            title="Re-run this brief against a model"
          >
            {busy === "replay" ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Play className="size-3.5" />
            )}
            Replay
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={promoted || busy !== null}
            onClick={remove}
            title={promoted ? "Promoted candidates can't be deleted" : "Delete this candidate"}
          >
            {busy === "delete" ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Trash2 className="size-3.5" />
            )}
            Delete
          </Button>
        </div>
      </div>

      {notice && (
        <p className="min-w-0 break-words rounded-lg border border-border bg-muted/40 px-3 py-2 text-[12px] text-muted-foreground">
          {notice}
        </p>
      )}
      {error && (
        <p className="min-w-0 break-words rounded-lg border border-destructive/35 bg-destructive/10 px-3 py-2 text-[12px] text-destructive">
          {error}
        </p>
      )}

      {loading && !detail ? (
        <div className="flex items-center gap-2 text-[12.5px] text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          Loading candidate…
        </div>
      ) : (
        <>
          <Section title="Brief">
            {sections.length > 0 ? (
              <div className="flex min-w-0 flex-col gap-3">
                {sections.map((section) => (
                  <div key={section.label} className="min-w-0">
                    <p className="pb-1 font-medium text-[10.5px] text-muted-foreground uppercase tracking-wide">
                      {section.label}
                    </p>
                    {section.values.length > 1 ? (
                      <ul className="flex min-w-0 list-disc flex-col gap-1 pl-4">
                        {section.values.map((value, i) => (
                          <li
                            key={i}
                            className="min-w-0 whitespace-pre-wrap break-words text-[12.5px]"
                          >
                            {value}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="min-w-0 whitespace-pre-wrap break-words text-[12.5px]">
                        {section.values[0]}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <pre className="min-w-0 whitespace-pre-wrap break-words font-mono text-[11.5px] text-muted-foreground">
                {candidate?.briefComposed?.trim() || "This candidate recorded no brief."}
              </pre>
            )}
          </Section>

          {detail?.rating && (
            <Section title="Rating">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <span className="font-semibold text-[22px] leading-none tabular-nums">
                  {detail.rating.rating}
                  <span className="text-[13px] text-muted-foreground">/10</span>
                </span>
                <span className="font-mono text-[11.5px] text-muted-foreground">
                  {subScoreLine(detail.rating)}
                </span>
                {detail.rating.rework && <Pill tone="warning">rework</Pill>}
              </div>
              {detail.rating.reason && (
                <p className="mt-2 min-w-0 whitespace-pre-wrap break-words text-[12.5px]">
                  {detail.rating.reason}
                </p>
              )}
              {detail.rating.diagnosis && (
                <p className="mt-2 min-w-0 whitespace-pre-wrap break-words rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-[12px] text-amber-800 dark:text-amber-200">
                  {detail.rating.diagnosis}
                </p>
              )}
              <p className="mt-2 text-[11px] text-muted-foreground">
                Judge · {modelLine({ provider: detail.rating.judgeProvider, model: detail.rating.judgeModel })}
              </p>
            </Section>
          )}

          <Section title="Metadata">
            <dl className="grid min-w-0 gap-x-6 gap-y-1.5 sm:grid-cols-2">
              <Meta label="Seat" value={candidate?.seat ?? summary.seat ?? "default sidekick"} />
              <Meta
                label="Model"
                value={modelLine({
                  provider: candidate?.provider ?? summary.provider,
                  model: candidate?.model ?? summary.model,
                  effort: candidate?.effort,
                })}
              />
              <Meta label="Started" value={whenLabel(candidate?.startedAt ?? summary.startedAt)} />
              <Meta
                label="Session"
                value={candidate?.sessionId ?? summary.sessionId}
                mono
                onClick={
                  onOpenSession
                    ? () => onOpenSession(candidate?.sessionId ?? summary.sessionId)
                    : undefined
                }
              />
              {candidate?.workspace && <Meta label="Workspace" value={candidate.workspace} mono />}
              <Meta label="Delegation" value={id} mono />
            </dl>
          </Section>

          {detail?.report?.finalReport && (
            <Section title="Final report">
              <p className="min-w-0 whitespace-pre-wrap break-words text-[12.5px]">
                {detail.report.finalReport}
              </p>
            </Section>
          )}

          <ReplaysSection id={id} nonce={replayNonce} />

          <TranscriptSection id={id} />
        </>
      )}

      <ReplayDialog
        open={replayOpen}
        onOpenChange={setReplayOpen}
        busy={busy === "replay"}
        defaultModelKey={modelKey(
          candidate?.provider ?? summary.provider,
          candidate?.model ?? summary.model,
        )}
        defaultEffort={candidate?.effort ?? ""}
        onRun={runReplay}
      />
    </div>
  )
}

/**
 * Pick what to replay the brief with. Defaults to the model the candidate was
 * recorded with — the common case is "run this again on something else and
 * compare", so the recorded selection is the baseline, not a blank slate.
 *
 * The catalog comes from the server through configApi.listAllModels(), the same
 * source every other model picker in the app uses.
 */
function ReplayDialog({
  open,
  onOpenChange,
  busy,
  defaultModelKey,
  defaultEffort,
  onRun,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  busy: boolean
  defaultModelKey: string
  defaultEffort: string
  onRun: (selection: EvalReplayRequest) => void
}) {
  const models = useAsync<ModelRow[]>(() => (open ? listAllModels() : Promise.resolve([])), [open])
  const [modelValue, setModelValue] = useState(defaultModelKey)
  const [effort, setEffort] = useState(defaultEffort)

  // Re-arm the defaults each time the dialog opens (a different candidate, or a
  // second look at this one, must not inherit the last edit).
  useEffect(() => {
    if (open) {
      setModelValue(defaultModelKey)
      setEffort(defaultEffort)
    }
  }, [open, defaultModelKey, defaultEffort])

  const parts = modelValue ? splitModelKey(modelValue) : null

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>Replay this brief</DialogTitle>
          <DialogDescription>
            Re-runs the recorded brief in a throwaway workspace. Nothing touches your repository.
          </DialogDescription>
        </DialogHeader>
        <div className="flex min-w-0 flex-col gap-3 px-6 py-2">
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
            <span className="text-[12.5px] text-muted-foreground">Model</span>
            {models.loading ? (
              <Spinner />
            ) : (
              <ModelSelect
                rows={models.data ?? []}
                value={modelValue}
                onChange={setModelValue}
                disabled={busy}
              />
            )}
          </div>
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
            <span className="min-w-0 text-[12.5px] text-muted-foreground">
              Effort
              <span className="ml-1.5 text-[11px] opacity-70">
                {defaultEffort ? `recorded: ${defaultEffort}` : "none recorded"}
              </span>
            </span>
            <EffortSelect value={effort} onChange={setEffort} allowInherit disabled={busy} />
          </div>
          {models.error && <InlineError>{models.error}</InlineError>}
        </div>
        <DialogFooter>
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={busy}
            onClick={() =>
              onRun({
                ...(parts?.provider ? { provider: parts.provider } : {}),
                ...(parts?.model ? { model: parts.model } : {}),
                ...(effort ? { effort } : {}),
              })
            }
          >
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}
            Run replay
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  )
}

/**
 * Replay runs for this candidate.
 *
 * Polling is self-scheduling rather than an interval: each response decides
 * whether there is anything left to wait for, so the moment no run is running
 * the requests stop. Unmounting (or switching candidate) cancels the pending
 * timer and ignores an in-flight answer.
 *
 * The list is all this renders — the server does not expose a replay's diff or
 * final report, so nothing here pretends to.
 */
function ReplaysSection({ id, nonce }: { id: string; nonce: number }) {
  const [replays, setReplays] = useState<EvalReplaySummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [unsupported, setUnsupported] = useState(false)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    let live = true
    let timer: number | undefined
    const tick = async () => {
      try {
        const rows = await listEvalReplays(id)
        if (!live) return
        setReplays(rows)
        setError(null)
        setNow(Date.now())
        // The only thing that keeps the poll alive.
        if (hasRunningReplay(rows)) timer = window.setTimeout(() => void tick(), REPLAY_POLL_MS)
      } catch (err) {
        if (!live) return
        if (isUnsupported(err)) setUnsupported(true)
        else setError(errorMessage(err))
      }
    }
    void tick()
    return () => {
      live = false
      if (timer != null) window.clearTimeout(timer)
    }
  }, [id, nonce])

  if (unsupported) return null

  const rows = replays ?? []

  return (
    <Section title="Replays">
      {error && <p className="min-w-0 break-words text-[12px] text-destructive">{error}</p>}
      {replays === null && !error ? (
        <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" />
          Loading replays…
        </div>
      ) : rows.length === 0 ? (
        <p className="text-[12px] text-muted-foreground">
          No replays yet. Use Replay to re-run this brief against a model.
        </p>
      ) : (
        <ul className="flex min-w-0 flex-col gap-1.5">
          {rows.map((replay) => (
            <li
              key={replay.replayId}
              className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-border/60 bg-background/40 px-2.5 py-2"
            >
              <span className="flex shrink-0 items-center gap-1.5">
                {replay.status === "running" && (
                  <Loader2 className="size-3 animate-spin text-muted-foreground" />
                )}
                <Pill tone={replayStatusTone(replay)}>{replayStatusLabel(replay)}</Pill>
              </span>
              <span className="min-w-0 flex-1 break-words font-mono text-[11.5px]">
                {modelLine({
                  provider: replay.provider,
                  model: replay.model,
                  effort: replay.effort,
                })}
              </span>
              <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
                {relativeTime(replay.startedAt, now)}
                <span className="mx-1 opacity-40">·</span>
                {replayTimingLabel(replay, now)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Section>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="min-w-0 rounded-xl border border-border bg-card/40 p-3.5">
      <p className="pb-2 font-medium text-[10.5px] text-muted-foreground uppercase tracking-wide">
        {title}
      </p>
      <div className="min-w-0">{children}</div>
    </section>
  )
}

function Meta({
  label,
  value,
  mono,
  onClick,
}: {
  label: string
  value: string
  mono?: boolean
  onClick?: () => void
}) {
  return (
    <div className="flex min-w-0 flex-col">
      <dt className="text-[10.5px] text-muted-foreground uppercase tracking-wide">{label}</dt>
      <dd
        className={cn(
          "min-w-0 break-words text-[12px]",
          mono && "font-mono text-[11.5px]",
          onClick && "cursor-pointer text-primary hover:underline",
        )}
        onClick={onClick}
      >
        {value || "—"}
      </dd>
    </div>
  )
}

/** The worker transcript. Fetched only when this section mounts (i.e. when a
 *  detail view opens), then rendered as collapsed monospace rows a page at a
 *  time — a long run can be thousands of events. */
function TranscriptSection({ id }: { id: string }) {
  const [entries, setEntries] = useState<TranscriptEntry[] | null>(null)
  const [raw, setRaw] = useState<string | null>(null)
  const [state, setState] = useState<"loading" | "ready" | "missing" | "error">("loading")
  const [error, setError] = useState<string | null>(null)
  const [shown, setShown] = useState(TRANSCRIPT_PAGE)

  useEffect(() => {
    let live = true
    setState("loading")
    setShown(TRANSCRIPT_PAGE)
    void getEvalTranscript(id)
      .then((text) => {
        if (!live) return
        setRaw(text)
        const parsed = parseTranscript(text)
        setEntries(parsed)
        setState("ready")
      })
      .catch((err: unknown) => {
        if (!live) return
        if (isUnsupported(err)) {
          setState("missing")
        } else {
          setError(errorMessage(err))
          setState("error")
        }
      })
    return () => {
      live = false
    }
  }, [id])

  const rows = entries ?? []
  const visible = rows.slice(0, shown)

  return (
    <Section title="Worker transcript">
      {state === "loading" ? (
        <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" />
          Loading transcript…
        </div>
      ) : state === "missing" ? (
        <p className="text-[12px] text-muted-foreground">
          No transcript was recorded for this candidate.
        </p>
      ) : state === "error" ? (
        <p className="min-w-0 break-words text-[12px] text-destructive">{error}</p>
      ) : rows.length === 0 ? (
        // Nothing parsed but the body wasn't empty: show it verbatim rather
        // than pretending the transcript is gone.
        raw?.trim() ? (
          <pre className="max-h-[420px] min-w-0 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] text-muted-foreground">
            {raw}
          </pre>
        ) : (
          <p className="text-[12px] text-muted-foreground">The transcript is empty.</p>
        )
      ) : (
        <div className="flex min-w-0 flex-col gap-1">
          <p className="pb-1 text-[11px] text-muted-foreground tabular-nums">
            {rows.length.toLocaleString()} event{rows.length === 1 ? "" : "s"}
          </p>
          {visible.map((entry) => (
            <TranscriptRow key={entry.key} entry={entry} />
          ))}
          {shown < rows.length && (
            <div className="pt-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => setShown((n) => n + TRANSCRIPT_PAGE)}
              >
                Show {Math.min(TRANSCRIPT_PAGE, rows.length - shown)} more
              </Button>
            </div>
          )}
        </div>
      )}
    </Section>
  )
}

function TranscriptRow({ entry }: { entry: TranscriptEntry }) {
  const [open, setOpen] = useState(false)
  const expandable = entry.detail.trim().length > 0 && entry.detail !== entry.preview
  const tone =
    entry.kind === "user"
      ? "text-primary"
      : entry.kind === "tool"
        ? "text-foreground"
        : entry.kind === "tool-result"
          ? entry.ok === false
            ? "text-destructive"
            : "text-muted-foreground"
          : entry.kind === "raw"
            ? "text-amber-700 dark:text-amber-300"
            : "text-muted-foreground"

  return (
    <div className="min-w-0 rounded-lg border border-border/60 bg-background/40">
      <button
        type="button"
        onClick={() => expandable && setOpen((o) => !o)}
        aria-expanded={expandable ? open : undefined}
        className={cn(
          "flex w-full min-w-0 items-start gap-2 px-2.5 py-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
          expandable ? "cursor-pointer hover:bg-accent/40" : "cursor-default",
        )}
      >
        {expandable ? (
          open ? (
            <ChevronDown className="mt-0.5 size-3 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="mt-0.5 size-3 shrink-0 text-muted-foreground" />
          )
        ) : (
          <span className="mt-0.5 size-3 shrink-0" />
        )}
        <span className={cn("w-[68px] shrink-0 truncate font-mono text-[10.5px] sm:w-[104px]", tone)}>
          {entry.label}
        </span>
        <span className="min-w-0 flex-1 break-words font-mono text-[11px] text-muted-foreground">
          {entry.preview || "—"}
        </span>
      </button>
      {open && (
        <pre className="max-h-[360px] min-w-0 overflow-auto whitespace-pre-wrap break-words border-border/60 border-t px-2.5 py-2 font-mono text-[11px]">
          {entry.detail}
        </pre>
      )}
    </div>
  )
}
