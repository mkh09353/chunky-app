// Shared vocabulary for the Zoo workspace: the small pieces every view repeats
// (badges, notices, evidence quotes) plus the labels and tones for the
// product-factory's own enums. Tokens and primitives come from index.css and
// components/ui — nothing new is introduced here.

import { AlertCircle, Quote } from "lucide-react"
import type { ReactNode } from "react"
import { cn } from "~/lib/cn"
import type { ZooEvidence, ZooIdeaType, ZooItemStage } from "~/lib/zoo"

export const IDEA_TYPE_LABEL: Record<ZooIdeaType, string> = {
  close: "Close",
  investigate: "Investigate",
  build: "Build",
  "needs-detail": "Needs detail",
}

export const IDEA_TYPE_TONE: Record<ZooIdeaType, string> = {
  close: "border-border bg-muted/40 text-muted-foreground",
  investigate: "border-primary/30 bg-primary/10 text-primary",
  build: "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  "needs-detail": "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400",
}

export const STAGE_LABEL: Record<ZooItemStage, string> = {
  research: "Research",
  decision: "Decision",
  building: "Building",
  review: "Review",
  shipped: "Shipped",
  dropped: "Dropped",
}

export const STAGE_TONE: Record<ZooItemStage, string> = {
  research: "border-primary/30 bg-primary/10 text-primary",
  decision: "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400",
  building: "border-primary/30 bg-primary/10 text-primary",
  review: "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400",
  shipped: "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  dropped: "border-border bg-muted/40 text-muted-foreground",
}

export function priorityTone(priority: number): string {
  if (priority <= 2) return "border-destructive/40 bg-destructive/10 text-destructive"
  if (priority === 3) return "border-primary/30 bg-primary/10 text-primary"
  return "border-border bg-muted/40 text-muted-foreground"
}

export function Badge({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <span
      className={cn(
        "shrink-0 rounded-full border px-2 py-0.5 font-medium text-[10.5px] leading-4",
        className,
      )}
    >
      {children}
    </span>
  )
}

export function Notice({ text, tone = "error" }: { text: string; tone?: "error" | "muted" }) {
  return (
    <p
      className={cn(
        "flex min-w-0 items-start gap-1.5 rounded-lg border px-2.5 py-2 text-[12px] leading-relaxed",
        tone === "error"
          ? "border-destructive/30 bg-destructive/10 text-destructive"
          : "border-border/70 bg-muted/30 text-muted-foreground",
      )}
    >
      {tone === "error" && <AlertCircle className="mt-px size-3.5 shrink-0" />}
      <span className="min-w-0 whitespace-pre-wrap break-words">{text}</span>
    </p>
  )
}

/** A cited quote. Clickable when the view can open the artifact behind it. */
export function EvidenceQuote({
  cite,
  onOpen,
}: {
  cite: ZooEvidence
  onOpen?: (artifactId: string) => void
}) {
  const body = (
    <>
      <Quote className="mt-0.5 size-3 shrink-0 text-muted-foreground/70" />
      <span className="min-w-0 whitespace-pre-wrap break-words">{cite.quote}</span>
    </>
  )
  if (!onOpen) {
    return (
      <p className="flex min-w-0 items-start gap-1.5 px-1.5 py-1 text-[12px] leading-relaxed text-muted-foreground">
        {body}
      </p>
    )
  }
  return (
    <button
      type="button"
      title="Open the artifact this came from"
      onClick={() => onOpen(cite.artifactId)}
      className="flex w-full min-w-0 cursor-pointer items-start gap-1.5 rounded-lg px-1.5 py-1 text-left text-[12px] leading-relaxed text-muted-foreground hover:bg-accent/60 hover:text-foreground"
    >
      {body}
    </button>
  )
}

export function EmptyState({
  icon,
  title,
  body,
  action,
}: {
  icon: ReactNode
  title: string
  body: string
  action?: ReactNode
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-8 py-16 text-center">
      <div className="flex size-11 items-center justify-center rounded-2xl border border-primary/20 bg-primary/10 text-primary">
        {icon}
      </div>
      <div className="max-w-md">
        <p className="font-medium text-[14px] text-foreground">{title}</p>
        <p className="mt-1 whitespace-pre-wrap break-words text-[12.5px] leading-relaxed text-muted-foreground">
          {body}
        </p>
      </div>
      {action}
    </div>
  )
}

export function ViewHeader({
  title,
  subtitle,
  action,
}: {
  title: string
  subtitle?: string
  action?: ReactNode
}) {
  return (
    <div className="flex min-w-0 items-end justify-between gap-3 px-6 pt-5 pb-3">
      <div className="min-w-0">
        <h2 className="font-semibold text-[17px] text-foreground tracking-tight">{title}</h2>
        {subtitle && (
          <p className="mt-0.5 min-w-0 break-words text-[12.5px] text-muted-foreground">{subtitle}</p>
        )}
      </div>
      {action}
    </div>
  )
}
