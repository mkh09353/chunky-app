// Home: the cross-repository feed that owns the main panel instead of a
// transcript.
//
// It answers one question — "what happened while I was away, and what needs
// me?" — with three flat, urgency-ordered sections (lib/homeFeed decides what
// goes where; this file only renders). Rows are single-line and dense on
// purpose: the realistic load is a few repositories with a few live threads
// each, and a triage list you have to scroll is a triage list you skip.
//
// Repo affiliation is carried by every row rather than by headings, so the eye
// can scan one vertical strip for "which repo" without the list re-sorting
// itself by anything other than time. The accent colours are token-derived
// (primary/info/success/warning), never a new palette.
import { House, Loader2 } from "lucide-react"
import { useMemo } from "react"
import { cn } from "~/lib/cn"
import { relativeTime, threadLabel } from "~/lib/format"
import { WorkingSpinner } from "./ui/status-indicator"
import {
  homeFeedCounts,
  type FeedRepo,
  type FeedRow,
  type HomeFeed,
  type NeedsYouRow,
  type RunningRow,
} from "~/lib/homeFeed"

/** Token-derived accents, assigned by repo order so a repo keeps its colour for
 *  as long as the tab strip does. */
const REPO_ACCENTS = [
  "var(--primary)",
  "var(--info)",
  "var(--success)",
  "var(--warning)",
  "color-mix(in oklab, var(--info) 55%, var(--success))",
  "color-mix(in oklab, var(--primary) 55%, var(--warning))",
] as const

