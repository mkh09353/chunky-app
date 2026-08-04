import { cn } from "~/lib/cn"
import type { PrWidgetSummary } from "~/lib/prReviews"

/** One count with a colour-coded dot. Nothing is rendered for a zero count —
 *  the row should read as a state, not as a form with empty fields. */
function Fact({
  n,
  label,
  tone = "muted",
}: {
  n: number
  label: string
  tone?: "muted" | "bad" | "warn" | "info"
}) {
  if (n <= 0) return null
  return (
    <span className="flex items-center gap-1 whitespace-nowrap">
      <span
        className={cn(
          "size-1 shrink-0 rounded-full",
          tone === "bad" && "bg-destructive",
          tone === "warn" && "bg-warning",
          tone === "info" && "bg-info",
          tone === "muted" && "bg-muted-foreground/40",
        )}
      />
      <span className="tabular-nums">{n}</span>
      <span>{label}</span>
    </span>
  )
}

function SummaryRow({
  label,
  count,
  children,
  onClick,
  empty,
}: {
  label: string
  count: number
  children: React.ReactNode
  onClick: () => void
  empty: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full cursor-pointer flex-col gap-0.5 rounded-lg px-2.5 py-1.5 text-left outline-none transition-colors hover:bg-sidebar-accent/50 focus-visible:ring-2 focus-visible:ring-ring/40"
    >
      <span className="flex w-full items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-[12.5px] leading-tight text-foreground/85">
          {label}
        </span>
        <span className="shrink-0 text-[10.5px] text-muted-foreground/55 tabular-nums">
          {count}
        </span>
      </span>
      <span className="flex flex-wrap items-center gap-x-2 text-[10.5px] text-muted-foreground/70">
        {count > 0 ? children : <span>{empty}</span>}
      </span>
    </button>
  )
}

/**
 * The always-visible PR summary, pinned above the sidebar footer.
 *
 * Presentation only: the counts arrive derived (lib/prReviews summarize) and
 * every row just opens the panel, which owns fetching and actions. The unread
 * dot follows the sidebar's own convention — a solid primary dot meaning "new
 * since you last looked", cleared by opening the panel.
 */
export function PrWidget({
  summary,
  configured,
  unread,
  org,
  onOpen,
}: {
  summary: PrWidgetSummary
  /** False before a token/org exists — the widget offers setup instead of counts. */
  configured: boolean
  /** New server data arrived since the panel was last opened. */
  unread: boolean
  org: string | null
  onOpen: () => void
}) {
  return (
    <div className="relative z-10 border-border/70 border-t px-2 py-2">
      <div className="flex items-center gap-2 px-2.5 pt-1 pb-1.5">
        <span className="font-medium text-[10.5px] text-muted-foreground/60 uppercase tracking-[0.08em]">
          Pull requests
        </span>
        {unread && (
          <span className="size-1.5 shrink-0 rounded-full bg-primary" aria-label="New activity" />
        )}
        <span className="h-px flex-1 bg-border/60" />
        {org && (
          <span className="truncate font-mono text-[10px] text-muted-foreground/40">{org}</span>
        )}
      </div>

      {configured ? (
        <div className="flex flex-col gap-0.5">
          <SummaryRow
            label="My PRs"
            count={summary.open}
            onClick={onOpen}
            empty="none open"
          >
            <Fact n={summary.open} label="open" />
            <Fact n={summary.unresolved} label="unresolved" tone="info" />
            <Fact n={summary.ciFailing} label="CI failing" tone="bad" />
          </SummaryRow>

          <SummaryRow
            label="Review"
            count={summary.ready}
            onClick={onOpen}
            empty="queue clear"
          >
            <Fact n={summary.ready} label="ready" />
            <Fact n={summary.waitingLong} label="waiting >1d" tone="warn" />
          </SummaryRow>
        </div>
      ) : (
        <button
          type="button"
          onClick={onOpen}
          className="w-full cursor-pointer rounded-lg px-2.5 py-1.5 text-left text-[12px] text-muted-foreground/70 outline-none transition-colors hover:bg-sidebar-accent/50 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
        >
          Set up PR reviews
        </button>
      )}
    </div>
  )
}
