// One delegated agent, in two dresses:
//   running — live tail of the last few output lines. Only a NESTED child
//             thread renders as this (while its parent's card is expanded); a
//             top-level run in flight streams inside the TOOL CARD that spawned
//             it (components/LiveRun).
//   parked  — a settled run: its summary, expandable to the whole thing.
//
// This is the DETAIL renderer for a delegate pill: ChatView hands it to the
// pill through the runs context (renderRunDetail), and the pill shows it in its
// expanded body. Both dresses expand to the same full detail the old inline
// thread panels showed: the delegate's messages and any nested sub-threads.
import { Bot, ChevronRight, Sparkles } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { cn } from "~/lib/cn"
import { childThreads, itemsToMessages } from "~/lib/mapTranscript"
import type { RunRecord, TranscriptState } from "~/lib/transcript"
import { formatElapsed, isRunCardLive, isSeat, runAccent, runSummary, runTail } from "~/lib/runs"
import { TailLines } from "./LiveRun"
import { MessageView } from "./Message"

/** The delegate's own transcript — what the old inline panel rendered. */
function ThreadDetail({
  transcript,
  threadId,
  from,
  to,
  modelName,
}: {
  transcript: TranscriptState
  threadId: string
  from?: number
  to?: number
  modelName?: string
}) {
  const node = transcript.threads[threadId]
  if (!node) return null
  const items = from == null && to == null ? node.items : node.items.slice(from ?? 0, to)
  const messages = itemsToMessages(items, node.model ?? modelName)
  const children = childThreads(transcript, threadId)
  return (
    <div className="flex flex-col gap-4 px-3 py-3">
      {messages.length ? (
        messages.map((message) => <MessageView key={message.id} message={message} />)
      ) : (
        <span className="text-[12px] text-muted-foreground">Waiting for work…</span>
      )}
      {children.map((child) => (
        <AgentCard
          key={child.id}
          variant={child.status === "running" ? "running" : "parked"}
          transcript={transcript}
          threadId={child.id}
          modelName={modelName}
        />
      ))}
    </div>
  )
}

export interface AgentCardProps {
  variant: "running" | "parked"
  transcript: TranscriptState
  threadId: string
  /** The specific run this card represents (parked/running); omitted for a seat. */
  run?: RunRecord
  modelName?: string
  /** Live elapsed for a running run / final duration for a settled one. */
  elapsedMs?: number
  /** Any change to this number collapses the card (fold-all / end of turn). */
  collapseSignal?: number
}

export function AgentCard({
  variant,
  transcript,
  threadId,
  run,
  modelName,
  elapsedMs,
  collapseSignal = 0,
}: AgentCardProps) {
  const [open, setOpen] = useState(false)
  // Read at signal time, not a dependency: liveness changing must not fold a
  // card on its own, and the effect must see the CURRENT status when the signal
  // does fire.
  const stillWorking = useRef(false)
  stillWorking.current = isRunCardLive(transcript, threadId, run)
  useEffect(() => {
    // A detached delegate outlives the lead's turn (lib/transcript keeps its run
    // open past `session.status: idle`), so the end-of-turn fold — and fold-all
    // — leave a still-running card expanded: that is exactly the card the reader
    // is watching. It folds with everything else on the next signal after it
    // settles.
    if (stillWorking.current) return
    setOpen(false)
  }, [collapseSignal])

  const node = transcript.threads[threadId]
  if (!node) return null

  const runId = run?.id
  const accent = runId ? runAccent(runId) : undefined

  const items = node.items
  const from = run?.itemStart ?? 0
  const to = run?.itemEnd
  const model = node.model ?? modelName
  const toolCount = run?.toolCount ?? 0
  const isRunning = variant === "running"

  const cardAttrs =
    runId != null
      ? { [isRunning ? "data-run-live" : "data-run-parked"]: runId }
      : {}

  return (
    <article
      {...cardAttrs}
      style={accent ? { borderLeftColor: accent } : undefined}
      className={cn(
        "overflow-hidden rounded-xl border border-border bg-card/85 shadow-xs transition-colors",
        accent && "border-l-2",
        isRunning && "border-primary/30 bg-card/95",
      )}
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full cursor-pointer items-center gap-2 px-2.5 py-2 text-left outline-none transition-colors hover:bg-accent/30 focus-visible:ring-2 focus-visible:ring-ring/40"
      >
        <span
          className={cn(
            "flex size-[22px] shrink-0 items-center justify-center rounded-md border border-border bg-foreground/[0.04] text-muted-foreground",
            isRunning && "border-primary/40 bg-primary/15 text-primary",
          )}
        >
          {isSeat(node) ? <Bot className="size-3" /> : <Sparkles className="size-3" />}
        </span>
        <span className="min-w-0 flex-1 truncate font-semibold text-[12.5px]">{node.title}</span>
        {model && (
          <span className="max-w-28 shrink-0 truncate rounded-full border border-border bg-muted/60 px-1.5 py-px font-mono text-[10px] text-muted-foreground">
            {model}
          </span>
        )}
        <span
          className={cn(
            "flex shrink-0 items-center gap-1.5 text-[10.5px]",
            isRunning ? "text-primary" : "text-success",
          )}
        >
          {isRunning && <span className="size-1.5 animate-pulse rounded-full bg-current" />}
          {isRunning ? "Running" : "Done"}
        </span>
        <ChevronRight
          className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")}
        />
      </button>

      {isRunning ? (
        <>
          <TailLines lines={runTail(items, from, 5)} rows={5} className="px-2.5 pb-2" />
          <div className="flex items-center gap-1.5 border-border/70 border-t px-2.5 py-1 font-mono text-[10px] text-muted-foreground/70">
            {elapsedMs != null && <span>{formatElapsed(elapsedMs)}</span>}
            {elapsedMs != null && <span>·</span>}
            <span>
              {toolCount} tool{toolCount === 1 ? "" : "s"}
            </span>
          </div>
        </>
      ) : (
        <p className={cn("px-2.5 pb-2 pl-[38px] text-[11px] text-muted-foreground", !open && "truncate")}>
          {runSummary(items, from, to)}
        </p>
      )}

      {open && (
        <div className="border-border border-t bg-foreground/[0.02]">
          {(elapsedMs != null || toolCount > 0) && !isRunning && (
            <div className="flex items-center gap-1.5 px-3 pt-2 font-mono text-[10px] text-muted-foreground/70">
              {elapsedMs != null && <span>{formatElapsed(elapsedMs)}</span>}
              {elapsedMs != null && toolCount > 0 && <span>·</span>}
              {toolCount > 0 && (
                <span>
                  {toolCount} tool{toolCount === 1 ? "" : "s"}
                </span>
              )}
            </div>
          )}
          <ThreadDetail
            transcript={transcript}
            threadId={threadId}
            from={from}
            to={to}
            modelName={modelName}
          />
        </div>
      )}
    </article>
  )
}