/** "3m 12s", "18m", "1h 04m" — compact, monotone, no faked precision. */
function elapsedLabel(ms: number): string {
  const total = Math.floor(ms / 1000)
  const seconds = total % 60
  const minutes = Math.floor(total / 60) % 60
  const hours = Math.floor(total / 3600)
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, "0")}s`
  return `${seconds}s`
}

function SectionHeading({
  title,
  count,
  hot = false,
  children,
}: {
  title: string
  count: number
  hot?: boolean
  children?: React.ReactNode
}) {
  return (
    <div className="mb-2 flex items-center gap-2 px-1">
      <h2
        className={cn(
          "font-semibold text-[11px] uppercase tracking-[0.08em]",
          hot ? "text-foreground" : "text-muted-foreground",
        )}
      >
        {title}
      </h2>
      <span
        className={cn(
          "rounded-full border px-1.5 py-px font-medium text-[10px] leading-none",
          hot
            ? "border-warning/35 bg-warning/15 text-warning"
            : "border-border bg-muted text-muted-foreground",
        )}
      >
        {count}
      </span>
      {children}
    </div>
  )
}

function RepoChip({ row, accent }: { row: FeedRow; accent: string }) {
  return (
    <span className="flex w-[104px] shrink-0 items-center gap-1.5 overflow-hidden">
      <span
        aria-hidden="true"
        className="size-1.5 shrink-0 rounded-full"
        style={{ backgroundColor: accent }}
      />
      <span className="truncate font-mono text-[10.5px] tracking-tight text-muted-foreground">
        {row.repoName}
      </span>
    </span>
  )
}

function Row({
  row,
  accent,
  glyph,
  context,
  trailing,
  tone = "plain",
  onOpen,
}: {
  row: FeedRow
  accent: string
  glyph: React.ReactNode
  context?: string
  trailing?: React.ReactNode
  tone?: "plain" | "attention"
  onOpen: () => void
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        "flex w-full min-w-0 cursor-pointer items-center gap-2.5 rounded-lg border px-2.5 py-1.5 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/40",
        tone === "attention"
          ? "border-warning/25 bg-warning/[0.06] hover:border-warning/45 hover:bg-warning/10"
          : "border-transparent hover:bg-muted",
      )}
    >
      <span className="flex w-3 shrink-0 items-center justify-center">{glyph}</span>
      <RepoChip row={row} accent={accent} />
      <span className="max-w-[44%] shrink-0 truncate font-medium text-[12.5px] tracking-[-0.008em]">
        {threadLabel(row.title)}
      </span>
      <span className="min-w-0 flex-1 truncate text-[12px] text-muted-foreground">
        {context ?? ""}
      </span>
      {trailing}
    </button>
  )
}

export function HomeView({
  feed,
  repos,
  now,
  displayName,
  goalsLoading = false,
  onOpenSession,
}: {
  feed: HomeFeed
  /** Repository order, for stable accent assignment. */
  repos: readonly FeedRepo[]
  /** Coarse wall clock (App's minute clock) — drives elapsed/relative labels. */
  now: number
  displayName?: string
  /** A Needs You sweep is in flight; the section says so instead of claiming
   *  emptiness it cannot yet vouch for. */
  goalsLoading?: boolean
  /** Row click: switch repo tab + sidebar + transcript, and leave Home. */
  onOpenSession: (sessionId: string, repoId: string) => void
}) {
  const accentOf = useMemo(() => {
    const map = new Map<string, string>()
    repos.forEach((repo, index) => map.set(repo.id, REPO_ACCENTS[index % REPO_ACCENTS.length]!))
    return (repoId: string) => map.get(repoId) ?? "var(--muted-foreground)"
  }, [repos])

  const counts = useMemo(() => homeFeedCounts(feed), [feed])
  // First name only: the greeting is a hello, not an address label.
  const firstName = displayName?.trim().split(/\s+/)[0] ?? ""
  const greeting = firstName ? `What's next, ${firstName}?` : "What's next?"
  const nothing =
    feed.needsYou.length === 0 && feed.running.length === 0 && feed.settled.length === 0

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto">
      <div className="chunky-aurora">
        <div className="mx-auto w-full min-w-0 max-w-[780px] px-6 pb-16">
          {/* Greeting. The omnibox lives here in a later pass; for now the line
              below just says where work starts. */}
          <div className="pt-9 pb-6 text-center">
            <h1 className="font-semibold text-[21px] leading-tight tracking-[-0.024em]">
              {greeting}
            </h1>
            <p className="mt-1.5 text-[12px] text-muted-foreground">
              {nothing ? (
                "Nothing is running and nothing is waiting on you."
              ) : (
                <>
                  {counts.needsYou > 0 && (
                    <>
                      <span className="font-medium text-warning">
                        {counts.needsYou} need{counts.needsYou === 1 ? "s" : ""} you
                      </span>
                      <span className="mx-1.5 opacity-40">·</span>
                    </>
                  )}
                  {counts.running} running
                  <span className="mx-1.5 opacity-40">·</span>
                  {counts.repos} repo{counts.repos === 1 ? "" : "s"}
                </>
              )}
            </p>
            <p className="mt-3 text-[11.5px] text-muted-foreground/70">
              Pick up a thread below, or press ⌘N to start something new.
            </p>
          </div>

          {(feed.needsYou.length > 0 || goalsLoading) && (
            <section className="mt-6">
              <SectionHeading title="Needs you" count={feed.needsYou.length} hot>
                {goalsLoading && (
                  <Loader2 className="size-3 animate-spin text-muted-foreground" aria-label="Checking" />
                )}
              </SectionHeading>
              <div className="flex flex-col gap-1">
                {feed.needsYou.map((row: NeedsYouRow) => (
                  <Row
                    key={row.sessionId}
                    row={row}
                    accent={accentOf(row.repoId)}
                    tone="attention"
                    glyph={
                      <span
                        aria-label="Blocked"
                        className="size-2 rounded-full bg-warning ring-[3px] ring-warning/20"
                      />
                    }
                    context={row.reason}
                    trailing={
                      <span className="shrink-0 text-[11px] text-warning tabular-nums">
                        waiting {relativeTime(row.lastActivity, now)}
                      </span>
                    }
                    onOpen={() => onOpenSession(row.sessionId, row.repoId)}
                  />
                ))}
              </div>
            </section>
          )}

          {feed.running.length > 0 && (
            <section className="mt-6">
              <SectionHeading title="Still running" count={feed.running.length} />
              <div className="flex flex-col gap-1">
                {feed.running.map((row: RunningRow) => (
                  <Row
                    key={row.sessionId}
                    row={row}
                    accent={accentOf(row.repoId)}
                    glyph={<WorkingSpinner aria-label="Working" />}
                    trailing={
                      row.elapsedMs == null ? null : (
                        <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
                          {elapsedLabel(row.elapsedMs)}
                        </span>
                      )
                    }
                    onOpen={() => onOpenSession(row.sessionId, row.repoId)}
                  />
                ))}
              </div>
            </section>
          )}

          {feed.settled.length > 0 && (
            <section className="mt-6">
              <SectionHeading title="Recently settled" count={feed.settled.length}>
                {feed.settledHidden > 0 && (
                  <span className="ml-auto text-[11px] text-muted-foreground/70">
                    +{feed.settledHidden} older
                  </span>
                )}
              </SectionHeading>
              <div className="flex flex-col">
                {feed.settled.map((row) => (
                  <div key={row.sessionId} className="border-border/60 border-b last:border-b-0">
                    <Row
                      row={row}
                      accent={accentOf(row.repoId)}
                      glyph={
                        row.unread ? (
                          <span
                            aria-label="Just finished"
                            className="size-2 rounded-full bg-primary ring-[3px] ring-primary/20"
                          />
                        ) : (
                          <span className="size-1.5 rounded-full bg-foreground/20" />
                        )
                      }
                      trailing={
                        <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
                          {relativeTime(row.lastActivity, now)}
                        </span>
                      }
                      onOpen={() => onOpenSession(row.sessionId, row.repoId)}
                    />
                  </div>
                ))}
              </div>
            </section>
          )}

          {nothing && !goalsLoading && (
            <div className="mt-10 flex flex-col items-center gap-2 text-center text-muted-foreground">
              <House className="size-5 opacity-50" />
              <p className="text-[12.5px]">All quiet across your repositories.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
