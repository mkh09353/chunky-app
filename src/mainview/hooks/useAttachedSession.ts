// The attached session's SSE machine, lifted out of App.tsx unchanged.
//
// This is the app's most delicate code: it owns the event stream, the
// full-history replay every (re)connection starts with, the reconnect/handover
// loop, and the generation guards that stop a superseded attachment from
// committing over its replacement. It was extracted VERBATIM — the bodies below
// are byte-identical to the ones that lived in App.tsx — so that the split-view
// work can instantiate it more than once without that change and this one
// landing together.
//
// WHAT LIVES HERE vs. WHAT IS PASSED IN
//
// Here: everything that belongs to ONE attachment — the session id, its
// transcript projection, catch-up/loading flags, optimistic sends, its goal,
// and the refs coordinating them (abort controller, generation counter,
// coalescer, catch-up timers).
//
// Passed in (`AttachedSessionDeps`): everything app-global that the attachment
// merely drives — connection/app mode, the session-list refresh, model and
// agent-config hydration, the shared session cache, the active repo. These stay
// single instances no matter how many attachments exist.
//
// The deps are destructured into locals with the SAME names the App bodies
// used, which is what let the move be byte-for-byte rather than a rewrite.
import { useCallback, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from "react"
import type { AgentEvent, GoalSnapshot, ModeSpec } from "@chunky/protocol"
import { getGoal, openSessionEventStream, SessionCursorRejected, type AppConfig } from "../lib/api"
import { SessionStreamMachine, v2CacheNeedsLegacyRebuild, type SessionStreamFrame, type StreamStep } from "../lib/sessionStream"
import { getSessionAgentConfig, type AdvisorStatus, type SessionAgentConfig, type SidekickConfig } from "../lib/configApi"
import { initialState, type TranscriptState } from "../lib/transcript"
import { isPersistedSessionEvent, rebuildTranscript, SessionCache } from "../lib/sessionCache"
import type { PendingSend } from "../lib/pendingSends"
import { TranscriptCoalescer } from "../lib/replayCoalescer"
import { ReplayReconciler } from "../lib/replayReconciler"
import { installVisibilityWake, isIntentionalAbort, reconnectDelay, ReconnectWaker, sleepUntilWoken } from "../lib/reconnect"
import { reresolveConnection, shouldReresolve } from "../lib/reresolve"
import { consumeApiKeyRequest } from "../lib/apiKeyRequest"
import { consumeAppOpenUrl } from "../lib/browserNav"
import { rememberLastSession } from "../lib/desktopState"
import type { SessionSummary } from "../lib/api"
import { bootPerf } from "../lib/bootPerf"

export type ConnectionState = "booting" | "connecting" | "connected" | "reconnecting" | "offline" | "error"
export type AppMode = "live" | "demo"

const REPLAY_SETTLE_MS = 120
/** Hard cap on the "catching up…" state. A session that is still RUNNING never
 *  goes quiet, so quiet alone must never be the only way out of it. */
const CATCH_UP_MAX_MS = 1_500

/** Everything app-global the attachment drives or reads. One instance of each,
 *  however many attachments there are. */
export interface AttachedSessionDeps {
  sessionCache: RefObject<SessionCache>
  activeRepoIdRef: RefObject<string | null>
  lastSessionByRepo: RefObject<Record<string, string>>
  modeAppliedRef: RefObject<(name: string, spec: ModeSpec, sessionId?: string) => void>
  setConnectionState: Dispatch<SetStateAction<ConnectionState>>
  setAppMode: Dispatch<SetStateAction<AppMode>>
  setConfig: Dispatch<SetStateAction<AppConfig | null>>
  setSendError: Dispatch<SetStateAction<string | null>>
  setConnError: Dispatch<SetStateAction<string | null>>
  setSessionAgentConfig: Dispatch<SetStateAction<Record<string, SessionAgentConfig>>>
  setAdvisorStatus: Dispatch<SetStateAction<AdvisorStatus | null>>
  setSidekickConfig: Dispatch<SetStateAction<SidekickConfig | null>>
  hydrateSessionModel: (baseUrl: string, id: string | null) => Promise<void>
  refreshSessions: (baseUrl: string, repoId?: string | null) => Promise<SessionSummary[]>
}

export function useAttachedSession(deps: AttachedSessionDeps) {
  // Same names the extracted bodies already used, so those bodies did not have
  // to change a character.
  const {
    sessionCache,
    activeRepoIdRef,
    lastSessionByRepo,
    modeAppliedRef,
    setConnectionState,
    setAppMode,
    setConfig,
    setSendError,
    setConnError,
    setSessionAgentConfig,
    setAdvisorStatus,
    setSidekickConfig,
    hydrateSessionModel,
    refreshSessions,
  } = deps

  const [sessionId, setSessionId] = useState<string | null>(null)
  const [transcript, setTranscript] = useState<TranscriptState>(initialState)
  const [transcriptLoading, setTranscriptLoading] = useState(false)
  // Messages posted but not yet echoed by the server, shown straight away so a
  // send never looks lost. Renderer-side presentation state ONLY: never reduced
  // into the transcript, never written to the session cache's event log, never
  // seen by the ReplayReconciler (see lib/pendingSends.ts).
  const [pendingSends, setPendingSends] = useState<readonly PendingSend[]>([])
  // Replay is in flight: the projection on screen is last-seen state, not live
  // state. Everything that would otherwise claim "running" from the transcript
  // defers to the server's own summary while this is true.
  const [catchingUp, setCatchingUp] = useState(false)
  const [goal, setGoalState] = useState<GoalSnapshot | null>(null)

  const streamAbort = useRef<AbortController | null>(null)
  const settleTimer = useRef<number | null>(null)
  const sessionIdRef = useRef<string | null>(null)
  const transcriptRef = useRef<TranscriptState>(initialState)
  const goalRef = useRef<GoalSnapshot | null>(null)
  const attachGen = useRef(0)
  // Publishes the attached session's projection on a cadence instead of once
  // per event (see lib/replayCoalescer). Owned by the current attachment.
  const coalescer = useRef<TranscriptCoalescer | null>(null)
  // Timers belonging to the current attachment's catch-up bookkeeping.
  const attachTimers = useRef<(() => void) | null>(null)

  sessionIdRef.current = sessionId
  transcriptRef.current = transcript
  goalRef.current = goal

  /** Drop the attached session's stream AND everything scheduled around it, so
   *  no in-flight commit can land on top of whatever replaces it. */
  const stopStream = useCallback(() => {
    streamAbort.current?.abort()
    streamAbort.current = null
    coalescer.current?.dispose()
    coalescer.current = null
    attachTimers.current?.()
    attachTimers.current = null
  }, [])

  // ---- Live: attach SSE (abort on switch, reconcile cached projection with full replay) ----
  const attachSession = useCallback(async (baseUrl: string, id: string, opts?: { fresh?: boolean; boot?: boolean }) => {
    const firstBootAttach = bootPerf.beginFirstAttach(opts?.boot === true)
    const previousId = sessionIdRef.current
    // Optimistic rows belong to the session they were typed into. A reattach to
    // the SAME session (reconnect, rewind, server hand-over) keeps them: their
    // sends are still in flight, and the replay that follows is what resolves
    // them. Only a genuine switch drops them.
    if (previousId !== id) setPendingSends([])
    if (previousId) {
      sessionCache.current.set(previousId, {
        // The coalescer's working state is the reduction of EVERY event seen so
        // far; `transcript` may still be a cadence behind it when the reader
        // switches away mid-burst.
        transcript: coalescer.current?.state ?? transcriptRef.current,
        goal: goalRef.current,
        repoId: activeRepoIdRef.current,
        events: sessionCache.current.get(previousId)?.events ?? [],
        durable: sessionCache.current.get(previousId)?.durable ?? null,
        cursor: sessionCache.current.get(previousId)?.cursor ?? null,
      })
    }
    stopStream()
    const ac = new AbortController()
    streamAbort.current = ac
    const gen = ++attachGen.current

    setSessionId(id)
    // Both model provenance and complete mode/delegate state are server truth.
    void hydrateSessionModel(baseUrl, id)
    void getSessionAgentConfig(id).then((next) => {
      if (gen !== attachGen.current) return
      setSessionAgentConfig((prev) => ({ ...prev, [id]: next }))
      setAdvisorStatus({ config: next.advisor, active: next.advisor.enabled && !!next.advisor.model })
      setSidekickConfig(next.sidekick)
    }).catch(() => {})
    void getGoal(baseUrl, id).then((nextGoal) => {
      if (gen !== attachGen.current) return
      goalRef.current = nextGoal
      setGoalState(nextGoal)
      sessionCache.current.update(id, { goal: nextGoal })
    }).catch(() => {})
    const repoForSession = activeRepoIdRef.current ?? "__no_repo__"
    lastSessionByRepo.current[repoForSession] = id
    rememberLastSession(repoForSession, id)
    // Re-read on every (re)connection: a rebuild replaces the entry, and
    // remember() extends whichever one is current.
    let cached = sessionCache.current.get(id)
    // LEGACY servers only: recognise our own past in a from-zero full replay.
    let replay = new ReplayReconciler(cached?.events)

    // ---- v2 (cursor) stream state ----
    // The COMMITTED durable shadow and the cursor it sits at. Every connection
    // attempt starts from these and, unless it reaches `replay-end`, leaves
    // them (and the screen) exactly as it found them. That discard is what
    // makes an interrupted reconnect unable to age the visible transcript.
    let committedDurable: TranscriptState | null = cached?.durable ?? null
    let committedCursor: string | null = cached?.cursor ?? null
    let machine: SessionStreamMachine | null = null
    /** This attempt is talking to a v2 server (frames, not bare events). */
    let v2 = false
    /** The first legacy frame after a v2 cache requires a full legacy rebuild;
     *  its cache has a cursor/shadow, not the persisted event prefix the old
     *  reconciler needs to recognise a from-zero replay. */
    let legacyAttemptStarted = false
    /** Cuts a reconnect backoff short when the app comes back to the front. */
    const waker = new ReconnectWaker()
    let reconnecting = false
    const removeVisibilityWake = installVisibilityWake(waker, () => reconnecting)

    // The projection is published on a cadence, NOT once per event: the server
    // replays the whole history on every attach, and committing that per event
    // is what left a backgrounded session stale on screen for seconds.
    const live = new TranscriptCoalescer(cached?.transcript ?? initialState, (next) => {
      if (gen !== attachGen.current) return
      setTranscript(next)
    })
    coalescer.current = live

    // ---- catch-up (replay in flight) ----
    let catchUpActive = !opts?.fresh
    let catchUpQuiet: number | null = null
    let catchUpCap: number | null = null
    const clearCatchUpTimers = () => {
      if (catchUpQuiet != null) window.clearTimeout(catchUpQuiet)
      if (catchUpCap != null) window.clearTimeout(catchUpCap)
      catchUpQuiet = null
      catchUpCap = null
      if (settleTimer.current != null) {
        clearTimeout(settleTimer.current)
        settleTimer.current = null
      }
    }
    attachTimers.current = () => {
      clearCatchUpTimers()
      removeVisibilityWake()
    }
    /** Replay is over: publish everything held back and stop deferring to the
     *  session summary for this session's busy state. */
    const finishCatchUp = () => {
      clearCatchUpTimers()
      catchUpActive = false
      if (gen !== attachGen.current) return
      live.flush()
      setCatchingUp(false)
      setTranscriptLoading(false)
      bootPerf.settleFirstAttach(firstBootAttach)
    }
    /** Each replayed event pushes the settle out; the cap is what stops a
     *  session that keeps streaming from claiming to replay forever. */
    const noteReplayProgress = () => {
      // The v2 stream has an explicit replay boundary; only the legacy
      // full-replay path has to guess with timers.
      if (v2 || !catchUpActive || gen !== attachGen.current) return
      if (catchUpQuiet != null) window.clearTimeout(catchUpQuiet)
      catchUpQuiet = window.setTimeout(finishCatchUp, REPLAY_SETTLE_MS)
      settleTimer.current = catchUpQuiet
      if (catchUpCap == null) catchUpCap = window.setTimeout(finishCatchUp, CATCH_UP_MAX_MS)
    }

    const rememberEvent = (event: AgentEvent, nextTranscript = live.state) => {
      sessionCache.current.remember(id, nextTranscript, goalRef.current, activeRepoIdRef.current, event)
    }
    setTranscript(cached?.transcript ?? initialState)
    setGoalState(cached?.goal ?? null)
    if (!cached) sessionCache.current.set(id, { transcript: initialState, goal: null, repoId: activeRepoIdRef.current, events: [] })
    // A just-created session has no history to replay — don't flash the
    // "Replaying session history…" state while its stream connects.
    setTranscriptLoading(!opts?.fresh && !cached)
    // A cache hit shows LAST-SEEN state until the replay passes it, which is
    // exactly when the reader must not be told this is the live picture.
    setCatchingUp(catchUpActive)
    setSendError(null)
    setConnError(null)

    const onOpen = () => {
      if (gen !== attachGen.current) return
      bootPerf.noteStreamOpen(firstBootAttach)
      reconnecting = false
      setConnectionState("connected")
      setAppMode("live")
      // Arms the settle even for a session with NO history, whose stream sends
      // nothing at all until its first turn.
      noteReplayProgress()
    }

    let attempt = 0
    /** LEGACY path: full replay from event zero, reconciled against the cached
     *  persisted prefix. Unchanged — old servers still land here. */
    const onEvent = (ev: AgentEvent) => {
      if (gen !== attachGen.current) return
      if (catchUpActive) bootPerf.noteReplayEvent(firstBootAttach)
      attempt = 0
      noteReplayProgress()
      // The server always sends history from event zero and exposes no replay
      // boundary/cursor. Silently discard the cached persisted prefix; the
      // first new event is reduced onto the projection already on screen.
      const decision = replay.next(ev)
      if (decision.kind === "skip") {
        // Everything the cache knew is accounted for: from here on this is
        // news, and the screen is live again as soon as it is reduced.
        if (decision.complete) finishCatchUp()
        return
      }
      // Any prefix disagreement means the cache cannot safely be extended, so
      // the projection is rebuilt from event zero in the WORKING state while
      // the previous one stays on screen. The hold ends on burst-quiet or at
      // its cap, so a still-running session can no longer freeze the view.
      if (decision.kind === "rebuild") {
        live.replaceState(rebuildTranscript(decision.prefix))
        live.hold()
        sessionCache.current.set(id, {
          transcript: live.state,
          goal: goalRef.current,
          repoId: activeRepoIdRef.current,
          events: decision.prefix,
        })
      }
      // These arrive only on the live stream, never in Store.history. They
      // must update the visible/cache projection but must never be replayed
      // into it as history — hence the side effects firing here, in stream
      // order, exactly as they did when every event committed on its own.
      if (!isPersistedSessionEvent(ev)) {
        if (ev.type === "session.rewound") {
          // A rewind throws recent turns away, so the baseline any in-flight
          // optimistic row was measured against no longer describes this
          // history. Drop them here, but retain the last committed projection
          // and cursor: the reattach keeps that screen visible until legacy
          // divergence settles or v2 replay-reset reaches replay-end.
          setPendingSends([])
          void attachSession(baseUrl, id)
          return
        }
        // Live-only broadcast (never persisted, never a transcript item):
        // another window/the TUI applied a mode, so re-read model + alias state.
        if (ev.type === "mode.applied") {
          rememberEvent(ev)
          modeAppliedRef.current(ev.name, ev.spec, ev.sessionId)
          return
        }
        // The agent asking for our browser pane. Also live-only: claimed here
        // and never reduced, so it cannot become a rendered transcript item.
        // Only http(s) actually opens the pane — openInAppBrowser owns that rule.
        if (consumeAppOpenUrl(ev)) { rememberEvent(ev); return }
        // The agent asking us to collect a provider API key. Live-only for the
        // same reason and then some: claimed here so neither the request nor
        // anything it leads to can become a transcript item.
        if (consumeApiKeyRequest(ev)) { rememberEvent(ev); return }
        rememberEvent(ev, live.push(ev))
        return
      }
      rememberEvent(ev, live.push(ev))
      if (ev.type === "goal.update") {
        goalRef.current = ev.goal
        setGoalState(ev.goal)
        sessionCache.current.update(id, { goal: ev.goal })
      }
      // Surface title updates from session list by refreshing occasionally on status idle.
      if (ev.type === "session.status" && ev.status === "idle") {
        void refreshSessions(baseUrl, activeRepoIdRef.current).catch(() => {})
      }
    }

    /** v2: write the projection on screen plus the durable shadow/cursor the
     *  next reconnect will resume from. */
    const cacheVisible = (nextTranscript: TranscriptState) => {
      sessionCache.current.update(id, {
        transcript: nextTranscript,
        goal: goalRef.current,
        repoId: activeRepoIdRef.current,
        durable: machine?.durable ?? committedDurable,
        cursor: machine?.cursor ?? committedCursor,
        events: [],
      })
    }

    /** v2: act on one decision from the stream machine. */
    const applyStep = (step: StreamStep): void => {
      if (step.kind === "legacy" || step.kind === "reset") return
      if (step.kind === "commit") {
        // Atomic: the shadow, the cursor and the screen move together, and only
        // here. Durable now covers everything the live overlay had.
        committedDurable = step.durable
        committedCursor = step.cursor
        live.replaceState(step.visible)
        sessionCache.current.commitCursor(id, {
          transcript: step.visible,
          durable: step.durable,
          cursor: step.cursor,
          goal: goalRef.current,
          repoId: activeRepoIdRef.current,
        })
        finishCatchUp()
        return
      }
      const ev = step.event
      if (step.kind === "durable") {
        // Shadow-only: replay history, or the coalesced delta whose raw tokens
        // are already on screen. Never touches the visible projection.
        if (ev.type === "goal.update") {
          goalRef.current = ev.goal
          setGoalState(ev.goal)
          sessionCache.current.update(id, { goal: ev.goal })
        }
        if (step.phase === "live") {
          committedDurable = machine?.durable ?? committedDurable
          committedCursor = machine?.cursor ?? committedCursor
          sessionCache.current.update(id, { durable: committedDurable, cursor: committedCursor })
        }
        return
      }
      // Visible. Live-only events are claimed here, in stream order, exactly as
      // on the legacy path — a claimed event must never become a transcript item.
      if (!isPersistedSessionEvent(ev)) {
        if (ev.type === "session.rewound") {
          // Keep the committed projection/cursor visible through the rewind
          // rebuild; the new generation produces replay-reset and swaps only
          // at replay-end. Only optimistic sends are invalid after truncation.
          setPendingSends([])
          void attachSession(baseUrl, id)
          return
        }
        if (ev.type === "mode.applied") {
          cacheVisible(machine?.visible ?? live.state)
          modeAppliedRef.current(ev.name, ev.spec, ev.sessionId)
          return
        }
        if (consumeAppOpenUrl(ev)) { cacheVisible(machine?.visible ?? live.state); return }
        if (consumeApiKeyRequest(ev)) { cacheVisible(machine?.visible ?? live.state); return }
      }
      const nextTranscript = machine ? machine.reduceVisible(ev) : live.push(ev)
      if (machine) live.publish(nextTranscript)
      cacheVisible(nextTranscript)
      if (ev.type === "goal.update") {
        goalRef.current = ev.goal
        setGoalState(ev.goal)
        sessionCache.current.update(id, { goal: ev.goal })
      }
      if (ev.type === "session.status" && ev.status === "idle") {
        void refreshSessions(baseUrl, activeRepoIdRef.current).catch(() => {})
      }
    }

    const onFrame = (frame: SessionStreamFrame) => {
      if (gen !== attachGen.current) return
      attempt = 0
      if (frame.kind === "legacy") {
        // Old server: it ignored ?stream=v2 and is replaying from event zero.
        // A cache produced by v2 has no legacy event prefix, so reset the
        // working projection before consuming the first history event rather
        // than appending the entire replay to the already-visible transcript.
        if (!legacyAttemptStarted) {
          legacyAttemptStarted = true
          if (v2CacheNeedsLegacyRebuild({ cursor: committedCursor, durable: committedDurable })) {
            replay = new ReplayReconciler()
            committedDurable = null
            committedCursor = null
            live.replaceState(initialState)
            live.hold()
            sessionCache.current.set(id, {
              transcript: live.state,
              goal: goalRef.current,
              repoId: activeRepoIdRef.current,
              events: [],
              durable: null,
              cursor: null,
            })
          }
        }
        // Route the whole attempt through the reconciler + settle timers.
        onEvent(frame.event)
        return
      }
      if (!v2) {
        v2 = true
        // replay-end, not a quiet timer, ends catch-up from here on.
        clearCatchUpTimers()
      }
      if (!machine) return
      if (frame.kind === "event" && machine.phase === "replay") {
        bootPerf.noteReplayEvent(firstBootAttach)
      }
      applyStep(machine.handle(frame))
    }

    /** After a failed attachment: when the evidence says the server is gone or
     *  retiring (not just a hiccup), resolve the connection again and reattach
     *  to whatever is serving this workspace now. Returns true once this loop
     *  has handed over — the replacement attachment owns the session from
     *  there, and full-history replay restores the transcript. */
    const handOverToReplacement = async (failure?: unknown): Promise<boolean> => {
      if (!shouldReresolve({ attempts: attempt, error: failure })) return false
      const next = await reresolveConnection()
      if (!next || ac.signal.aborted || gen !== attachGen.current) return false
      if (next.baseUrl === baseUrl) return false
      // config first: every base-URL-derived caller reads it, and configApi's
      // memo was already repointed inside reresolveConnection().
      setConfig(next)
      void attachSession(next.baseUrl, id)
      return true
    }

    for (;;) {
      try {
        if (gen !== attachGen.current) return
        reconnecting = attempt > 0
        setConnectionState(attempt === 0 ? "connecting" : "reconnecting")
        // One machine per attempt, built from COMMITTED state only: if this
        // attempt dies before replay-end, its working shadow dies with it.
        v2 = false
        legacyAttemptStarted = false
        machine = new SessionStreamMachine({
          visible: live.state,
          durable: committedDurable,
          cursor: committedCursor,
        })
        await openSessionEventStream(baseUrl, id, onFrame, {
          cursor: machine.requestCursor,
          signal: ac.signal,
          onOpen,
        })
        if (ac.signal.aborted || gen !== attachGen.current) return
        finishCatchUp()
        reconnecting = true
        setConnectionState("reconnecting")
        attempt += 1
        await sleepUntilWoken(reconnectDelay(attempt - 1), ac.signal, waker)
        if (await handOverToReplacement()) return
      } catch (err) {
        if (isIntentionalAbort(err, ac.signal) || gen !== attachGen.current) return
        if (err instanceof SessionCursorRejected) {
          // The server refuses this cursor outright (400). Keeping it would
          // fail identically forever, so forget the resume point and take a
          // full replay — the screen still keeps its projection until the next
          // replay-end commits.
          committedCursor = null
          committedDurable = null
          sessionCache.current.update(id, { durable: null, cursor: null })
        }
        attempt += 1
        reconnecting = true
        setConnectionState("reconnecting")
        // Publish whatever the working state holds: the stream is gone, so
        // nothing else is going to arrive to trigger a cadence flush. On the v2
        // path this is always the last COMMITTED projection — a replay in
        // flight never touched it.
        finishCatchUp()
        try {
          await sleepUntilWoken(reconnectDelay(attempt), ac.signal, waker)
        } catch {
          return
        }
        if (await handOverToReplacement(err)) return
      }
      if (ac.signal.aborted || gen !== attachGen.current) return
      // Keep the current projection on screen while the next connection
      // resumes: v2 from the committed cursor, legacy by discarding the
      // matching persisted prefix of another full replay.
      setTranscriptLoading(false)
      cached = sessionCache.current.get(id)
      replay.reset(cached?.events)
      committedDurable = cached?.durable ?? committedDurable
      committedCursor = cached?.cursor ?? committedCursor
      catchUpActive = true
      setCatchingUp(true)
    }
  }, [refreshSessions, hydrateSessionModel, stopStream])

  return {
    sessionId,
    setSessionId,
    transcript,
    setTranscript,
    transcriptLoading,
    setTranscriptLoading,
    catchingUp,
    pendingSends,
    setPendingSends,
    goal,
    setGoalState,
    sessionIdRef,
    transcriptRef,
    settleTimer,
    attachSession,
    stopStream,
  }
}
