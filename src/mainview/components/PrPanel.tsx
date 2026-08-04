import { Dialog as DialogPrimitive } from "@base-ui/react/dialog"
import { RefreshCw, X } from "lucide-react"
import { useCallback, useEffect, useState } from "react"
import type { PrReviewsConfig, PrReviewsState, PrSummary } from "@chunky/protocol"
import { cn } from "~/lib/cn"
import { NO_DRAG_REGION } from "~/lib/dragRegion"
import {
  getPrReviewsConfig,
  resolvePrComments,
  startPrReview,
  updatePrReviewsConfig,
} from "~/lib/prApi"
import {
  formatFetchedAt,
  sortMine,
  sortReviewQueue,
  toPrCard,
  type PrCard,
  type Tone,
} from "~/lib/prReviews"
import { Button } from "./ui/button"

const DEFAULT_READY_LABEL = "ready-to-review"

/** Tone → the same four status colours the sidebar's own dots use. */
const DOT: Record<Tone, string> = {
  ok: "bg-success",
  bad: "bg-destructive",
  warn: "bg-warning",
  info: "bg-info",
  muted: "bg-muted-foreground/40",
}

const BADGE: Record<Tone, string> = {
  ok: "border-success/30 bg-success/10 text-success",
  bad: "border-destructive/30 bg-destructive/10 text-destructive",
  warn: "border-warning/30 bg-warning/10 text-warning",
  info: "border-info/30 bg-info/10 text-info",
  muted: "border-border bg-muted/50 text-muted-foreground",
}

function Dot({ tone }: { tone: Tone }) {
  return <span className={cn("size-1.5 shrink-0 rounded-full", DOT[tone])} />
}

function Badge({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border px-1.5 py-0.5 font-medium text-[10.5px]",
        BADGE[tone],
      )}
    >
      {children}
    </span>
  )
}

function SectionHeader({ label, count }: { label: string; count: number }) {
  return (
    <div className="flex items-center gap-2 px-0.5 pt-4 pb-2">
      <span className="font-medium text-[10.5px] text-muted-foreground/60 uppercase tracking-[0.08em]">
        {label}
      </span>
      <span className="h-px flex-1 bg-border/60" />
      <span className="text-[10.5px] text-muted-foreground/40 tabular-nums">{count}</span>
    </div>
  )
}

/** A run that is still going — the panel's only animated element. */
function SessionStrip({
  label,
  onOpen,
}: {
  label: string
  onOpen?: () => void
}) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-primary/25 bg-primary/10 px-2 py-1.5 text-[11px] text-primary">
      <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-primary" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {onOpen && (
        <button
          type="button"
          onClick={onOpen}
          className="shrink-0 cursor-pointer font-medium underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/40"
        >
          Open session
        </button>
      )}
    </div>
  )
}

function PrCardView({
  card,
  queue,
  busy,
  started,
  error,
  onAction,
  onOpenSession,
}: {
  card: PrCard
  queue: boolean
  busy: boolean
  started: { sessionId: string; repoId: string } | undefined
  error: string | undefined
  onAction: (pr: PrSummary) => void
  onOpenSession: (sessionId: string, repoId: string) => void
}) {
  const { pr } = card
  const linked = started?.sessionId ?? card.linkedSessionId
  return (
    <article className="flex flex-col gap-2 rounded-xl border border-border bg-card px-3 py-2.5">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          {/* A plain external anchor: main.tsx's delegated handler routes it to
              the OS browser and gives it the shared link context menu. */}
          <a
            href={pr.url}
            className="block text-[13px] font-medium leading-snug text-foreground outline-none hover:text-primary focus-visible:ring-2 focus-visible:ring-ring/40"
          >
            {pr.title}
          </a>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
            <span className="font-mono text-[10.5px]">{card.repo}</span>
            <span className="font-mono text-[10.5px] text-muted-foreground/70">{card.number}</span>
            <span className="flex items-center gap-1">
              <Dot tone={card.ciTone} />
              {card.ciLabel}
            </span>
            {queue && pr.author && (
              <span className="truncate text-muted-foreground/70">{pr.author}</span>
            )}
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          {queue ? (
            <Badge tone={card.ageTone}>waiting {card.ageLabel}</Badge>
          ) : (
            <Badge tone={card.reviewTone}>{card.reviewLabel}</Badge>
          )}
          {card.unresolvedLabel && !queue && (
            <span className="text-[10.5px] text-muted-foreground tabular-nums">
              {card.unresolvedLabel}
            </span>
          )}
        </div>
      </div>

      {card.sessionRunning && linked ? (
        <SessionStrip
          label={queue ? "review session running" : "session running"}
          onOpen={() => onOpenSession(linked, started?.repoId ?? "")}
        />
      ) : started ? (
        <SessionStrip
          label="session started"
          onOpen={() => onOpenSession(started.sessionId, started.repoId)}
        />
      ) : null}

      {error && <p className="text-[11px] text-destructive">{error}</p>}

      <div className="flex items-center gap-2">
        {queue ? (
          <span className="truncate text-[11px] text-muted-foreground/70">{card.reviewLabel}</span>
        ) : (
          <span className="truncate text-[11px] text-muted-foreground/70">
            updated {card.ageLabel}
          </span>
        )}
        <span className="flex-1" />
        {queue ? (
          <Button size="sm" variant="outline" disabled={busy} onClick={() => onAction(pr)}>
            {busy ? "Starting…" : "Review PR"}
          </Button>
        ) : card.showResolve ? (
          <Button size="sm" disabled={busy} onClick={() => onAction(pr)}>
            {busy ? "Starting…" : "Resolve Comments"}
          </Button>
        ) : (
          <span className="text-[11px] text-muted-foreground/60">no unresolved comments</span>
        )}
      </div>
    </article>
  )
}

