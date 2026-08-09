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
import { getGoal, openEventStream, type AppConfig } from "../lib/api"
import { getSessionAgentConfig, type AdvisorStatus, type SessionAgentConfig, type SidekickConfig } from "../lib/configApi"
import { initialState, type TranscriptState } from "../lib/transcript"
import { isPersistedSessionEvent, rebuildTranscript, SessionCache } from "../lib/sessionCache"
import type { PendingSend } from "../lib/pendingSends"
import { TranscriptCoalescer } from "../lib/replayCoalescer"
import { ReplayReconciler } from "../lib/replayReconciler"
import { isIntentionalAbort, reconnectDelay, sleep } from "../lib/reconnect"
import { reresolveConnection, shouldReresolve } from "../lib/reresolve"
import { consumeApiKeyRequest } from "../lib/apiKeyRequest"
import { consumeAppOpenUrl } from "../lib/browserNav"
import { rememberLastSession } from "../lib/desktopState"
import type { SessionSummary } from "../lib/api"

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
  const attachSession = useCallback(async (baseUrl: string, id: string, opts?: { fresh?: boolean }) => {
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
    const replay = new ReplayReconciler(cached?.events)

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
    attachTimers.current = clearCatchUpTimers
    /** Replay is over: publish everything held back and stop deferring to the
     *  session summary for this session's busy state. */
    const finishCatchUp = () => {
      clearCatchUpTimers()
      catchUpActive = false
      if (gen !== attachGen.current) return
      live.flush()
      setCatchingUp(false)
      setTranscriptLoading(false)
    }
    /** Each replayed event pushes the settle out; the cap is what stops a
     *  session that keeps streaming from claiming to replay forever. */
    const noteReplayProgress = () => {
      if (!catchUpActive || gen !== attachGen.current) return
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
      setConnectionState("connected")
      setAppMode("live")
      // Arms the settle even for a session with NO history, whose stream sends
      // nothing at all until its first turn.
      noteReplayProgress()
    }

    let attempt = 0
    const onEvent = (ev: AgentEvent) => {
      if (gen !== attachGen.current) return
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
          sessionCache.current.delete(id)
          // A rewind throws recent turns away, so the baseline any in-flight
          // optimistic row was measured against no longer describes this
          // history. Drop them here rather than leave a row that can never be
          // matched (the reattach below keeps same-session rows otherwise).
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
        setConnectionState(attempt === 0 ? "connecting" : "reconnecting")
        await openEventStream(baseUrl, id, onEvent, ac.signal, onOpen)
        if (ac.signal.aborted || gen !== attachGen.current) return
        finishCatchUp()
        setConnectionState("reconnecting")
        attempt += 1
        await sleep(reconnectDelay(attempt - 1), ac.signal)
        if (await handOverToReplacement()) return
      } catch (err) {
        if (isIntentionalAbort(err, ac.signal) || gen !== attachGen.current) return
        attempt += 1
        setConnectionState("reconnecting")
        // Publish whatever the working state holds: the stream is gone, so
        // nothing else is going to arrive to trigger a cadence flush.
        finishCatchUp()
        try {
          await sleep(reconnectDelay(attempt), ac.signal)
        } catch {
          return
        }
        if (await handOverToReplacement(err)) return
      }
      if (ac.signal.aborted || gen !== attachGen.current) return
      // The protocol has no since/offset cursor: a new stream always starts at
      // history event zero. Keep the current cached projection visible and
      // discard its matching persisted prefix on the next connection.
      setTranscriptLoading(false)
      cached = sessionCache.current.get(id)
      replay.reset(cached?.events)
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
