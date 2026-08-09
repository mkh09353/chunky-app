// The Inbox: the heart of The Zoo.
//
// One queue of decisions, newest pressure first. Every card carries its own
// evidence and the same three gestures — go, not now, and a note — so the user
// can clear the queue without leaving the column. Selecting a card fills the
// detail pane; the verdicts themselves go through lib/zooDecisions.ts, which
// maps them onto the existing item-flow helpers.

import { CheckCircle2, FlaskConical, Inbox, LoaderCircle, MessageSquare, MessageSquareMore, Sparkles } from "lucide-react"
import { useState } from "react"
import { cn } from "~/lib/cn"
import { NO_DRAG_REGION } from "~/lib/dragRegion"
import { relativeTime } from "~/lib/format"
import { decide, goBlockedReason, noteTarget, type DecisionContext } from "~/lib/zooDecisions"
import type { InboxEntry } from "~/lib/zooInbox"
import { latestSessionId } from "~/lib/zooItemFlow"
import type { ZooArea, ZooItem } from "~/lib/zoo"
import { areaName } from "~/lib/zooAreas"
import { AreaBadge } from "./AreaSwitcher"
import { Button } from "../ui/button"
import { Textarea } from "../ui/textarea"
import {
  Badge,
  EmptyState,
  EvidenceQuote,
  IDEA_TYPE_LABEL,
  IDEA_TYPE_TONE,
  Notice,
  STAGE_LABEL,
  STAGE_TONE,
  ViewHeader,
} from "./parts"

/** Evidence shown on the card itself — the rest waits in the detail pane. */
const INLINE_INSIGHTS = 2
const INLINE_QUOTES = 1

/** A Jam action is not a verdict and must not bubble into card selection. */
export function invokeInboxJam(event: { preventDefault(): void; stopPropagation(): void }, entry: InboxEntry, onStartJam: (entry: InboxEntry) => void): void {
  event.preventDefault()
  event.stopPropagation()
  onStartJam(entry)
}