/** First-run setup. Deliberately inside the panel: v1 has no settings section. */
function SetupForm({
  config,
  onSaved,
}: {
  config: PrReviewsConfig | null
  onSaved: () => void
}) {
  const [org, setOrg] = useState(config?.org ?? "")
  const [token, setToken] = useState("")
  const [readyLabel, setReadyLabel] = useState(config?.readyLabel ?? DEFAULT_READY_LABEL)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const orgs = config?.orgs ?? []

  const save = async () => {
    if (!org.trim()) {
      setError("Pick an organization first.")
      return
    }
    setSaving(true)
    setError(null)
    const result = await updatePrReviewsConfig({
      org: org.trim(),
      // Omitted rather than blank: an empty string would clear a stored token.
      ...(token.trim() ? { token: token.trim() } : {}),
      readyLabel: readyLabel.trim() || DEFAULT_READY_LABEL,
    })
    setSaving(false)
    if (!result.ok) {
      setError(result.error)
      return
    }
    setToken("")
    onSaved()
  }

  const field =
    "h-8 w-full rounded-lg border border-input bg-background/50 px-2.5 text-[12.5px] text-foreground outline-none transition-colors placeholder:text-muted-foreground/60 focus-visible:border-ring/50 focus-visible:ring-2 focus-visible:ring-ring/25"

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border bg-card px-3 py-3">
      <div>
        <p className="font-medium text-[13px]">Connect GitHub</p>
        <p className="mt-0.5 text-[11.5px] text-muted-foreground">
          Chunky lists your open PRs and the review queue for one organization.
        </p>
      </div>

      <label className="flex flex-col gap-1">
        <span className="text-[11px] text-muted-foreground">Organization</span>
        {orgs.length > 0 ? (
          <select value={org} onChange={(e) => setOrg(e.target.value)} className={field}>
            <option value="">Select an organization…</option>
            {orgs.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        ) : (
          <input
            value={org}
            onChange={(e) => setOrg(e.target.value)}
            placeholder="acme"
            className={cn(field, "font-mono")}
          />
        )}
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-[11px] text-muted-foreground">
          Personal access token {config?.hasToken && <span className="text-success">· stored</span>}
        </span>
        <input
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="uses gh auth token if empty"
          autoComplete="off"
          className={field}
        />
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-[11px] text-muted-foreground">Ready-for-review label</span>
        <input
          value={readyLabel}
          onChange={(e) => setReadyLabel(e.target.value)}
          placeholder={DEFAULT_READY_LABEL}
          className={cn(field, "font-mono")}
        />
      </label>

      {error && <p className="text-[11.5px] text-destructive">{error}</p>}

      <Button size="sm" disabled={saving} onClick={() => void save()}>
        {saving ? "Saving…" : "Save and fetch"}
      </Button>
    </div>
  )
}

/**
 * Right-anchored slide-over over the whole window: the same Base UI Dialog the
 * modal dialogs use (so focus trapping, Esc and the scrim come for free), with
 * the popup pinned to the right edge and entering on the X axis.
 *
 * The board itself is owned by App (it polls it for the sidebar widget too);
 * this component owns only what is meaningless while closed — the config form,
 * in-flight actions, and the clock behind the age badges.
 */
