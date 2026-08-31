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
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import type { StopDelegateRequest } from "@chunky/protocol"
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
  ANSWER_TOP_GAP,
  classifyScroll,
  decideScroll,
  isAtBottom,
  reAnchor,
  resolveParkPosition,
  type ParkReason,
} from "~/lib/followBottom"
import { anchorScrollTop, isPrepend, olderTrigger } from "~/lib/olderHistory"
import { DRAG_REGION, NO_DRAG_REGION } from "~/lib/dragRegion"
import { applyRunAnchors } from "~/lib/mapTranscript"
import { liveRunViews, runAnchors, runsById, type RunAnchor } from "~/lib/runs"
import { useRunClock } from "~/lib/useRunClock"
import {
  mergeDelegateStatus,
  mergeIsEmpty,
  mergedAnchors,
  mergedRunRecords,
  mergedViews,
} from "~/lib/delegateStatus"
import { useDelegateStatus } from "~/hooks/useDelegateStatus"
import type { RunRecord, TranscriptState } from "~/lib/transcript"

/** Top chrome strip: repo tabs + actions. */
export function ChatTopBar({
  repos,
  activeRepoId,
  unreadRepoIds,
  workingRepoIds,
  onSelectRepo,
  onSelectNoRepo,
  onAddRepo,
  onRemoveRepo,
  onOpenRepoFiles,
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
  /** Repositories with a session still working (root run or any delegate). */
  workingRepoIds?: Set<string>
  onSelectRepo?: (id: string) => void
  onSelectNoRepo?: () => void
  onAddRepo?: (path: string) => Promise<void>
  onRemoveRepo?: (id: string) => void | Promise<void>
  onOpenRepoFiles?: (repoId: string) => void
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
          workingRepoIds={workingRepoIds}
          onSelect={onSelectRepo}
          onSelectNoRepo={onSelectNoRepo}
          onAdd={onAddRepo}
          onRemove={onRemoveRepo}
          onOpenRepoFiles={onOpenRepoFiles}
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
          every window width — it splits the free space with the tab row (which
          stops growing once the tabs hit their ceiling, handing the rest back
          here) and never shrinks below a usable strip, nor hosts controls. */}
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
            {onFork && (
              <DropdownMenuItem onClick={onFork}>
                <GitFork />
                Fork session…
              </DropdownMenuItem>
            )}
            {onRewind && (
              <DropdownMenuItem onClick={onRewind}>
                <History />
                Rewind to turn…
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={onGoal}>
              <Target />
              Goal mode…
            </DropdownMenuItem>
            {onShip && (
              <DropdownMenuItem onClick={onShip}>
                <Rocket />
                Ship it…
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onClick={onStats}>
              <BarChart3 />
              Usage
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
  olderHistory,
  onLoadOlder,
  onStopRun,
  delegateStatus,
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
  /** Older turns the seed did not include. Omitted (demo/offline) → no
   *  affordance at all, exactly as before this existed. */
  olderHistory?: { hasMore: boolean; loading: boolean }
  /** Fetch one more page of history. Idempotent while a page is in flight. */
  onLoadOlder?: () => void | Promise<void>
  /** Cancel one live delegate (server stop_delegate). Omitted in demo/offline
   *  mode, and dropped for the rest of the session once a server has said it
   *  has no such endpoint — which hides the Stop control entirely. */
  onStopRun?: (runId: string, target: StopDelegateRequest) => void | Promise<void>
  /** Where to ask for live delegate status, when there is a live session and
   *  the server still claims the endpoint. Omitted in demo/offline mode and
   *  dropped for good once a server 404s it — at which point every pill renders
   *  exactly as it did before this existed. */
  delegateStatus?: {
    baseUrl: string
    sessionId: string
    /** Stable identity, please: it is a polling effect dependency. */
    onUnsupported: (baseUrl: string) => void
  }
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
  // rAF handle for a start-of-answer park. Kept outside the render-effect so a
  // messages churn cleanup cannot drop the intent without decideScroll seeing
  // the still-pending reason and re-scheduling.
  const parkFrame = useRef<number | null>(null)
  // Set while a park has been decided but not yet applied to the DOM. Survives
  // cancelled animation frames; cleared only on successful apply or reader cancel.
  const pendingParkReason = useRef<ParkReason | null>(null)
  // First settled frame after a thread switch still needs open framing.
  const openPending = useRef(true)

  // ---- Older history -------------------------------------------------------
  // A session is seeded with only its last turns, so the top of the scrollport
  // is a boundary, not the start of the conversation. The rules live in
  // ~/lib/olderHistory; these refs are the DOM half.
  const hasOlder = olderHistory?.hasMore ?? false
  const loadingOlder = olderHistory?.loading ?? false
  /** Armed by scrolling AWAY from the top, spent by one fetch: that is what
   *  makes a short prepended page unable to fire the next one immediately. */
  const olderArmed = useRef(false)
  /** Scrollport metrics captured when a page was asked for, restored once it
   *  lands. Null when the reader is at the live end — bottom-follow owns the
   *  viewport there and must keep owning it. */
  const olderAnchor = useRef<{ scrollHeight: number; scrollTop: number } | null>(null)
  /** This commit grew at the FRONT. Read by the user-message re-anchor below,
   *  which would otherwise mistake a prepended page of history for a turn the
   *  reader just sent and yank them to the bottom of the transcript. */
  const prepended = useRef(false)
  const firstMessageId = useRef<string | undefined>(undefined)
  const olderThreadId = useRef(thread.id)

  const endPark = useCallback(() => {
    parkTarget.current = null
    if (parkTimer.current != null) {
      window.clearTimeout(parkTimer.current)
      parkTimer.current = null
    }
  }, [])

  const cancelParkFrame = useCallback(() => {
    if (parkFrame.current != null) {
      cancelAnimationFrame(parkFrame.current)
      parkFrame.current = null
    }
  }, [])

  useEffect(
    () => () => {
      endPark()
      cancelParkFrame()
    },
    [endPark, cancelParkFrame],
  )

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
      // A reader gesture cancels both an in-flight glide and a still-pending
      // schedule — they asked to leave, so we must not re-arm the park.
      if (parkTarget.current == null && pendingParkReason.current == null) return
      cancelParkFrame()
      pendingParkReason.current = null
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
  }, [endPark, cancelParkFrame])

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
  const streamAnchors = useMemo(
    () => (transcript ? runAnchors(transcript) : new Map<number, RunAnchor>()),
    [transcript],
  )
  const streamRunIndex = useMemo(
    () => (transcript ? runsById(transcript) : new Map<string, RunRecord>()),
    [transcript],
  )
  // Live delegate streams, keyed by run id, handed to the tool cards that
  // spawned them (Message → ToolCard → LiveRunSection). Settled runs are not in
  // here, which is what makes a finished card go back to its plain self.
  const streamViews = useMemo(() => liveRunViews(transcript), [transcript])

  // Server-reported status for those runs, polled ONLY while some run is live
  // (lib/delegateStatus). It sharpens elapsed — the stream carries no start
  // time — and settles a run whose `thread.status` we never saw. It can never
  // revive a run the stream already settled, and it never touches the reduced
  // transcript: everything below is a fresh projection.
  const delegateSnapshot = useDelegateStatus({
    baseUrl: delegateStatus?.baseUrl ?? null,
    sessionId: delegateStatus?.sessionId ?? null,
    liveRunCount: streamViews.size,
    ...(delegateStatus ? { onUnsupported: delegateStatus.onUnsupported } : {}),
  })
  const delegateMerge = useMemo(
    () => mergeDelegateStatus({ runs: streamRunIndex, snapshot: delegateSnapshot }),
    [streamRunIndex, delegateSnapshot],
  )
  // Nothing to apply (the usual case, and always when the endpoint is absent)
  // keeps the original map identities, so no memo below it recomputes.
  const anchors = useMemo(
    () => (mergeIsEmpty(delegateMerge) ? streamAnchors : mergedAnchors(streamAnchors, delegateMerge)),
    [streamAnchors, delegateMerge],
  )
  const runIndex = useMemo(
    () =>
      mergeIsEmpty(delegateMerge) ? streamRunIndex : mergedRunRecords(streamRunIndex, delegateMerge),
    [streamRunIndex, delegateMerge],
  )
  const liveViews = useMemo(
    () => (mergeIsEmpty(delegateMerge) ? streamViews : mergedViews(streamViews, delegateMerge)),
    [streamViews, delegateMerge],
  )
  const messages = useMemo(
    () => applyRunAnchors(thread.messages, anchors),
    [thread.messages, anchors],
  )
  // Keyed by session: the clock lives in a module-level store, so a delegate
  // left running survives switching away and back (lib/useRunClock). The
  // server's own elapsed wins when it has one — the local clock can only ever
  // time from first sight.
  const clockElapsedOf = useRunClock(transcript?.runs, thread.id)
  const elapsedOf = useCallback(
    (run: RunRecord | undefined): number | undefined =>
      run ? (delegateMerge.elapsedMs.get(run.id) ?? clockElapsedOf(run)) : undefined,
    [delegateMerge, clockElapsedOf],
  )

  // A turn ends when the session goes running → idle: `session.status` from the
  // SSE reducer (transcript.status), or — in demo/offline mode, where there is
  // no transcript — when the streaming message settles.
  const running = transcript ? transcript.status === "running" || streamingId != null : streamingId != null
  // Bumped once per settled turn: folds every agent card back to its condensed
  // summary. Because it only moves at turn end, a card the reader opens
  // afterwards stays open until the NEXT turn finishes.
  const [turnEnd, setTurnEnd] = useState(0)
  // Session-scoped lifecycle: reset on thread.id so a prior running session
  // cannot make an already-idle newly selected session look like live completion.
  const wasRunning = useRef(false)
  const messageCount = thread.messages.length
  const prevMessageCount = useRef(0)
  // Read when applying a park (not a dep — the effect must fire on transitions
  // and message growth; the apply frame always reads the latest rows).
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
    // Server-injected notices ride the user role but nobody typed them, so they
    // must not re-arm follow-the-bottom under a reader who scrolled up.
    () => thread.messages.reduce((n, m) => (m.role === "user" && !m.notice ? n + 1 : n), 0),
    [thread.messages],
  )
  const prevUserMessageCount = useRef(0)

  /** Ask for one more page, remembering where the reader is first. */
  const requestOlder = useCallback(() => {
    const el = scrollRef.current
    if (!el || !onLoadOlder) return
    olderArmed.current = false
    // Anchoring is measured from the END of the content, which is the only
    // offset invariant under growth above the viewport. At the live end there
    // is nothing to preserve: bottom-follow keeps doing exactly what it did.
    olderAnchor.current = stuckToBottom.current
      ? null
      : { scrollHeight: el.scrollHeight, scrollTop: el.scrollTop }
    try {
      void Promise.resolve(onLoadOlder()).catch(() => {
        olderAnchor.current = null
      })
    } catch {
      olderAnchor.current = null
    }
  }, [onLoadOlder])

  // Reaching for the top fetches the next page. Rate limited by the arming rule
  // above, so a page shorter than the viewport cannot chain into the next one:
  // the reader has to scroll away and come back, or press the button.
  useEffect(() => {
    const el = scrollRef.current
    if (!el || !onLoadOlder || !hasOlder) return
    const onScroll = () => {
      const step = olderTrigger({
        scrollTop: el.scrollTop,
        hasMore: hasOlder,
        loading: loadingOlder,
        armed: olderArmed.current,
      })
      olderArmed.current = step.armed
      if (step.fetch) requestOlder()
    }
    el.addEventListener("scroll", onScroll, { passive: true })
    return () => el.removeEventListener("scroll", onScroll)
  }, [hasOlder, loadingOlder, onLoadOlder, requestOlder])

  // Prepend anchoring. BEFORE paint (and before every passive effect below), so
  // the page of history that just mounted above the reader never shows as a
  // jump: the viewport moves down by exactly the height that was inserted.
  useLayoutEffect(() => {
    const nextFirst = messages[0]?.id
    if (olderThreadId.current !== thread.id) {
      // A session switch replaces the list wholesale; nothing to preserve.
      olderThreadId.current = thread.id
      olderArmed.current = false
      olderAnchor.current = null
      prepended.current = false
      firstMessageId.current = nextFirst
      return
    }
    const grewAtFront = isPrepend({
      previousFirstId: firstMessageId.current,
      previousCount: prevMessageCount.current,
      nextFirstId: nextFirst,
      nextCount: messages.length,
    })
    firstMessageId.current = nextFirst
    if (!grewAtFront) return
    prepended.current = true
    const el = scrollRef.current
    const anchor = olderAnchor.current
    olderAnchor.current = null
    if (!el || !anchor) return
    const top = anchorScrollTop({
      previousScrollHeight: anchor.scrollHeight,
      previousScrollTop: anchor.scrollTop,
      nextScrollHeight: el.scrollHeight,
    })
    // Ours, not the reader's: recorded so the scroll classifier does not read
    // the restore as a gesture and change stickiness because of it.
    commandedTop.current = jumpTo(el, top)
  }, [messages, thread.id])

  // Switching sessions resets every lifecycle flag. Declared BEFORE the
  // user-message re-arm effect so, on the same commit as a thread change,
  // baselines and openPending are armed first and the count check sees the
  // new thread's sizes (no synthetic 0→N append that cancels open framing).
  //
  // Count baselines snap to the NEW thread's current sizes (read from this
  // render; deps stay thread.id-only so appends cannot re-arm open framing).
  useEffect(() => {
    stuckToBottom.current = true
    parkedByUs.current = false
    commandedTop.current = null
    wasRunning.current = false
    prevMessageCount.current = messageCount
    prevUserMessageCount.current = userMessageCount
    openPending.current = true
    pendingParkReason.current = null
    cancelParkFrame()
    endPark()
    // messageCount / userMessageCount: intentional stale-deps omission — only
    // baseline on thread switch, using the new thread's sizes from this render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [thread.id, endPark, cancelParkFrame])

  // A fresh user turn always re-anchors to the bottom, even if the reader had
  // scrolled away to re-read the previous answer. Runs after the thread-id
  // reset so hydration of a newly selected session does not look like a send.
  useEffect(() => {
    if (userMessageCount > prevUserMessageCount.current) {
      // Replay/hydration grows the user-message count while open framing is
      // still pending — that is history arriving, not a turn the reader just
      // sent. Only a genuine post-open append re-arms follow and cancels park.
      // A prepended page of OLDER turns grows the same count and is likewise
      // not a send: re-anchoring there would throw the reader out of the
      // history they just asked to see.
      if (!openPending.current && !prepended.current) {
        stuckToBottom.current = true
        parkedByUs.current = false
        // A new human turn supersedes any unfinished open/complete park.
        cancelParkFrame()
        pendingParkReason.current = null
        endPark()
      }
    }
    prevUserMessageCount.current = userMessageCount
  }, [userMessageCount, endPark, cancelParkFrame])

  /** Apply a start-of-answer park on the next frame. Pending reason stays set
   *  until this lands (or the reader cancels), so a cancelled rAF from message
   *  churn re-schedules via decideScroll instead of leaving follow off. */
  const schedulePark = useCallback(
    (el: HTMLElement) => {
      // Disarm bottom-follow immediately so a ResizeObserver tick between this
      // call and the animation frame cannot jump to the tail first.
      stuckToBottom.current = false
      cancelParkFrame()
      parkFrame.current = requestAnimationFrame(() => {
        parkFrame.current = null
        // Reader cancelled (or a newer schedule replaced us) while we waited.
        if (pendingParkReason.current == null) return

        const answerId = lastAnswerId(messagesRef.current)
        const inner = innerRef.current
        const first = answerId
          ? (inner?.querySelector<HTMLElement>(
              `[data-msg-id="${CSS.escape(answerId)}"]`,
            ) ?? null)
          : null
        const answerOffsetTop = first
          ? first.getBoundingClientRect().top -
            el.getBoundingClientRect().top +
            el.scrollTop
          : null
        const resolved = resolveParkPosition({
          answerOffsetTop,
          scrollHeight: el.scrollHeight,
          clientHeight: el.clientHeight,
          gap: ANSWER_TOP_GAP,
        })

        pendingParkReason.current = null

        if (resolved.kind === "follow") {
          // No row, or a short answer whose start is already the tail: keep
          // stickiness so later turns still follow. Instant jump so nothing
          // races the ResizeObserver's own bottom-follow.
          stuckToBottom.current = true
          parkedByUs.current = false
          followBottom(el)
          return
        }

        // Long answer: park away from the end. Position is OURS so a later
        // auto-continued turn can re-arm follow without mistaking this for a
        // deliberate scroll into history.
        parkedByUs.current = true
        commandedTop.current = null
        parkTarget.current = glideTo(el, resolved.top)
        if (parkTimer.current != null) window.clearTimeout(parkTimer.current)
        parkTimer.current = window.setTimeout(() => {
          parkTimer.current = null
          parkTarget.current = null
        }, PARK_SETTLE_MS)
      })
    },
    [cancelParkFrame, followBottom],
  )

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return

    const justStarted = !wasRunning.current && running
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
    // Skip while a park is still pending: reAnchor must not clear parkedByUs
    // / stuck under a schedule that has not applied yet.
    if (pendingParkReason.current == null && parkTarget.current == null) {
      const anchored = reAnchor({
        stuck: stuckToBottom.current,
        parkedByUs: parkedByUs.current,
        parkInFlight: false,
        justStarted,
        appended,
        atBottom: atBottom(el),
      })
      stuckToBottom.current = anchored.stuck
      parkedByUs.current = anchored.parkedByUs
    }

    const decision = decideScroll({
      loading,
      catchingUp,
      running,
      wasRunning: wasRunning.current,
      openPending: openPending.current,
      stuck: stuckToBottom.current,
      parkedByUs: parkedByUs.current,
      parkInFlight: parkTarget.current != null,
      pendingParkReason: pendingParkReason.current,
    })

    wasRunning.current = decision.next.wasRunning
    openPending.current = decision.next.openPending
    pendingParkReason.current = decision.next.pendingParkReason
    if (decision.next.markTurnEnd) setTurnEnd((n) => n + 1)

    // Consumed: every rule that had to know about the prepend (the user-message
    // re-anchor above, which runs first) has already seen it.
    prepended.current = false

    switch (decision.action.type) {
      case "hold":
        return
      case "follow-if-stuck":
        // Streaming, replaying, or ordinary growth: follow the bottom unless
        // the reader left it. Instant, not smooth — the viewport's scroll-smooth
        // would restart an animation on every delta and never catch a fast stream.
        if (stuckToBottom.current && parkTarget.current == null) followBottom(el)
        return
      case "schedule-park":
        schedulePark(el)
        return
    }
    // `messages` is a dep so this fires on every streamed delta and on the
    // commit that finishes catch-up with the final rows mounted; open framing
    // and mid-message follow both need that. catchingUp/loading gate the
    // decision so historical replay edges never look like live completion.
  }, [
    running,
    messageCount,
    streamingId,
    loading,
    catchingUp,
    messages,
    followBottom,
    schedulePark,
  ])

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
      ...(onStopRun ? { onStopRun } : {}),
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
    [liveViews, elapsedOf, runIndex, transcript, modelName, collapseSignal, onStopRun],
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
      {/* Older turns exist above this point, so the "start of thread" marker
          would be a lie: the affordance replaces it until the history runs out,
          at which point this row becomes the true start again. Lives INSIDE the
          scrollport, so no drag region is involved. */}
      {hasOlder && onLoadOlder && !empty ? (
        <Row>
          <div className="flex justify-center">
            <Button
              variant="ghost"
              size="sm"
              className="rounded-full text-[11px] text-muted-foreground hover:text-foreground"
              onClick={requestOlder}
              disabled={loadingOlder}
              aria-busy={loadingOlder}
            >
              {loadingOlder ? (
                <>
                  <Loader2 className="size-3 animate-spin text-primary" />
                  Loading…
                </>
              ) : (
                <>
                  <History className="size-3" />
                  Load earlier messages
                </>
              )}
            </Button>
          </div>
        </Row>
      ) : (
        !empty && (
          <Row>
            <div className="flex items-center gap-2 self-start rounded-full border border-border bg-muted/40 px-3 py-1 text-[11px] text-muted-foreground">
              <Sparkles className="size-3 text-primary" />
              {loading ? "Loading transcript…" : catchingUp ? "Catching up…" : "Start of thread"}
            </div>
          </Row>
        )
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
