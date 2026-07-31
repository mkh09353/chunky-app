import {
  Info,
  MoreHorizontal,
  PanelRightOpen,
  Share2,
  Sparkles,
  SquareTerminal,
} from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { Repo } from "~/lib/api"
import type { Project, Thread } from "~/lib/mock"
import { Button } from "./ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu"
import { RepoTabs, type CloneStatus } from "./RepoTabs"
import { ScrollArea } from "./ui/scroll-area"
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip"
import { MessageView } from "./Message"
import { AgentCard } from "./AgentCard"
import { LiveRunsProvider, type LiveRunsValue } from "./LiveRun"
import { RunLinkProvider } from "./RunLink"
import { cn } from "~/lib/cn"
import { DRAG_REGION, NO_DRAG_REGION } from "~/lib/dragRegion"
import { buildTranscriptRows, type TranscriptRow } from "~/lib/mapTranscript"
import { hasRuns, liveRunViews, runAnchors, runsById, type RunAnchor } from "~/lib/runs"
import { useRunClock } from "~/lib/useRunClock"
import { useFullSizeWindow } from "~/lib/windowSize"
import type { RunRecord, TranscriptState } from "~/lib/transcript"

/** Top chrome strip: repo tabs + actions. */
export function ChatTopBar({
  repos,
  activeRepoId,
  unreadRepoIds,
  onSelectRepo,
  onAddRepo,
  onRemoveRepo,
  reposBusy = false,
  reposDisabled = false,
  onCloneRepo,
  cloneStatus,
  onCancelClone,
  onViewCloneThread,
  defaultCloneParent,
  headerRight,
  onToggleBrowser,
  onToggleTerminal,
  terminalOpen = false,
  onRename, onFork, onRewind, onGoal, onShip, onStats,
}: {
  /** Optional; when omitted, repo tabs are hidden (demo / offline). */
  repos?: Repo[]
  activeRepoId?: string | null
  unreadRepoIds?: Set<string>
  onSelectRepo?: (id: string) => void
  onAddRepo?: (path: string) => Promise<void>
  onRemoveRepo?: (id: string) => void | Promise<void>
  reposBusy?: boolean
  reposDisabled?: boolean
  /** Clone a git URL via an agent session; omitted → that section is hidden. */
  onCloneRepo?: (url: string, parentDir: string) => Promise<void>
  cloneStatus?: CloneStatus | null
  onCancelClone?: () => void
  onViewCloneThread?: (sessionId: string) => void
  defaultCloneParent?: string
  headerRight?: React.ReactNode
  onToggleBrowser?: () => void
  /** Bottom terminal drawer toggle; omitted → the button is hidden. */
  onToggleTerminal?: () => void
  terminalOpen?: boolean
  onRename?: () => void; onFork?: () => void; onRewind?: () => void; onGoal?: () => void; onShip?: () => void; onStats?: () => void
}) {
  const showRepos =
    !!repos && !!onSelectRepo && !!onAddRepo && !!onRemoveRepo && repos.length >= 0

  return (
    <header
      className={cn(
        DRAG_REGION,
        "flex h-[52px] shrink-0 items-center gap-3 px-3 text-sidebar-foreground sm:px-4",
      )}
    >
      {showRepos ? (
        <RepoTabs
          repos={repos}
          activeId={activeRepoId ?? null}
          unreadRepoIds={unreadRepoIds}
          onSelect={onSelectRepo}
          onAdd={onAddRepo}
          onRemove={onRemoveRepo}
          busy={reposBusy}
          disabled={reposDisabled}
          onClone={onCloneRepo}
          cloneStatus={cloneStatus}
          onCancelClone={onCancelClone}
          onViewCloneThread={onViewCloneThread}
          defaultCloneParent={defaultCloneParent}
        />
      ) : null}

      {/* The window's guaranteed drag handle. Repo tabs and the action cluster
          both opt out of dragging, so this spacer is what stays grabbable at
          every window width — it grows into the free space and never shrinks
          below a usable strip, and it never hosts controls. */}
      <div aria-hidden className="h-full min-w-12 flex-1" />

      <div className={cn(NO_DRAG_REGION, "flex shrink-0 items-center gap-1.5")}>
        {headerRight}
        {onToggleTerminal && (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className={cn(NO_DRAG_REGION, terminalOpen && "bg-accent text-foreground")}
                  onClick={onToggleTerminal}
                  aria-label="Toggle terminal drawer"
                />
              }
            >
              <SquareTerminal />
            </TooltipTrigger>
            <TooltipPopup>Toggle terminal (Ctrl+`)</TooltipPopup>
          </Tooltip>
        )}
        <Tooltip>
          <TooltipTrigger render={<Button variant="ghost" size="icon-sm" />}>
            <Share2 />
          </TooltipTrigger>
          <TooltipPopup>Share thread</TooltipPopup>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger render={<Button variant="ghost" size="icon-sm" onClick={onToggleBrowser} aria-label="Toggle browser pane" />}>
            <PanelRightOpen />
          </TooltipTrigger>
          <TooltipPopup>Toggle browser</TooltipPopup>
        </Tooltip>
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" />}>
            <MoreHorizontal />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={onRename}>Rename session</DropdownMenuItem>
            <DropdownMenuItem onClick={onFork}>Fork session…</DropdownMenuItem>
            <DropdownMenuItem onClick={onRewind}>Rewind to turn…</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={onGoal}>Goal mode…</DropdownMenuItem>
            <DropdownMenuItem onClick={onShip}>Ship it…</DropdownMenuItem>
            <DropdownMenuItem onClick={onStats}>Usage & scoreboard</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  )
}

/** Within this many px of the end still counts as "reading the bottom", so the
 *  transcript keeps following the stream. Past it the reader is scrolled away
 *  and we leave the viewport alone. */
const BOTTOM_SLACK = 48

/** Breathing room above the answer when we park its first line at the top. */
const ANSWER_TOP_GAP = 12

/** Id of the answer that just landed: the trailing assistant message. A turn
 *  that ended without one (stopped, error before any reply) yields undefined —
 *  nothing to re-anchor to, so the viewport is left where it is. */
function lastAnswerId(rows: TranscriptRow[]): string | undefined {
  for (let i = rows.length - 1; i >= 0; i--) {
    const role = rows[i]!.message.role
    if (role === "assistant") return rows[i]!.message.id
    if (role === "user") return undefined
  }
  return undefined
}

/** Transcript body — left-pinned text column, with a right gutter that carries
 *  agent runs: live ones tail beside the pill that spawned them and simply
 *  settle in place when they finish.
 *
 *  Both columns live in ONE scrollport, so every card scrolls with the
 *  conversation it belongs to. */
export function ChatView({
  thread,
  streamingId,
  loading = false,
  transcript,
  modelName,
  foldAll = false,
  compacted = 0,
}: {
  thread: Thread
  project?: Project
  streamingId: string | null
  headerRight?: React.ReactNode
  loading?: boolean
  transcript?: TranscriptState
  modelName?: string
  foldAll?: boolean
  compacted?: number
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const innerRef = useRef<HTMLDivElement>(null)

  // Is the reader parked at the end of the thread? Only then do we follow the
  // stream; scrolling up mid-turn must stay put.
  const stuckToBottom = useRef(true)
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onScroll = () => {
      stuckToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_SLACK
    }
    el.addEventListener("scroll", onScroll, { passive: true })
    return () => el.removeEventListener("scroll", onScroll)
  }, [])

  // Run state → anchors (which pill owns which run) → rows split at those pills.
  const anchors = useMemo(
    () => (transcript ? runAnchors(transcript) : new Map<number, RunAnchor>()),
    [transcript],
  )
  const runIndex = useMemo(
    () => (transcript ? runsById(transcript) : new Map<string, RunRecord>()),
    [transcript],
  )
  const rows = useMemo(
    () => buildTranscriptRows(thread.messages, anchors),
    [thread.messages, anchors],
  )
  const elapsedOf = useRunClock(transcript?.runs)
  // Live delegate streams, keyed by run id, handed to the tool cards that
  // spawned them (Message → ToolCard → LiveRunSection). Settled runs are not in
  // here, which is what makes a finished card go back to its plain self.
  const liveViews = useMemo(() => liveRunViews(transcript), [transcript])
  const liveRuns = useMemo<LiveRunsValue>(
    () => ({ views: liveViews, elapsedOf: (runId) => elapsedOf(runIndex.get(runId)) }),
    [liveViews, elapsedOf, runIndex],
  )

  // A turn ends when the session goes running → idle: `session.status` from the
  // SSE reducer (transcript.status), or — in demo/offline mode, where there is
  // no transcript — when the streaming message settles.
  const running = transcript ? transcript.status === "running" || streamingId != null : streamingId != null
  // Bumped once per settled turn: folds every agent card back to its condensed
  // summary. Because it only moves at turn end, a card the reader opens
  // afterwards stays open until the NEXT turn finishes.
  const [turnEnd, setTurnEnd] = useState(0)
  const wasRunning = useRef(running)
  const messageCount = thread.messages.length
  const lastRole = thread.messages[messageCount - 1]?.role
  // Read at turn end (not a dep — the effect must fire on the transition only).
  const rowsRef = useRef(rows)
  rowsRef.current = rows

  // A fresh user turn always re-anchors to the bottom, even if the reader had
  // scrolled away to re-read the previous answer.
  useEffect(() => {
    if (lastRole === "user") stuckToBottom.current = true
  }, [messageCount, lastRole])

  // Switching sessions starts at the end of the new thread, not wherever the
  // previous one had parked us.
  useEffect(() => {
    stuckToBottom.current = true
  }, [thread.id])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const justEnded = wasRunning.current && !running
    wasRunning.current = running

    if (!justEnded) {
      // Streaming (or replaying): follow the bottom unless the reader left it.
      // Instant, not smooth — the viewport's scroll-smooth would restart an
      // animation on every delta and never catch up with a fast stream.
      if (stuckToBottom.current) el.scrollTo({ top: el.scrollHeight, behavior: "instant" })
      return
    }

    setTurnEnd((n) => n + 1)

    // The turn is done: park the START of the answer at the top of the
    // scrollport rather than leaving the reader at its tail. One frame later,
    // so the cards settling have finished moving the layout first.
    const answerId = lastAnswerId(rowsRef.current)
    if (!answerId) return
    const frame = requestAnimationFrame(() => {
      const inner = innerRef.current
      if (!inner) return
      const first = inner.querySelector<HTMLElement>(`[data-msg-id="${CSS.escape(answerId)}"]`)
      if (!first) return
      const top =
        first.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop
      // Clamped by the browser when the answer is short — its start is visible
      // either way, which is the point.
      el.scrollTo({ top: Math.max(0, top - ANSWER_TOP_GAP), behavior: "smooth" })
      stuckToBottom.current = false
    })
    return () => cancelAnimationFrame(frame)
    // `rows` is a dep so this fires on every streamed delta, not just on
    // turn boundaries; the follow above is what tracks mid-message growth.
  }, [running, messageCount, streamingId, loading, rows])

  // Distinct per (turn, fold-all) pair, so a turn ending and fold-all flipping
  // in the same commit can never cancel each other out.
  const collapseSignal = turnEnd * 2 + (foldAll ? 1 : 0)
  // The gutter only earns its space on a maximized/fullscreen window, AND only
  // once this session has actually delegated. Any smaller window gets the plain
  // full-width chat, with agent cards falling inline under their pill.
  const fullSizeWindow = useFullSizeWindow()
  const gutterOn = fullSizeWindow && hasRuns(transcript)

  /** Scroll a settled run's card into view (pill → its parked card). */
  const scrollToParked = useCallback((runId: string) => {
    const card = innerRef.current?.querySelector<HTMLElement>(
      `[data-run-parked="${CSS.escape(runId)}"]`,
    )
    if (!card) return false
    card.scrollIntoView({ block: "center", behavior: "smooth" })
    return true
  }, [])

  const body = (
    <div ref={innerRef} className="relative flex flex-col gap-4 pt-5 pr-7 pb-[26px] pl-[22px]">
      <Row gutterOn={gutterOn}>
        <div className="flex items-center gap-2 self-start rounded-full border border-border bg-muted/40 px-3 py-1 text-[11px] text-muted-foreground">
          <Sparkles className="size-3 text-primary" />
          {loading ? "Loading transcript…" : "Start of thread"}
        </div>
      </Row>

      {loading && thread.messages.length === 0 ? (
        <p className="py-12 text-[13px] text-muted-foreground">Replaying session history…</p>
      ) : thread.messages.length === 0 ? (
        <p className="py-12 text-[13px] text-muted-foreground">Send a message to begin.</p>
      ) : (
        rows.map((row) => {
          // Only SETTLED runs park in the gutter. A run still in flight streams
          // inside the tool card that spawned it (LiveRunSection), so it is not
          // duplicated out here.
          const cards = row.parkedRunIds
            .map((id) => runIndex.get(id))
            .filter((run): run is RunRecord => !!run)
          return (
            <Row key={row.id} msgId={row.message.id} gutterOn={gutterOn} gutter={
              cards.length > 0 && transcript ? (
                <div className="flex flex-col gap-2">
                  {cards.map((run) => (
                    <AgentCard
                      key={run.id}
                      variant="parked"
                      transcript={transcript}
                      threadId={run.threadId}
                      run={run}
                      {...(modelName ? { modelName } : {})}
                      {...(elapsedOf(run) != null ? { elapsedMs: elapsedOf(run)! } : {})}
                      collapseSignal={collapseSignal}
                    />
                  ))}
                </div>
              ) : null
            }>
              <MessageView
                message={row.message}
                streaming={row.message.id === streamingId}
                blocks={row.blocks}
                continuation={row.continuation}
                lastSegment={row.lastSegment}
              />
            </Row>
          )
        })
      )}

      {compacted > 0 && (
        <Row gutterOn={gutterOn}>
          <div className="flex items-center gap-2 self-start rounded-full border border-border bg-muted/40 px-3 py-1 text-[11px] text-muted-foreground">
            <Info className="size-3" />
            Context compacted — older turns summarized{compacted > 1 ? ` · ×${compacted}` : ""}
          </div>
        </Row>
      )}

    </div>
  )

  return (
    // @container: every breakpoint below keys off the CHAT PANEL's width, so the
    // sidebar's width (and its collapsing) can never skew them.
    <div className="@container flex min-h-0 min-w-0 flex-1 flex-col">
      <RunLinkProvider onJump={scrollToParked}>
        <LiveRunsProvider value={liveRuns}>
          <ScrollArea className="flex-1" viewportRef={scrollRef} viewportClassName="scroll-smooth">
            {body}
          </ScrollArea>
        </LiveRunsProvider>
      </RunLinkProvider>
    </div>
  )
}

/** One transcript row: text column pinned left, connector, then the gutter.
 *
 *  Breakpoints are CONTAINER queries, not viewport ones: the chat panel sits
 *  beside a ~288px sidebar, so a viewport breakpoint would dissolve the gutter
 *  at the wrong moment (and differently once the sidebar collapses).
 *  Below GUTTER_AT the row stacks and cards fall inline under their pill.
 *
 *  Note the row never wraps: the text column has a 58rem BASIS and grows into
 *  whatever the gutter leaves, so the gutter always stays beside it instead of
 *  dropping to the next line.
 *
 *  `gutterOn` is the session-level switch: with no runs anywhere (or in a
 *  smaller window) there is no gutter cell, so the conversation uses the full
 *  width and any cards fall inline under the pill that spawned them — they must
 *  never become invisible just because the gutter is off. */
function Row({
  children,
  gutter,
  gutterOn,
  msgId,
}: {
  children: React.ReactNode
  gutter?: React.ReactNode
  gutterOn: boolean
  /** The message this row belongs to; a split message tags every segment, so
   *  the FIRST match in the DOM is where that message starts. */
  msgId?: string
}) {
  if (!gutterOn) {
    return (
      <div data-chat-row="" data-msg-id={msgId}>
        <div data-chat-col="" className="min-w-0 max-w-[88rem]">
          {children}
          {gutter && <div className="mt-2 max-w-[42rem] ps-[46px]">{gutter}</div>}
        </div>
      </div>
    )
  }
  return (
    <div
      data-chat-row=""
      data-msg-id={msgId}
      className="flex flex-col gap-2 @[1074px]:flex-row @[1074px]:items-start @[1074px]:gap-x-6 @[1074px]:gap-y-0"
    >
      <div data-chat-col="" className="min-w-0 @[1074px]:max-w-[76rem] @[1074px]:flex-[1_1_58rem]">
        {children}
      </div>
      <div
        className={cn(
          "mt-[19px] hidden h-px min-w-0 flex-1 @[1074px]:block",
          gutter && "border-success/30 border-t border-dashed",
        )}
      />
      <div
        data-chat-gutter=""
        /* The cell keeps its width even when empty: every row's text column must
           be the same width whether or not that row owns a card. Only when
           stacked does an empty gutter collapse away. */
        className="ps-[46px] @max-[1073px]:empty:hidden @[1074px]:w-[380px] @[1074px]:shrink-0 @[1074px]:ps-0"
      >
        {gutter}
      </div>
    </div>
  )
}