export function PrPanel({
  open,
  onOpenChange,
  state,
  unsupported,
  error,
  loading,
  onRefresh,
  onReload,
  isSessionBusy,
  onOpenSession,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  state: PrReviewsState | null
  /** The connected server predates the PR reviews routes. */
  unsupported: boolean
  error: string | null
  loading: boolean
  /** Force the server to poll GitHub again. */
  onRefresh: () => Promise<void>
  /** Re-read the cached board (after a config save or an action). */
  onReload: () => Promise<void>
  isSessionBusy: (sessionId: string) => boolean
  onOpenSession: (sessionId: string, repoId: string) => void
}) {
  const [now, setNow] = useState(() => Date.now())
  const [config, setConfig] = useState<PrReviewsConfig | null>(null)
  const [pending, setPending] = useState<Record<string, boolean>>({})
  const [started, setStarted] = useState<Record<string, { sessionId: string; repoId: string }>>({})
  const [actionErrors, setActionErrors] = useState<Record<string, string>>({})

  // Ages are relative, so the panel keeps its own slow clock while it is open.
  useEffect(() => {
    if (!open) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(timer)
  }, [open])

  const configured = state?.configured === true && !!state?.org
  const loadConfig = useCallback(async () => {
    const result = await getPrReviewsConfig()
    if (result.ok) setConfig(result.config)
  }, [])

  // The org list and token state are only interesting while the panel is open.
  useEffect(() => {
    if (!open || unsupported) return
    void loadConfig()
  }, [open, unsupported, loadConfig])

  const runAction = useCallback(
    async (pr: PrSummary, queue: boolean) => {
      setPending((prev) => ({ ...prev, [pr.id]: true }))
      setActionErrors((prev) => {
        if (!prev[pr.id]) return prev
        const next = { ...prev }
        delete next[pr.id]
        return next
      })
      const request = { repo: pr.repo, number: pr.number }
      const result = queue ? await startPrReview(request) : await resolvePrComments(request)
      setPending((prev) => ({ ...prev, [pr.id]: false }))
      if (!result.ok) {
        setActionErrors((prev) => ({ ...prev, [pr.id]: result.error }))
        return
      }
      setStarted((prev) => ({ ...prev, [pr.id]: result.action }))
      // The server now knows the PR's linked session; pick it up so the card
      // can start reporting the run's live state.
      void onReload()
    },
    [onReload],
  )

  const mine = state ? sortMine(state.mine, now) : []
  const queue = state ? sortReviewQueue(state.reviewQueue, now) : []

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop
          className={cn(
            "fixed inset-0 z-50 bg-background/60 backdrop-blur-[3px]",
            "transition-opacity duration-200 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0",
          )}
        />
        <DialogPrimitive.Popup
          data-slot="pr-panel"
          className={cn(
            NO_DRAG_REGION,
            "fixed inset-y-0 right-0 z-50 flex w-[440px] max-w-[calc(100vw-2rem)] flex-col border-border border-l bg-popover text-popover-foreground shadow-panel outline-none",
            "transition-transform duration-200 data-[ending-style]:translate-x-full data-[starting-style]:translate-x-full",
          )}
        >
          <header className="flex shrink-0 items-center gap-2 border-border/70 border-b px-4 py-3">
            <DialogPrimitive.Title className="font-semibold text-[14px] tracking-tight">
              PR Reviews
            </DialogPrimitive.Title>
            {state?.org && (
              <span className="truncate font-mono text-[11px] text-muted-foreground">
                {state.org}
              </span>
            )}
            <span className="flex-1" />
            <span className="shrink-0 text-[11px] text-muted-foreground/70">
              {loading ? "updating…" : formatFetchedAt(state?.fetchedAt ?? null, now)}
            </span>
            <button
              type="button"
              onClick={() => void onRefresh()}
              disabled={loading || unsupported}
              aria-label="Refresh"
              className="inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50"
            >
              <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
            </button>
            <DialogPrimitive.Close
              aria-label="Close"
              className="inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              <X className="size-4" />
            </DialogPrimitive.Close>
          </header>

          <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-4">
            {unsupported ? (
              <p className="px-3 py-10 text-center text-[12px] text-muted-foreground/70">
                {error ?? "This Chunky server doesn't support PR reviews yet."}
              </p>
            ) : !configured ? (
              <div className="pt-3">
                <SetupForm
                  config={config}
                  onSaved={() => {
                    void loadConfig()
                    void onRefresh()
                  }}
                />
                {error && <p className="px-1 pt-3 text-[11.5px] text-destructive">{error}</p>}
              </div>
            ) : (
              <>
                {(error || state?.error) && (
                  <p className="mt-3 rounded-lg border border-destructive/30 bg-destructive/10 px-2.5 py-1.5 text-[11.5px] text-destructive">
                    {error ?? state?.error}
                  </p>
                )}

                <SectionHeader label="My PRs" count={mine.length} />
                <div className="flex flex-col gap-2">
                  {mine.length === 0 && (
                    <p className="px-1 py-3 text-[12px] text-muted-foreground/60">
                      No open pull requests.
                    </p>
                  )}
                  {mine.map((pr) => (
                    <PrCardView
                      key={pr.id}
                      card={toPrCard(pr, { now, isSessionBusy })}
                      queue={false}
                      busy={pending[pr.id] === true}
                      started={started[pr.id]}
                      error={actionErrors[pr.id]}
                      onAction={(target) => void runAction(target, false)}
                      onOpenSession={onOpenSession}
                    />
                  ))}
                </div>

                <SectionHeader label="Ready for Review" count={queue.length} />
                <div className="flex flex-col gap-2">
                  {queue.length === 0 && (
                    <p className="px-1 py-3 text-[12px] text-muted-foreground/60">
                      Nothing is waiting for review.
                    </p>
                  )}
                  {queue.map((pr) => (
                    <PrCardView
                      key={pr.id}
                      card={toPrCard(pr, { now, isSessionBusy, queue: true })}
                      queue
                      busy={pending[pr.id] === true}
                      started={started[pr.id]}
                      error={actionErrors[pr.id]}
                      onAction={(target) => void runAction(target, true)}
                      onOpenSession={onOpenSession}
                    />
                  ))}
                </div>
              </>
            )}
          </div>
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
