import {
  BarChart3,
  GitFork,
  History,
  Info,
  Loader2,
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
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
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
import {
  BOTTOM_SLACK,
  classifyScroll,
  isAtBottom,
  reAnchor,
  shouldPark,
} from "~/lib/followBottom"
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

/** Is the viewport parked at (or within slack of) the end of the transcript?
 *  The band itself and the rest of the follow rules live in ~/lib/followBottom,
 *  where they are unit-testable without a DOM. */
function atBottom(el: HTMLElement) {
  return isAtBottom(el)
}

/** How long a turn-end park may still be animating before we stop treating the
 *  viewport as its property. The animation can be cancelled (the reader takes
 *  over) or land a pixel off its target, so the guard is time-boxed too. */
const PARK_SETTLE_MS = 700

/** Land `el` on `top` in ONE frame, and report where it actually landed.
 *
 *  Not `behavior: "instant"`: that is a WebIDL enum, so an engine without the
 *  value THROWS on the call rather than ignoring it — and this runs inside the
 *  ResizeObserver callback that does the following, where a throw would kill
 *  the follow outright. An inline `scroll-behavior: auto` beats the viewport's
 *  `scroll-smooth` class (which would otherwise animate even a plain scrollTop
 *  assignment), so this is instant on every engine, with nothing to support. */
function jumpTo(el: HTMLElement, top: number) {
  const previous = el.style.scrollBehavior
  el.style.scrollBehavior = "auto"
  el.scrollTop = top
  el.style.scrollBehavior = previous
  return el.scrollTop
}

/** Animated scroll for the one move that should be seen happening (the turn-end
 *  park). Falls back to the class-driven animation if the options object is
 *  rejected; either way the caller gets the target it asked for. */
function glideTo(el: HTMLElement, top: number) {
  try {
    el.scrollTo({ top, behavior: "smooth" })
  } catch {
    el.scrollTop = top
  }
  return top
}


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
  catchingUp = false,
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
  /** Replay is still in flight: what is on screen is last-seen state, so say
   *  so rather than letting a stale "working…" pass for the live picture. */
  catchingUp?: boolean
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
  // Where our OWN last scroll landed. This is the only reliable way to tell our
  // scrolling from the reader's: content growing under a stationary viewport
  // moves scrollHeight but NEVER scrollTop, and scroll events are dispatched a
  // frame late — so an event we queued before a chunk landed arrives after it
  // and, measured naively, reads as "the reader is 200px off the bottom". That
  // misread is what used to latch the follow off for the rest of a turn while
  // the reader sat motionless at the end.
  const commandedTop = useRef<number | null>(null)
  // Target of the turn-end park while its animation is in flight: the viewport
  // belongs to that animation until it settles or the reader interrupts it.
  const parkTarget = useRef<number | null>(null)
  const parkTimer = useRef<number | null>(null)
  // The park put the reader where they are — they did not choose it. Any real
  // scroll gesture clears this, and it is what lets an auto-continued turn (goal
  // mode: no user message to re-anchor on) start following again.
  const parkedByUs = useRef(false)

  const endPark = useCallback(() => {
    parkTarget.current = null
    if (parkTimer.current != null) {
      window.clearTimeout(parkTimer.current)
      parkTimer.current = null
    }
  }, [])
  useEffect(() => endPark, [endPark])

  /** Follow the end of the transcript, remembering where we asked to land. */
  const followBottom = useCallback((el: HTMLElement) => {
    commandedTop.current = jumpTo(el, el.scrollHeight)
  }, [])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onScroll = () => {
      switch (
        classifyScroll({
          scrollTop: el.scrollTop,
          commandedTop: commandedTop.current,
          parkTarget: parkTarget.current,
        })
      ) {
        // The park's animation owns the viewport; its intermediate positions are
        // not the reader changing their mind.
        case "park-moving":
          return
        case "park-settled":
          endPark()
          return
        // Our own follow, reported back to us. Deliberately NOT re-measured: the
        // content may have grown since we asked, and "at the bottom" measured
        // against content that arrived afterwards is a lie.
        case "ours":
          return
        // A position nobody asked us for: wheel, trackpad, keys, thumb drag,
        // momentum. This is reader intent — the only thing allowed to turn the
        // follow off, and the thing that turns it back on by returning to the
        // end.
        case "reader":
          commandedTop.current = null
          parkedByUs.current = false
          stuckToBottom.current = atBottom(el)
          return
      }
    }
    el.addEventListener("scroll", onScroll, { passive: true })
    return () => el.removeEventListener("scroll", onScroll)
  }, [endPark])

  // A real gesture also cancels a park mid-animation. WebKit stops the animation
  // for the reader, so it never reports the target the scroll handler waits for;
  // without this the guard would only lift on its timeout.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onGesture = () => {
      if (parkTarget.current == null) return
      endPark()
      parkedByUs.current = false
      stuckToBottom.current = atBottom(el)
    }
    el.addEventListener("wheel", onGesture, { passive: true })
    el.addEventListener("touchmove", onGesture, { passive: true })
    // Keys go on the window: the scrollport is not focusable, so PageDown/arrows
    // are delivered to whatever IS focused and never reach it. Harmless as a
    // global — it does nothing at all unless a park is currently animating.
    window.addEventListener("keydown", onGesture, true)
    return () => {
      el.removeEventListener("wheel", onGesture)
      el.removeEventListener("touchmove", onGesture)
      window.removeEventListener("keydown", onGesture, true)
    }
  }, [endPark])

  // Follow the bottom whenever the CONTENT grows, not just when React rows
  // change: tool output, live delegate streams, expanding cards, images and
  // markdown all resize the transcript without producing a new message row,
  // and the render-effect below never fires for them. A ResizeObserver catches
  // every one of those. Instant, never smooth — smooth restarts per delta and
  // falls behind a fast stream.
  //
  // The SCROLLPORT is observed as well as the content column, because the panes
  // below the transcript (composer growing to 220px, todos, queue chips, the
  // background-tasks line, the connection banner, the terminal drawer) mount and
  // resize mid-turn. They shrink the viewport without touching content height
  // and without firing a scroll event, which silently pushes the end of the
  // transcript out of sight — nothing used to notice.
  useEffect(() => {
    const el = scrollRef.current
    const inner = innerRef.current
    if (!el || !inner) return
    const observer = new ResizeObserver(() => {
      if (parkTarget.current != null) return
      if (stuckToBottom.current) followBottom(el)
    })
    observer.observe(inner)
    observer.observe(el)
    return () => observer.disconnect()
  }, [followBottom])

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
  const prevMessageCount = useRef(messageCount)
  // Read at turn end (not a dep — the effect must fire on the transition only).
  const messagesRef = useRef(messages)
  messagesRef.current = messages

  // A fresh user turn always re-anchors to the bottom, even if the reader had
  // scrolled away to re-read the previous answer.
  //
  // Keyed on the NUMBER of user messages rather than on the last row's role:
  // the user echo and the assistant's streaming placeholder routinely land in
  // the SAME commit (mapTranscript emits an empty assistant block as soon as
  // the stream opens), which leaves the trailing role "assistant" and would
  // silently skip the re-anchor — the transcript then never follows the reply.
  // A count also survives an optimistic message's id being swapped for the
  // server's, and only ever re-arms on a genuine append, so scrolling up
  // mid-stream still stays put.
  const userMessageCount = useMemo(
    () => thread.messages.reduce((n, m) => (m.role === "user" ? n + 1 : n), 0),
    [thread.messages],
  )
  const prevUserMessageCount = useRef(userMessageCount)
  useEffect(() => {
    if (userMessageCount > prevUserMessageCount.current) {
      stuckToBottom.current = true
      parkedByUs.current = false
      endPark()
    }
    prevUserMessageCount.current = userMessageCount
  }, [userMessageCount, endPark])

  // Switching sessions starts at the end of the new thread, not wherever the
  // previous one had parked us.
  useEffect(() => {
    stuckToBottom.current = true
    parkedByUs.current = false
    commandedTop.current = null
    endPark()
  }, [thread.id, endPark])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const justEnded = wasRunning.current && !running
    const justStarted = !wasRunning.current && running
    wasRunning.current = running
    const appended = messageCount > prevMessageCount.current
    prevMessageCount.current = messageCount

    // Re-anchor without a user message. The count-based re-anchor above only
    // sees turns a person started; these two cases are what left a goal-mode or
    // auto-continued turn streaming below the fold forever:
    //  · a new turn starts while the reader is still exactly where the previous
    //    turn's park put them. That position was our choice, not theirs, so a
    //    fresh turn's output is allowed to pull them back to the live end.
    //  · a row appends while the reader is VISUALLY at the end. Sitting at the
    //    end IS reading the end, whatever the flag says, so this also heals any
    //    stale "off" the flag ever picks up.
    const anchored = reAnchor({
      stuck: stuckToBottom.current,
      parkedByUs: parkedByUs.current,
      parkInFlight: parkTarget.current != null,
      justStarted,
      appended,
      atBottom: atBottom(el),
    })
    stuckToBottom.current = anchored.stuck
    parkedByUs.current = anchored.parkedByUs

    if (!justEnded) {
      // Streaming (or replaying): follow the bottom unless the reader left it.
      // Instant, not smooth — the viewport's scroll-smooth would restart an
      // animation on every delta and never catch up with a fast stream.
      if (stuckToBottom.current && parkTarget.current == null) followBottom(el)
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
    const wasFollowing = stuckToBottom.current
    // A reader who scrolled into history mid-turn keeps the viewport they chose:
    // the park re-frames an answer they were WATCHING arrive (or one we parked
    // them in ourselves), it is not a licence to move them at every turn end.
    if (!shouldPark({ wasFollowing, parkedByUs: parkedByUs.current })) return
    stuckToBottom.current = false
    const frame = requestAnimationFrame(() => {
      const inner = innerRef.current
      const first =
        inner?.querySelector<HTMLElement>(`[data-msg-id="${CSS.escape(answerId)}"]`) ?? null
      if (!first) {
        // No row to park against (the answer is not rendered as its own row).
        // Returning here used to leave the follow OFF with the viewport never
        // moved — the transcript then ignored every later message until the
        // reader typed. Hand the follow back instead: nothing scrolled, so
        // whatever was true an instant ago is still true.
        stuckToBottom.current = wasFollowing || atBottom(el)
        if (stuckToBottom.current) followBottom(el)
        return
      }
      const top =
        first.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop
      const target = Math.max(0, top - ANSWER_TOP_GAP)
      // A short answer starts within slack of the end: the browser would clamp
      // this scroll to the bottom and fire NO scroll event, so the listener
      // above could never re-arm the follow — the transcript would stay frozen
      // for every later turn while the reader sees no room to scroll down.
      // Treat that as "still reading the bottom": same resting place, and an
      // instant jump so nothing races the ResizeObserver's own bottom-follow.
      if (target >= el.scrollHeight - el.clientHeight - BOTTOM_SLACK) {
        stuckToBottom.current = true
        followBottom(el)
        return
      }
      // A long answer genuinely parks away from the end. The follow stays off
      // until the reader returns to the bottom, the next turn starts, or they
      // send a message — but the position is remembered as OURS, so none of
      // those is mistaken for a deliberate scroll into history.
      parkedByUs.current = true
      // We no longer own the bottom: forget the position, or a reader scrolling
      // back to exactly it would be mistaken for our own follow and left unstuck.
      commandedTop.current = null
      parkTarget.current = glideTo(el, target)
      if (parkTimer.current != null) window.clearTimeout(parkTimer.current)
      parkTimer.current = window.setTimeout(() => {
        parkTimer.current = null
        parkTarget.current = null
      }, PARK_SETTLE_MS)
    })
    return () => cancelAnimationFrame(frame)
    // `messages` is a dep so this fires on every streamed delta, not just on
    // turn boundaries; the follow above is what tracks mid-message growth.
  }, [running, messageCount, streamingId, loading, messages, followBottom])

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
      {/* Sticky, because the reader is normally at the TAIL of a long
          transcript when they switch back to a session that ran in the
          background — a marker at the start of the thread would never be seen. */}
      {catchingUp && !empty && (
        <div className="pointer-events-none sticky top-0 z-10 flex justify-center">
          <span className="flex items-center gap-1.5 rounded-full border border-border bg-background/90 px-3 py-1 text-[11px] text-muted-foreground shadow-sm backdrop-blur">
            <Loader2 className="size-3 animate-spin text-primary" />
            Catching up…
          </span>
        </div>
      )}
      {!empty && (
        <Row>
          <div className="flex items-center gap-2 self-start rounded-full border border-border bg-muted/40 px-3 py-1 text-[11px] text-muted-foreground">
            <Sparkles className="size-3 text-primary" />
            {loading ? "Loading transcript…" : catchingUp ? "Catching up…" : "Start of thread"}
          </div>
        </Row>
      )}

      {(loading || catchingUp) && empty ? (
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
