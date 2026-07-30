// One delegated agent, in three dresses:
//   running — live tail of the last few output lines (transcript gutter)
//   parked  — condensed settled run, expandable (transcript gutter)
//   idle    — condensed seat row, expandable; kept for a seat-list surface,
//             nothing renders it since the live agents rail was removed
//
// All three expand to the SAME full detail the old inline thread panels showed:
// the delegate's messages and any nested sub-threads.
import { Bot, ChevronRight, CornerUpLeft, Sparkles } from "lucide-react"
import { useEffect, useState } from "react"
import { cn } from "~/lib/cn"
import { childThreads, itemsToMessages } from "~/lib/mapTranscript"
import type { RunRecord, TranscriptState } from "~/lib/transcript"
import { formatElapsed, isSeat, runAccent, runSummary, runTail, type TailTone } from "~/lib/runs"
import { MessageView } from "./Message"
import { isRunLit, runLinkProps, useRunLink } from "./RunLink"

const TONE: Record<TailTone, string> = {
  cmd: "text-foreground/80",
  ok: "text-success",
  fail: "text-destructive",
  text: "text-muted-foreground",
  dim: "text-muted-foreground/60",
}

/** Newest line sits at the bottom; the oldest fades out under the mask. */
function Tail({ lines }: { lines: { text: string; tone: TailTone }[] }) {
  return (
    <div
      className="flex h-[92px] flex-col justify-end overflow-hidden px-2.5 pb-2 font-mono text-[10.5px] leading-[1.62]"
      style={{
        WebkitMaskImage:
          "linear-gradient(to bottom, transparent 0%, rgba(0,0,0,0.28) 14%, #000 46%, #000 100%)",
        maskImage:
          "linear-gradient(to bottom, transparent 0%, rgba(0,0,0,0.28) 14%, #000 46%, #000 100%)",
      }}
    >
      {lines.length === 0 ? (
        <div className="truncate text-muted-foreground/60">waiting for output…</div>
      ) : (
        lines.map((line, i) => (
          <div key={i} className={cn("truncate whitespace-pre", TONE[line.tone])}>
            {line.text}
          </div>
        ))
      )}
    </div>
  )
}

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
  variant: "running" | "idle" | "parked"
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
  useEffect(() => {
    setOpen(false)
  }, [collapseSignal])

  const link = useRunLink()

  const node = transcript.threads[threadId]
  if (!node) return null

  const runId = run?.id
  const accent = runId ? runAccent(runId) : undefined
  const lit = isRunLit(runId, link)

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
      {...runLinkProps(runId, link)}
      style={accent ? { borderLeftColor: accent } : undefined}
      className={cn(
        "overflow-hidden rounded-xl border border-border bg-card/85 shadow-xs transition-colors",
        accent && "border-l-2",
        isRunning && "border-primary/30 bg-card/95",
        lit && "bg-accent/40 ring-1 ring-ring/40",
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
            isRunning ? "text-primary" : variant === "idle" ? "text-muted-foreground" : "text-success",
          )}
        >
          {isRunning && <span className="size-1.5 animate-pulse rounded-full bg-current" />}
          {isRunning ? "Running" : variant === "idle" ? "Idle" : "Done"}
        </span>
        <ChevronRight
          className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")}
        />
      </button>

      {isRunning ? (
        <>
          <Tail lines={runTail(items, from, 5)} />
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
          {variant === "idle" && runId && (
            <div className="flex gap-1.5 px-3 pb-3">
              <button
                type="button"
                onClick={() => link.jumpToRun(runId)}
                className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-border px-2 py-1 text-[11.5px] text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
              >
                <CornerUpLeft className="size-3" />
                Jump to last run
              </button>
            </div>
          )}
        </div>
      )}
    </article>
  )
}
