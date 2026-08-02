import {
  BarChart3,
  GitFork,
  History,
  Info,
  Moon,
  MoreHorizontal,
  PanelRightOpen,
  Pencil,
  Rocket,
  Sparkles,
  SquareTerminal,
  Sun,
  Target,
} from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"
import type { Repo } from "~/lib/api"
import type { Message, Project, Thread } from "~/lib/mock"
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
import { cn } from "~/lib/cn"
import { DRAG_REGION, NO_DRAG_REGION } from "~/lib/dragRegion"
import { applyRunAnchors } from "~/lib/mapTranscript"
import { liveRunViews, runAnchors, runsById, type RunAnchor } from "~/lib/runs"
import { useRunClock } from "~/lib/useRunClock"
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
  repoStatus,
  headerRight,
  onToggleBrowser,
  onToggleTerminal,
  terminalOpen = false,
  theme,
  onToggleTheme,
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
  /** Status that belongs to the active repo (the git branch), shown beside the
   *  tabs rather than in the action cluster. */
  repoStatus?: React.ReactNode
  headerRight?: React.ReactNode
  onToggleBrowser?: () => void
  /** Bottom terminal drawer toggle; omitted → the menu item is hidden. */
  onToggleTerminal?: () => void
  terminalOpen?: boolean
  /** Current resolved theme, so the menu row can name the OTHER one. */
  theme?: "light" | "dark"
  onToggleTheme?: () => void
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

      {/* Branch/status of the repo whose tab is selected — it reads as a label
          on the tabs, not as another control in the action cluster. Its own
          trigger opts out of dragging; the space around it stays grabbable. */}
      {repoStatus}

      {/* The window's guaranteed drag handle. Repo tabs and the action cluster
          both opt out of dragging, so this spacer is what stays grabbable at
          every window width — it grows into the free space and never shrinks
          below a usable strip, and it never hosts controls. */}
      <div aria-hidden className="h-full min-w-12 flex-1" />

      {/* At most a handful of targets live out here: the mic and the session
          badges that ride in `headerRight`, the side-pane toggle, and the
          overflow menu. Everything rarer (theme, terminal, share) is a row in
          that menu instead of another icon competing for the strip. */}
      <div className={cn(NO_DRAG_REGION, "flex shrink-0 items-center gap-1.5")}>
        {headerRight}
        <Tooltip>
          <TooltipTrigger render={<Button variant="ghost" size="icon-sm" onClick={onToggleBrowser} aria-label="Toggle browser pane" />}>
            <PanelRightOpen />
          </TooltipTrigger>
          <TooltipPopup>Toggle browser</TooltipPopup>
        </Tooltip>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={<Button variant="ghost" size="icon-sm" aria-label="More actions" />}
          >
            <MoreHorizontal />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={onRename}>
              <Pencil />
              Rename session
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onFork}>
              <GitFork />
              Fork session…
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onRewind}>
              <History />
              Rewind to turn…
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={onGoal}>
              <Target />
              Goal mode…
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onShip}>
              <Rocket />
              Ship it…
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onStats}>
              <BarChart3 />
              Usage & scoreboard
            </DropdownMenuItem>
            {(onToggleTerminal || onToggleTheme) && <DropdownMenuSeparator />}
            {onToggleTerminal && (
              <DropdownMenuItem onClick={onToggleTerminal}>
                <SquareTerminal />
                {terminalOpen ? "Hide terminal" : "Show terminal"}
                <span className="ml-auto ps-4 text-[11px] text-muted-foreground">Ctrl+`</span>
              </DropdownMenuItem>
            )}
            {onToggleTheme && (
              <DropdownMenuItem onClick={onToggleTheme}>
                {theme === "dark" ? <Sun /> : <Moon />}
                {theme === "dark" ? "Light mode" : "Dark mode"}
              </DropdownMenuItem>
            )}
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
function lastAnswerId(messages: Message[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const role = messages[i]!.role
    if (role === "assistant") return messages[i]!.id
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

  // Follow the bottom whenever the CONTENT grows, not just when React rows
  // change: tool output, live delegate streams, expanding cards, images and
  // markdown all resize the transcript without producing a new message row,
  // and the render-effect below never fires for them. A ResizeObserver on the
  // inner column catches every one of those. Instant, never smooth — smooth
  // restarts per delta and falls behind a fast stream.
  useEffect(() => {
    const el = scrollRef.current
    const inner = innerRef.current
    if (!el || !inner) return
    const observer = new ResizeObserver(() => {
      if (stuckToBottom.current) el.scrollTo({ top: el.scrollHeight, behavior: "instant" })
    })
    observer.observe(inner)
    return () => observer.disconnect()
  }, [])

  // Run state → anchors: which pill owns which run, live or settled.
  const anchors = useMemo(
    () => (transcript ? runAnchors(transcript) : new Map<number, RunAnchor>()),
    [transcript],
  )
  const runIndex = useMemo(
    () => (transcript ? runsById(transcript) : new Map<string, RunRecord>()),
    [transcript],
  )
  const messages = useMemo(
    () => applyRunAnchors(thread.messages, anchors),
    [thread.messages, anchors],
  )
  const elapsedOf = useRunClock(transcript?.runs)
  // Live delegate streams, keyed by run id, handed to the tool cards that
  // spawned them (Message → ToolCard → LiveRunSection). Settled runs are not in
  // here, which is what makes a finished card go back to its plain self.
  const liveViews = useMemo(() => liveRunViews(transcript), [transcript])

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
  const messagesRef = useRef(messages)
  messagesRef.current = messages

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
    const answerId = lastAnswerId(messagesRef.current)
    if (!answerId) return
    // Stop the ResizeObserver's bottom-follow immediately. Otherwise a resize
    // notification between this effect and the animation frame can jump to the
    // tail just before we park at the answer's start.
    stuckToBottom.current = false
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
    })
    return () => cancelAnimationFrame(frame)
    // `messages` is a dep so this fires on every streamed delta, not just on
    // turn boundaries; the follow above is what tracks mid-message growth.
  }, [running, messageCount, streamingId, loading, messages])

  // Distinct per (turn, fold-all) pair, so a turn ending and fold-all flipping
  // in the same commit can never cancel each other out.
  const collapseSignal = turnEnd * 2 + (foldAll ? 1 : 0)

  // Everything a delegate pill needs, in one context: the live tails, the run
  // records that name them, and a renderer for a settled run's whole
  // transcript. The pill is the only place a delegated run appears now, so the
  // detail it can open must be the full AgentCard — handed in as a render prop
  // because AgentCard renders MessageView, and a message importing it back
  // would close an import cycle.
  const liveRuns = useMemo<LiveRunsValue>(
    () => ({
      views: liveViews,
      elapsedOf: (runId) => elapsedOf(runIndex.get(runId)),
      runs: runIndex,
      ...(transcript
        ? {
            renderRunDetail: (runId: string) => {
              const run = runIndex.get(runId)
              if (!run) return null
              const elapsed = elapsedOf(run)
              return (
                <AgentCard
                  variant="parked"
                  transcript={transcript}
                  threadId={run.threadId}
                  run={run}
                  {...(modelName ? { modelName } : {})}
                  {...(elapsed != null ? { elapsedMs: elapsed } : {})}
                  collapseSignal={collapseSignal}
                />
              )
            },
          }
        : {}),
    }),
    [liveViews, elapsedOf, runIndex, transcript, modelName, collapseSignal],
  )
  // The answer that just landed keeps its actions on show; every other message
  // reveals them on hover/focus. Nothing is mounted or unmounted either way, so
  // the transcript's height is identical in both states.
  const pinnedActionsId = lastAnswerId(messages)

  // A thread with nothing in it yet gets ONE quiet line and the composer — no
  // start-of-thread marker to mark the start of nothing, and no synthetic
  // starter content (a new session must attach and be typeable immediately).
  const empty = thread.messages.length === 0

  const body = (
    <div ref={innerRef} className="relative flex flex-col gap-4 pt-5 pr-7 pb-[26px] pl-[22px]">
      {!empty && (
        <Row>
          <div className="flex items-center gap-2 self-start rounded-full border border-border bg-muted/40 px-3 py-1 text-[11px] text-muted-foreground">
            <Sparkles className="size-3 text-primary" />
            {loading ? "Loading transcript…" : "Start of thread"}
          </div>
        </Row>
      )}

      {loading && empty ? (
        <p className="py-12 text-center text-[13px] text-muted-foreground/70">
          Replaying session history…
        </p>
      ) : empty ? (
        <p className="py-12 text-center text-[13px] text-muted-foreground/70">
          What are we working on?
        </p>
      ) : (
        messages.map((message) => (
          <Row key={message.id} msgId={message.id}>
            <MessageView
              message={message}
              streaming={message.id === streamingId}
              actionsPinned={message.id === pinnedActionsId}
            />
          </Row>
        ))
      )}

      {compacted > 0 && (
        <Row>
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
      <LiveRunsProvider value={liveRuns}>
        <ScrollArea className="flex-1" viewportRef={scrollRef} viewportClassName="scroll-smooth">
          {body}
        </ScrollArea>
      </LiveRunsProvider>
    </div>
  )
}

/** One transcript row: a single bounded text column.
 *
 *  There used to be a right-hand gutter here that parked settled delegate runs
 *  beside the pill that spawned them. It cost every row a reserved cell (and a
 *  maximized-window gate to earn it) to show what the pill itself can hold, so
 *  the runs moved inside the pill and the column reclaimed the width. The cap
 *  stays: prose is unreadable full-bleed. */
function Row({
  children,
  msgId,
}: {
  children: React.ReactNode
  /** The message this row belongs to — the turn-end scroll anchors on it. */
  msgId?: string
}) {
  return (
    <div data-chat-row="" data-msg-id={msgId}>
      <div data-chat-col="" className="min-w-0 max-w-[88rem]">
        {children}
      </div>
    </div>
  )
}
