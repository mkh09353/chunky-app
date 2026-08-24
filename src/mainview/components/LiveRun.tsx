// Delegated runs, rendered INSIDE the tool card that spawned them.
//
// A `sidekick` / `spawn_thread` / `workflow` call opens a child thread; the
// transcript reducer records that as a RunRecord anchored to the tool pill it
// came from (lib/transcript + lib/runs). The pill is the run's ONLY home in the
// transcript: while it is in flight the card carries a live tail of the
// delegate's own output, and once it settles that tail is replaced by the whole
// delegate transcript, one expansion away (`renderRunDetail`).
//
// A context rather than prop-drilling: the pill lives inside
// ChatView → row → Message → block → ToolCard, several levels below anything
// that holds transcript state. Sessions without a transcript (demo/offline)
// simply get the empty default, so nothing renders.
import { Bot, Loader2, Sparkles, Square } from "lucide-react"
import { createContext, useContext, useState } from "react"
import type { StopDelegateRequest } from "@chunky/protocol"
import { cn } from "~/lib/cn"
import { formatElapsed, isSeatRun, type LiveRunView, type TailLine, type TailTone } from "~/lib/runs"
import type { RunRecord } from "~/lib/transcript"

export const TAIL_TONE: Record<TailTone, string> = {
  cmd: "text-foreground/80",
  ok: "text-success",
  fail: "text-destructive",
  text: "text-muted-foreground",
  dim: "text-muted-foreground/60",
}

/** Newest line sits at the bottom; the oldest fades out under the mask.
 *
 *  The box height is FIXED (rows, not content): a delegate that emits ten lines
 *  a second must not grow the transcript under the reader, which would fight
 *  ChatView's follow-the-bottom rule and re-trigger its scrolling. */
export function TailLines({
  lines,
  rows = 5,
  className,
}: {
  lines: TailLine[]
  rows?: number
  className?: string
}) {
  const lineHeight = 17
  return (
    <div
      className={cn(
        "flex flex-col justify-end overflow-hidden font-mono text-[10.5px] leading-[17px]",
        className,
      )}
      style={{
        height: rows * lineHeight,
        WebkitMaskImage:
          "linear-gradient(to bottom, transparent 0%, rgba(0,0,0,0.28) 14%, #000 46%, #000 100%)",
        maskImage:
          "linear-gradient(to bottom, transparent 0%, rgba(0,0,0,0.28) 14%, #000 46%, #000 100%)",
      }}
    >
      {lines.length === 0 ? (
        <div className="truncate text-muted-foreground/60">waiting for output…</div>
      ) : (
        lines.slice(Math.max(0, lines.length - rows)).map((line, i) => (
          <div key={i} className={cn("truncate whitespace-pre", TAIL_TONE[line.tone])}>
            {line.text}
          </div>
        ))
      )}
    </div>
  )
}

export interface LiveRunsValue {
  /** Running runs by run id; a tool card looks up the ones it spawned. */
  views: Map<string, LiveRunView>
  /** Wall-clock elapsed for a run we watched start, else undefined. */
  elapsedOf: (runId: string) => number | undefined
  /** Every run by id, live or settled — a pill names the runs it owns. */
  runs: Map<string, RunRecord>
  /** The delegate's own transcript, rendered in the pill's expanded body.
   *
   *  A render prop rather than the component itself: the detail renderer
   *  (AgentCard) already renders MessageView, so importing it from a message
   *  would close an import cycle. ChatView owns transcript state anyway. */
  renderRunDetail?: (runId: string) => React.ReactNode
  /** Cancel one delegated run (server stop_delegate). Absent when there is no
   *  live session, or once this server has told us it has no such endpoint —
   *  which is what makes the Stop control disappear instead of failing. */
  onStopRun?: (runId: string, target: StopDelegateRequest) => void | Promise<void>
}

const EMPTY: LiveRunsValue = { views: new Map(), elapsedOf: () => undefined, runs: new Map() }

const LiveRunsContext = createContext<LiveRunsValue>(EMPTY)

export function useLiveRuns(): LiveRunsValue {
  return useContext(LiveRunsContext)
}

export function LiveRunsProvider({
  value,
  children,
}: {
  value: LiveRunsValue
  children: React.ReactNode
}) {
  return <LiveRunsContext.Provider value={value}>{children}</LiveRunsContext.Provider>
}

/**
 * Stop this delegate — shown only on a RUNNING run the server can actually be
 * asked to cancel (see `stopTargetOf`).
 *
 * It lives in the live section rather than the pill header because the header
 * IS the card's expand/collapse button, and a button inside a button is neither
 * valid nor clickable. The click is still stopped from bubbling so a future
 * clickable ancestor cannot toggle or navigate underneath it. Pending state is
 * component-local: one in-flight request per control, no store.
 */
export function StopRunButton({
  onStop,
  label = "Stop this delegate",
}: {
  onStop: () => void | Promise<void>
  label?: string
}) {
  const [pending, setPending] = useState(false)
  return (
    <button
      type="button"
      data-run-stop=""
      aria-label={label}
      title={label}
      disabled={pending}
      onClick={(event) => {
        event.stopPropagation()
        event.preventDefault()
        if (pending) return
        setPending(true)
        void (async () => {
          try {
            await onStop()
          } finally {
            setPending(false)
          }
        })()
      }}
      className={cn(
        "inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground outline-none transition-colors",
        "hover:bg-destructive/10 hover:text-destructive focus-visible:ring-2 focus-visible:ring-ring/40",
        pending && "cursor-default opacity-60",
      )}
    >
      {pending ? (
        <Loader2 className="size-3 animate-spin" />
      ) : (
        <Square className="size-3 fill-current" />
      )}
    </button>
  )
}

/** The live section of a tool card: who is running, for how long, and the tail
 *  of what it is doing right now. Compact by default; the card's own expand
 *  toggle shows more of the same stream. */
export function LiveRunSection({
  view,
  elapsedMs,
  expanded = false,
  onStop,
}: {
  view: LiveRunView
  elapsedMs?: number
  expanded?: boolean
  /** Present only when this run is stoppable (running + targetable). */
  onStop?: () => void | Promise<void>
}) {
  // Same seat rule the ambient strip uses, so a run wears one glyph everywhere.
  const Icon = isSeatRun(view) ? Bot : Sparkles
  return (
    <div
      data-run-live={view.runId}
      className="border-border/70 border-t bg-primary/[0.03] px-2.5 pt-1.5 pb-2"
    >
      <div className="flex items-center gap-1.5 text-[10.5px] text-muted-foreground">
        <Icon className="size-3 shrink-0 text-primary/80" />
        <span className="min-w-0 truncate font-medium text-foreground/80">{view.title}</span>
        {view.model && (
          <span className="max-w-28 shrink-0 truncate font-mono text-muted-foreground/70">
            {view.model}
          </span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-1.5 font-mono text-muted-foreground/70">
          {elapsedMs != null && <span>{formatElapsed(elapsedMs)}</span>}
          {elapsedMs != null && view.toolCount > 0 && <span>·</span>}
          {view.toolCount > 0 && (
            <span>
              {view.toolCount} tool{view.toolCount === 1 ? "" : "s"}
            </span>
          )}
          <span className="size-1.5 animate-pulse rounded-full bg-primary" />
          {onStop && <StopRunButton onStop={onStop} label={`Stop ${view.title}`} />}
        </span>
      </div>
      <TailLines lines={view.lines} rows={expanded ? 10 : 3} className="mt-1" />
    </div>
  )
}
