// "Still working" — the ambient strip above the composer.
//
// The problem it exists for: a detached sidekick or spawn legitimately outlives
// the lead's turn (lib/transcript keeps its RunRecord open past
// `session.status: idle`), but once the root goes idle the chat column has
// nothing left that says so. The composer returns to its idle shape and the
// only live thing on screen is a fixed-height tail inside one tool pill, which
// is usually scrolled far out of view. It reads as "nothing is happening" right
// up until the report lands.
//
// So: while the root is idle and delegates are still in flight, one calm row
// per live run sits above the composer — who is working, on what model, for how
// long, how many tools in, and the last line it printed. Clicking a row scrolls
// the transcript to the pill that spawned it.
//
// State: none of its own. Rows come from `activeWorkerRows`, which projects the
// same `liveRunViews` the pill's own LiveRunSection reads, so there is exactly
// one tail state in the app. Elapsed comes from the shared run clock.
import { Bot, Sparkles } from "lucide-react"
import { useMemo } from "react"
import { cn } from "~/lib/cn"
import { NO_DRAG_REGION } from "~/lib/dragRegion"
import { activeWorkerRows, formatElapsed, runsById } from "~/lib/runs"
import type { TranscriptState } from "~/lib/transcript"
import { useRunClock } from "~/lib/useRunClock"
import { TAIL_TONE } from "./LiveRun"

/** Scroll the transcript to the pill (or live section) a run belongs to.
 *
 *  Both anchors are already in the DOM — `data-run-pill` on the tool card that
 *  spawned the run and `data-run-live` on its live section — so this needs no
 *  new plumbing through ChatView. The pill is preferred: it is the row's real
 *  home, and the live section sits inside it. */
function scrollToRun(runId: string): void {
  if (typeof document === "undefined") return
  // Run ids are `${threadId}#${nth}`; a quoted attribute value takes the `#`
  // literally, but a stray quote/backslash in a thread id must not break out.
  const escaped = runId.replace(/["\\]/g, "\\$&")
  const target =
    document.querySelector(`[data-run-pill="${escaped}"]`) ??
    document.querySelector(`[data-run-live="${escaped}"]`)
  target?.scrollIntoView({ behavior: "smooth", block: "center" })
}

export function ActiveWorkersStrip({
  transcript,
  /** Is the ROOT turn running? The strip only speaks when it is not. */
  streaming,
  /** Keys the shared run clock, so elapsed survives a session switch. */
  sessionId,
}: {
  transcript?: TranscriptState
  streaming: boolean
  sessionId?: string | null
}) {
  const rows = useMemo(() => activeWorkerRows(transcript, streaming), [transcript, streaming])
  const elapsedOf = useRunClock(transcript?.runs, sessionId)
  const runIndex = useMemo(() => (transcript ? runsById(transcript) : undefined), [transcript])

  if (rows.length === 0) return null

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-1 px-4">
      <div className="flex items-center gap-1.5 px-1 text-[10.5px] text-muted-foreground/70">
        <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-primary motion-reduce:animate-none" />
        <span>
          {rows.length} worker{rows.length === 1 ? "" : "s"} still running
        </span>
      </div>
      {rows.map((row) => {
        const Icon = row.seat ? Bot : Sparkles
        const elapsed = runIndex ? elapsedOf(runIndex.get(row.runId)) : undefined
        return (
          <button
            key={row.runId}
            type="button"
            onClick={() => scrollToRun(row.runId)}
            title="Show this run in the transcript"
            style={{ borderLeftColor: row.accent }}
            className={cn(
              NO_DRAG_REGION,
              "flex w-full cursor-pointer items-center gap-2 rounded-lg border border-border border-l-2 bg-card/60 px-3 py-1.5 text-left shadow-xs outline-none backdrop-blur-sm transition-colors hover:bg-accent/30 focus-visible:ring-2 focus-visible:ring-ring/40",
            )}
          >
            <Icon className="size-3.5 shrink-0 text-primary/80" />
            <span className="min-w-0 shrink-0 max-w-[14rem] truncate font-medium text-[12px]">
              {row.title}
            </span>
            {row.model && (
              <span className="hidden max-w-28 shrink-0 truncate font-mono text-[10px] text-muted-foreground/70 sm:inline">
                {row.model}
              </span>
            )}
            {/* The live line. Single line, truncated: the pill owns the full
                tail, and this must never change height as output streams. */}
            <span
              className={cn(
                "min-w-0 flex-1 truncate font-mono text-[10.5px]",
                row.lastLine ? TAIL_TONE[row.lastLine.tone] : "text-muted-foreground/60",
              )}
            >
              {row.lastLine?.text ?? "waiting for output…"}
            </span>
            <span className="flex shrink-0 items-center gap-1.5 font-mono text-[10px] text-muted-foreground/70">
              {elapsed != null && <span>{formatElapsed(elapsed)}</span>}
              {elapsed != null && row.toolCount > 0 && <span>·</span>}
              {row.toolCount > 0 && (
                <span>
                  {row.toolCount} tool{row.toolCount === 1 ? "" : "s"}
                </span>
              )}
              <span className="size-1.5 animate-pulse rounded-full bg-primary motion-reduce:animate-none" />
            </span>
          </button>
        )
      })}
    </div>
  )
}
