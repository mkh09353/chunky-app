// The live agents rail: bottom-anchored in the transcript scrollport, level
// with the newest turn and the composer — which is where the reader actually
// sits. It shows ONLY work in flight (running) and seats between briefs (idle);
// a run that settles leaves the rail and parks in the transcript gutter beside
// the pill that spawned it.
//
// Cards grow upward from the bottom edge and the panel is height-capped with
// its own scroll, so it can never climb over the whole thread.
import { Bot, ChevronDown, ChevronRight, ChevronsDownUp } from "lucide-react"
import { useCallback, useEffect, useRef, useState } from "react"
import { cn } from "~/lib/cn"
import { activeRun, idleThreads, lastSettledRun, runningThreads, seatName } from "~/lib/runs"
import type { RunRecord, TranscriptState } from "~/lib/transcript"
import { AgentCard } from "./AgentCard"

export function AgentRail({
  transcript,
  modelName,
  elapsedOf,
  collapseSignal = 0,
  onFloatingHeight,
}: {
  transcript: TranscriptState
  modelName?: string
  elapsedOf: (run: RunRecord | undefined) => number | undefined
  /** Fold signal from the session action / end of turn; the rail adds its own. */
  collapseSignal?: number
  /** Reports the panel's height while it FLOATS over the gutter (0 when it is
   *  a in-flow strip, or gone), so the transcript can pad itself clear of it. */
  onFloatingHeight?: (height: number) => void
}) {
  const [minimised, setMinimised] = useState(false)
  const [idleOpen, setIdleOpen] = useState(false)
  const [railFold, setRailFold] = useState(0)
  const rootRef = useRef<HTMLElement | null>(null)

  // Fold-all / end of turn condenses the seat list too, so the whole rail
  // returns to summaries. (Minimised is a deliberate user choice — left alone.)
  useEffect(() => {
    setIdleOpen(false)
  }, [collapseSignal])

  // Measure only while absolutely positioned: as an in-flow strip the rail
  // already occupies space and nothing can slide under it.
  const report = useCallback(() => {
    const el = rootRef.current
    if (!onFloatingHeight) return
    if (!el) return onFloatingHeight(0)
    const floating = getComputedStyle(el).position === "absolute"
    onFloatingHeight(floating ? el.getBoundingClientRect().height : 0)
  }, [onFloatingHeight])

  useEffect(() => {
    report()
    const el = rootRef.current
    if (!el || typeof ResizeObserver === "undefined") return
    const ro = new ResizeObserver(report)
    ro.observe(el)
    window.addEventListener("resize", report)
    return () => {
      ro.disconnect()
      window.removeEventListener("resize", report)
      onFloatingHeight?.(0)
    }
  }, [report, onFloatingHeight])

  const running = runningThreads(transcript)
  const idle = idleThreads(transcript)
  if (running.length === 0 && idle.length === 0) return null

  return (
    <aside
      ref={rootRef}
      data-agent-rail=""
      className={cn(
        // Narrow panel: a full-width strip pinned to the bottom of the scrollport.
        "pointer-events-auto static flex w-full flex-col overflow-hidden rounded-2xl border border-primary/25 bg-sidebar/90 shadow-panel backdrop-blur-md",
        // Wide panel: floats over the gutter, anchored bottom-right, grows up.
        "@[1074px]:absolute @[1074px]:right-0 @[1074px]:bottom-0 @[1074px]:w-[380px]",
      )}
    >
      <div className="flex h-[34px] shrink-0 items-center gap-2 border-border border-b bg-primary/[0.07] px-2.5">
        <Bot className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="font-semibold text-[11px] text-muted-foreground uppercase tracking-wider">
          Live agents
        </span>
        {running.length > 0 && (
          <span className="rounded-full border border-primary/35 bg-primary/15 px-1.5 py-px font-mono text-[10.5px] text-primary">
            {running.length} running
          </span>
        )}
        <span className="flex-1" />
        <button
          type="button"
          onClick={() => {
            setRailFold((n) => n + 1)
            setIdleOpen(false)
          }}
          aria-label="Collapse agent cards"
          className="inline-flex size-[22px] cursor-pointer items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
        >
          <ChevronsDownUp className="size-3.5" />
        </button>
        <button
          type="button"
          onClick={() => setMinimised((m) => !m)}
          aria-label={minimised ? "Expand agent rail" : "Minimise agent rail"}
          className="inline-flex size-[22px] cursor-pointer items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
        >
          <ChevronDown className={cn("size-3.5 transition-transform", minimised && "rotate-180")} />
        </button>
      </div>

      {!minimised && (
        <>
          <div
            className={cn(
              // Narrow: a horizontal strip of cards. Wide: a capped vertical
              // stack that scrolls internally so it can't climb the thread.
              "flex min-h-0 flex-1 flex-row items-start gap-2 overflow-y-auto p-2.5",
              "@[1074px]:max-h-[min(46vh,430px)] @[1074px]:flex-col @[1074px]:items-stretch",
            )}
          >
            {idle.length > 0 && (
              // Idle seats condense to one row so the running cards stay low in
              // the panel — close to the pills that spawned them (short wires).
              <div className="order-1 flex w-[220px] shrink-0 flex-col @[1074px]:w-auto">
                <button
                  type="button"
                  onClick={() => setIdleOpen((o) => !o)}
                  className="flex cursor-pointer items-center gap-1.5 rounded-lg border border-border bg-card/60 px-2 py-1 text-left text-[11px] text-muted-foreground outline-none transition-colors hover:bg-accent/40 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
                >
                  <ChevronRight
                    className={cn("size-3 shrink-0 transition-transform", idleOpen && "rotate-90")}
                  />
                  <span className="shrink-0">{idle.length} idle</span>
                  <span className="min-w-0 truncate text-muted-foreground/70">
                    {idle.map((t) => seatName(t.title)).join(" · ")}
                  </span>
                </button>
                {idleOpen && (
                  <div className="mt-2 flex flex-col gap-2">
                    {idle.map((thread) => {
                      const last = lastSettledRun(transcript, thread.id)
                      const elapsed = elapsedOf(last)
                      return (
                        <AgentCard
                          key={thread.id}
                          variant="idle"
                          transcript={transcript}
                          threadId={thread.id}
                          {...(last ? { run: last } : {})}
                          {...(modelName ? { modelName } : {})}
                          {...(elapsed != null ? { elapsedMs: elapsed } : {})}
                          collapseSignal={collapseSignal + railFold}
                        />
                      )
                    })}
                  </div>
                )}
              </div>
            )}

            {running.map((thread) => {
              const run = activeRun(transcript, thread.id)
              const elapsed = elapsedOf(run)
              return (
                <div key={thread.id} className="order-2 w-[300px] shrink-0 @[1074px]:w-auto">
                  <AgentCard
                    variant="running"
                    transcript={transcript}
                    threadId={thread.id}
                    {...(run ? { run } : {})}
                    {...(modelName ? { modelName } : {})}
                    {...(elapsed != null ? { elapsedMs: elapsed } : {})}
                    collapseSignal={collapseSignal + railFold}
                  />
                </div>
              )
            })}
          </div>

          <div className="flex shrink-0 items-center gap-1.5 border-border border-t px-2.5 py-1.5 text-[10.5px] text-muted-foreground/70">
            When a run settles it parks up-thread, beside the turn that started it.
          </div>
        </>
      )}
    </aside>
  )
}

/** Stand-in for the rail wherever it doesn't render: a single line near the
 *  composer. `always` keeps it visible regardless of panel width — used when
 *  the window isn't maximized, where the rail is gated off entirely. */
export function AgentRailBar({
  transcript,
  always = false,
}: {
  transcript: TranscriptState
  always?: boolean
}) {
  const running = runningThreads(transcript)
  if (running.length === 0) return null
  return (
    <div
      data-agent-bar=""
      className={cn(
        "mx-4 mb-2 flex items-center gap-2 rounded-lg border border-primary/30 bg-primary/10 px-2.5 py-1.5 text-[11.5px] text-muted-foreground",
        !always && "@[700px]:hidden",
      )}
    >
      <span className="size-1.5 animate-pulse rounded-full bg-primary" />
      {running.length} agent{running.length === 1 ? "" : "s"} running ·{" "}
      <span className="min-w-0 truncate">{running.map((t) => seatName(t.title)).join(", ")}</span>
    </div>
  )
}