export function InboxView({
  entries,
  inFlight,
  selectedId,
  onSelect,
  context,
  areas,
  showAreas,
  onRefresh,
  onSetAside,
  onSynthesize,
  synthesizing = false,
  onOpenSession,
  loading,
  onStartJam,
  onStartResearch,
  actionBusyId,
}: {
  entries: InboxEntry[]
  inFlight: ZooItem[]
  selectedId: string | null
  onSelect: (id: string) => void
  context: DecisionContext
  areas: ZooArea[]
  /** Badge each card with its area — only useful under "All areas". */
  showAreas: boolean
  onRefresh: () => Promise<void>
  /** "Not now" on a signals card is a local set-aside — there is nothing to write. */
  onSetAside: (entryId: string) => void
  onSynthesize?: () => void
  synthesizing?: boolean
  onOpenSession?: (sessionId: string) => void
  loading: boolean
  onStartJam?: (entry: InboxEntry) => void
  onStartResearch?: (entry: InboxEntry) => void
  actionBusyId?: string | null
}) {
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notes, setNotes] = useState<Record<string, string>>({})
  const [noteOpen, setNoteOpen] = useState<Record<string, boolean>>({})

  const run = async (entry: InboxEntry, action: "go" | "not-now" | "note") => {
    if (busyId) return
    setBusyId(entry.id)
    setError(null)
    const note = notes[entry.id] ?? ""
    const result = await decide(entry, action, note, context)
    setBusyId(null)
    if (!result.ok) {
      setError(result.error)
    } else {
      setNotes((prev) => ({ ...prev, [entry.id]: "" }))
      setNoteOpen((prev) => ({ ...prev, [entry.id]: false }))
    }
    await onRefresh()
  }

  const card = (entry: InboxEntry) => {
    const selected = selectedId === entry.id
    const busy = busyId === entry.id
    const signals = entry.kind === "insights"
    const blocked = signals ? null : goBlockedReason(entry, context)
    const target = noteTarget(entry)
    const sessionId = entry.item ? latestSessionId(entry.item) : null
    const entryArea = areaName(areas, entry.areaId)
    const noteValue = notes[entry.id] ?? ""
    const showNote = noteOpen[entry.id] === true

    return (
      <li key={entry.id} className="min-w-0">
        <article
          className={cn(
            "flex min-w-0 flex-col rounded-2xl border bg-card/60 shadow-xs transition-[border-color,box-shadow]",
            selected ? "border-primary/50 ring-1 ring-primary/20" : "border-border/70",
          )}
        >
          <Button
            variant="ghost"
            onClick={() => onSelect(entry.id)}
            aria-pressed={selected}
            className={`${NO_DRAG_REGION} h-auto w-full min-w-0 flex-col items-start gap-1.5 whitespace-normal rounded-t-2xl border-0 px-4 pt-3.5 pb-2 text-left shadow-none`}
          >
            <span className="flex min-w-0 flex-wrap items-center gap-1.5">
              {entry.item && (
                <Badge className={STAGE_TONE[entry.item.stage]}>{STAGE_LABEL[entry.item.stage]}</Badge>
              )}
              {entry.kind === "idea" && entry.idea && (
                <Badge className={IDEA_TYPE_TONE[entry.idea.type]}>{IDEA_TYPE_LABEL[entry.idea.type]}</Badge>
              )}
              {signals && <Badge className="border-primary/30 bg-primary/10 text-primary">Signals</Badge>}
              {showAreas && entryArea && <AreaBadge name={entryArea} />}
              {(entry.sourceLabels ?? []).map((label) => (
                <Badge key={label} className="border-border/70 bg-muted/40 font-mono text-muted-foreground">
                  {label}
                </Badge>
              ))}
              <span className="text-[11px] text-muted-foreground/80">{relativeTime(entry.at)}</span>
            </span>
            <span className="min-w-0 whitespace-pre-wrap break-words font-medium text-[14.5px] text-foreground leading-snug">
              {entry.title}
            </span>
            <span className="min-w-0 whitespace-pre-wrap break-words text-[12.5px] text-muted-foreground leading-relaxed">
              {entry.why}
            </span>
          </Button>

          {entry.insights.length > 0 && (
            <div className="flex min-w-0 flex-col gap-2 px-4 pb-2">
              {entry.insights.slice(0, INLINE_INSIGHTS).map((insight) => (
                <div key={insight.id} className="min-w-0 border-border/60 border-l-2 pl-2.5">
                  <p className="min-w-0 break-words font-medium text-[12px] text-foreground">
                    {insight.title}
                  </p>
                  {insight.evidence.slice(0, INLINE_QUOTES).map((cite, index) => (
                    <EvidenceQuote key={`${cite.artifactId}-${index}`} cite={cite} />
                  ))}
                </div>
              ))}
              {entry.insights.length > INLINE_INSIGHTS && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => onSelect(entry.id)}
                  className={`${NO_DRAG_REGION} h-auto self-start px-0 text-[11.5px] text-muted-foreground hover:text-foreground`}
                >
                  +{entry.insights.length - INLINE_INSIGHTS} more insight
                  {entry.insights.length - INLINE_INSIGHTS === 1 ? "" : "s"} in the detail pane
                </Button>
              )}
            </div>
          )}

          <div className="flex min-w-0 flex-wrap items-center gap-1.5 border-border/60 border-t px-4 py-2.5">
            {signals ? (
              <>
                <Button
                  className={NO_DRAG_REGION}
                  size="sm"
                  disabled={synthesizing || !onSynthesize}
                  title={onSynthesize ? undefined : "Runs need a connected Chunky server"}
                  onClick={() => onSynthesize?.()}
                >
                  {synthesizing ? <LoaderCircle className="animate-spin" /> : <Sparkles />}
                  Synthesize ideas
                </Button>
                {entry.idea && (
                  <Button className={NO_DRAG_REGION} size="sm" variant="outline" disabled={busyId !== null || actionBusyId === entry.id || !onStartJam} onClick={(event) => onStartJam && invokeInboxJam(event, entry, onStartJam)}>
                    {actionBusyId === entry.id ? <LoaderCircle className="animate-spin" /> : <MessageSquareMore />} Jam
                  </Button>
                )}
                <Button className={NO_DRAG_REGION} size="sm" variant="outline" onClick={() => onSetAside(entry.id)}>
                  Not now
                </Button>
              </>
            ) : (
              <>
                <Button
                  className={NO_DRAG_REGION}
                  size="sm"
                  disabled={busyId !== null || !!blocked}
                  title={blocked ?? undefined}
                  onClick={() => void run(entry, "go")}
                >
                  {busy ? <LoaderCircle className="animate-spin" /> : <CheckCircle2 />}
                  {entry.kind === "idea" ? "Go — promote it" : "Go — approve"}
                </Button>
                <Button
                  className={NO_DRAG_REGION}
                  size="sm"
                  variant="outline"
                  disabled={busyId !== null}
                  onClick={() => void run(entry, "not-now")}
                >
                  Not now
                </Button>
                <Button
                  className={NO_DRAG_REGION}
                  size="sm"
                  variant="ghost"
                  disabled={busyId !== null}
                  onClick={() => setNoteOpen((prev) => ({ ...prev, [entry.id]: prev[entry.id] !== true }))}
                >
                  <MessageSquare />
                  {showNote ? "Hide note" : "Add a note"}
                </Button>
                {sessionId && onOpenSession && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className={`${NO_DRAG_REGION} ml-auto`}
                    onClick={() => onOpenSession(sessionId)}
                  >
                    Open session
                  </Button>
                )}
                <Button
                  className={NO_DRAG_REGION}
                  size="sm"
                  variant="outline"
                  disabled={busyId !== null || actionBusyId === entry.id || !onStartJam}
                  onClick={(event) => onStartJam && invokeInboxJam(event, entry, onStartJam)}
                >
                  {actionBusyId === entry.id ? <LoaderCircle className="animate-spin" /> : <MessageSquareMore />} Jam
                </Button>
              </>
            )}
            {blocked && <span className="text-[11.5px] text-muted-foreground">{blocked}</span>}
          </div>

          {!signals && showNote && (
            <div className="flex min-w-0 flex-col gap-1.5 border-border/60 border-t px-4 py-2.5">
              <Textarea
                value={noteValue}
                onChange={(event) =>
                  setNotes((prev) => ({ ...prev, [entry.id]: event.target.value }))
                }
                placeholder={
                  target === "go-only"
                    ? "Anything the research session should know — sent when you hit Go."
                    : "What should change? This goes to the session and onto the decision log."
                }
                className={`${NO_DRAG_REGION} min-h-16 rounded-lg border border-input p-2 text-[12.5px] focus:border-ring`}
              />
              <div className="flex flex-wrap gap-1.5">
                {target === "session" && (
                  <Button
                    className={NO_DRAG_REGION}
                    size="sm"
                    disabled={busyId !== null || !noteValue.trim()}
                    onClick={() => void run(entry, "note")}
                  >
                    {busy ? <LoaderCircle className="animate-spin" /> : null}
                    Send note
                  </Button>
                )}
                <p className="min-w-0 self-center break-words text-[11.5px] text-muted-foreground">
                  {target === "session"
                    ? "Send it on its own, or leave it here and it rides along with your verdict."
                    : target === "log"
                      ? "This item has no session yet — the note is recorded on its decision log."
                      : "The note is handed to the research session Go creates."}
                </p>
              </div>
            </div>
          )}
        </article>
      </li>
    )
  }

  const waiting = entries.length

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <ViewHeader
        title="Inbox"
        subtitle={
          loading
            ? "Reading the board…"
            : waiting === 0
              ? "Nothing is waiting on you."
              : `${waiting} decision${waiting === 1 ? "" : "s"} waiting on you`
        }
      />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3 overflow-y-auto px-6 pb-8">
        {error && <Notice text={error} />}
        {waiting === 0 && !loading ? (
          <EmptyState
            icon={<Inbox className="size-5" />}
            title="The queue is clear"
            body="Nothing is waiting on a decision. New signals show up here as soon as a run records them."
          />
        ) : (
          <ul className="flex min-w-0 flex-col gap-3">{entries.map(card)}</ul>
        )}

        {inFlight.length > 0 && (
          <section className="mt-2 flex min-w-0 flex-col gap-2">
            <h3 className="font-medium text-[11px] text-muted-foreground uppercase tracking-wide">
              In flight · {inFlight.length}
            </h3>
            <ul className="flex min-w-0 flex-col gap-1.5">
              {inFlight.map((item) => {
                const sessionId = latestSessionId(item)
                const fullEntry: InboxEntry = { id: `item:${item.id}`, kind: "item", title: item.title, why: "Research item without a session.", at: item.updatedAt, urgency: 0, item, ...(item.areaId ? { areaId: item.areaId } : {}), insights: [] }
                return (
                  <li
                    key={item.id}
                    className="flex min-w-0 items-center gap-2 rounded-xl border border-border/60 bg-muted/20 px-3 py-2"
                  >
                    <span className="min-w-0 flex-1 truncate text-[12.5px] text-foreground">
                      {item.title}
                    </span>
                    <Badge className={STAGE_TONE[item.stage]}>{STAGE_LABEL[item.stage]}</Badge>
                    <span className="shrink-0 text-[11px] text-muted-foreground">
                      {relativeTime(item.updatedAt)}
                    </span>
                    {sessionId && onOpenSession && (
                      <Button className={NO_DRAG_REGION} size="sm" variant="ghost" onClick={() => onOpenSession(sessionId)}>
                        Open
                      </Button>
                    )}
                    {!sessionId && item.stage === "research" && (
                      <Button className={NO_DRAG_REGION} size="sm" variant="outline" disabled={!onStartResearch || actionBusyId === `item:${item.id}`} onClick={() => onStartResearch?.(fullEntry)}>
                        {actionBusyId === `item:${item.id}` ? <LoaderCircle className="animate-spin" /> : <FlaskConical />} Start research
                      </Button>
                    )}
                  </li>
                )
              })}
            </ul>
          </section>
        )}
      </div>
    </div>
  )
}
