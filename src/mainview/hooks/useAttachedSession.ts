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
import {
  encodeSessionEventCursor,
  type AgentEvent,
  type GoalSnapshot,
  type ModeSpec,
} from "@chunky/protocol"
import {
  fetchSessionHistory,
  fetchSessionTodos,
  getGoal,
  openSessionEventStream,
  SessionCursorRejected,
  SessionHistoryRewritten,
  type AppConfig,
} from "../lib/api"
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
import {
  appendMonotonicHistoryRow,
  committedSessionSnapshot,
  mergeSessionHistoryRows,
  projectSessionHistory,
  SessionHistoryPager,
} from "../lib/sessionHistory"
import {
  deleteSessionSnapshot,
  loadSessionSnapshot,
  saveSessionSnapshot,
} from "../lib/sessionSnapshots"

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
  const [olderHistory, setOlderHistory] = useState({ hasMore: false, loading: false })
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
  const olderLoader = useRef<(() => Promise<void>) | null>(null)

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
    olderLoader.current = null
  }, [])

  // ---- Live: attach SSE (abort on switch, reconcile cached projection with full replay) ----
  const attachSession = useCallback(async (
    baseUrl: string,
    id: string,
    opts?: { fresh?: boolean; boot?: boolean; fullRebuild?: boolean },
  ) => {
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
        olderPage: sessionCache.current.get(previousId)?.olderPage,
        historyRows: sessionCache.current.get(previousId)?.historyRows,
      })
    }
    stopStream()
    const ac = new AbortController()
    streamAbort.current = ac
    const gen = ++attachGen.current
    olderLoader.current = null
    setOlderHistory({ hasMore: false, loading: false })

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
    let lastHistorySeq = cached?.historyRows?.at(-1)?.seq ?? -1
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
    // Todos are a current server snapshot, not merely historical decoration.
    // Hydrate them independently so a bounded tail cannot hide an old list.
    void fetchSessionTodos(baseUrl, id).then((todos) => {
      if (gen !== attachGen.current) return
      const next = { ...live.state, todos }
      live.replaceState(next)
      live.flush()
      sessionCache.current.update(id, { transcript: next })
    }).catch(() => {})

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

    const installOlderPager = (entry: NonNullable<typeof cached>) => {
      if (!entry.olderPage || !entry.historyRows) return
      setOlderHistory({ hasMore: entry.olderPage.hasMore, loading: false })
      const pager = new SessionHistoryPager(entry.historyRows, entry.olderPage)
      olderLoader.current = async () => {
        if (gen !== attachGen.current || ac.signal.aborted) return
        setOlderHistory((current) => current.hasMore ? { ...current, loading: true } : current)
        try {
          await pager.load(
            (before) => fetchSessionHistory(baseUrl, id, { turns: 10, before }),
            () => gen === attachGen.current && !ac.signal.aborted,
            (rows, projection, olderPage) => {
              if (gen !== attachGen.current || ac.signal.aborted) return
              // HTTP pages contain persisted history only. Retain authoritative
              // live/current snapshots that are intentionally absent there.
              const next = {
                ...projection,
                todos: live.state.todos,
                background: live.state.background,
                ports: live.state.ports,
                queue: live.state.queue,
              }
              live.replaceState(next)
              live.flush()
              committedDurable = next
              machine?.rebaseCommitted(next)
              sessionCache.current.update(id, {
                transcript: next,
                durable: next,
                olderPage,
                historyRows: rows,
              })
              lastHistorySeq = rows.at(-1)?.seq ?? lastHistorySeq
              setOlderHistory({ hasMore: olderPage.hasMore, loading: false })
            },
          )
        } catch (err) {
          if (gen !== attachGen.current || ac.signal.aborted) return
          if (err instanceof SessionHistoryRewritten) {
            sessionCache.current.delete(id)
            setOlderHistory({ hasMore: false, loading: false })
            void attachSession(baseUrl, id, { fullRebuild: true })
          }
          // Paging is opportunistic. Other failures retain the current tail
          // and cursor so another scroll-up can retry.
        } finally {
          if (gen === attachGen.current && !ac.signal.aborted) {
            setOlderHistory((current) => ({ ...current, loading: false }))
          }
        }
      }
    }
    if (cached) installOlderPager(cached)

    // On renderer relaunch the in-memory LRU is empty. A durable snapshot is a
    // warm cursor cache: paint it before HTTP history and resume SSE from it.
    if (!cached && !opts?.fresh && !opts?.fullRebuild) {
      const snapshot = await bootPerf.measure("snapshot load", () => loadSessionSnapshot(id))
      if (gen !== attachGen.current || ac.signal.aborted) return
      if (snapshot?.cursor) {
        const cursor = encodeSessionEventCursor(snapshot.cursor)
        committedDurable = snapshot.transcript
        committedCursor = cursor
        live.replaceState(snapshot.transcript)
        live.flush()
        setTranscriptLoading(false)
        cached = {
          transcript: snapshot.transcript,
          durable: snapshot.transcript,
          cursor,
          goal: goalRef.current,
          repoId: activeRepoIdRef.current,
          events: [],
          olderPage: snapshot.olderPage,
        }
        sessionCache.current.set(id, cached)
        setOlderHistory({ hasMore: snapshot.olderPage?.hasMore ?? false, loading: false })
        if (snapshot.olderPage?.hasMore) {
          // Snapshots omit raw rows. Re-fetch the current bounded tail on the
          // first scroll-up to reconstruct pager input, then page older.
          olderLoader.current = async () => {
            if (gen !== attachGen.current || ac.signal.aborted) return
            setOlderHistory({ hasMore: true, loading: true })
            try {
              let page = await fetchSessionHistory(baseUrl, id, { turns: 10 })
              if (gen !== attachGen.current || ac.signal.aborted) return
              let rows = [...page.events]
              // Reconstruct the pages represented by the snapshot before
              // asking for one more. Page cursors are opaque, so equality with
              // the saved cursor is the only safe stopping condition.
              while (
                page.hasMore &&
                page.before &&
                page.before !== snapshot.olderPage?.before
              ) {
                page = await fetchSessionHistory(baseUrl, id, { turns: 10, before: page.before })
                if (gen !== attachGen.current || ac.signal.aborted) return
                rows = mergeSessionHistoryRows(page.events, rows)
              }
              const entry = sessionCache.current.get(id)
              if (!entry) return
              entry.historyRows = rows
              entry.olderPage = { before: page.before, hasMore: page.hasMore }
              lastHistorySeq = rows.at(-1)?.seq ?? -1
              installOlderPager(entry)
              await olderLoader.current?.()
            } catch (err) {
              if (gen !== attachGen.current || ac.signal.aborted) return
              if (err instanceof SessionHistoryRewritten) {
                sessionCache.current.delete(id)
                void attachSession(baseUrl, id, { fullRebuild: true })
              }
            } finally {
              if (gen === attachGen.current && !ac.signal.aborted) {
                setOlderHistory((current) => ({ ...current, loading: false }))
              }
            }
          }
        }
      }
    }

    /** Seed a bounded durable projection from the HTTP history tail and adopt
     *  its captured boundary as the resume cursor. Shared by the cold v2
     *  bootstrap and by `replay-too-large` recovery: both need exactly the same
     *  "replace committed state with the tail, resume SSE from its cursor"
     *  effect, and neither may leave the screen empty.
     *
     *  `yieldIfSeeded` is the cold-path-only race guard: another path having
     *  filled the cache while the request was in flight means this attach must
     *  stand down. Recovery passes false because overwriting the (rejected)
     *  cursor is the entire point.
     *
     *  Returns "superseded" when the caller must stop, "failed" when the tail
     *  request itself failed (caller keeps its legacy fallback). */
    const seedFromHistoryTail = async (
      seedOpts: { yieldIfSeeded: boolean },
    ): Promise<"seeded" | "superseded" | "failed"> => {
      let tail: Awaited<ReturnType<typeof fetchSessionHistory>>
      try {
        tail = await bootPerf.measure("history tail fetch", () =>
          fetchSessionHistory(baseUrl, id, { turns: 10 }),
        )
      } catch {
        return gen !== attachGen.current || ac.signal.aborted ? "superseded" : "failed"
      }
      if (gen !== attachGen.current || ac.signal.aborted) return "superseded"
      cached = sessionCache.current.get(id)
      // Goal/config hydration may have updated the placeholder while the
      // request was in flight; a durable/cursor means another path won.
      if (seedOpts.yieldIfSeeded && (cached?.durable || cached?.cursor)) return "superseded"
      const seeded = projectSessionHistory(tail.events, tail.cursor)
      const seededTranscript = { ...seeded.transcript, todos: live.state.todos }
      committedDurable = seededTranscript
      committedCursor = seeded.cursor
      live.replaceState(seededTranscript)
      live.flush()
      setTranscriptLoading(false)
      bootPerf.noteTailEvents(firstBootAttach, tail.events.length)
      const seededRows = [...tail.events]
      lastHistorySeq = seededRows.at(-1)?.seq ?? -1
      sessionCache.current.set(id, {
        transcript: seededTranscript,
        durable: seededTranscript,
        cursor: seeded.cursor,
        goal: cached?.goal ?? goalRef.current,
        repoId: activeRepoIdRef.current,
        events: [],
        olderPage: { before: tail.before, hasMore: tail.hasMore },
        historyRows: seededRows,
      })
      cached = sessionCache.current.get(id)!
      installOlderPager(cached)
      return "seeded"
    }

    // Cold v2 bootstrap: seed a bounded durable projection, then ask SSE only
    // for events persisted after the HTTP route's captured boundary. Opening
    // the stream afterward is race-safe because that cursor makes the suffix
    // include anything that arrived while the tail request was in flight.
    const coldTail = !opts?.fresh && !opts?.fullRebuild && !cached?.durable && !cached?.cursor
    if (coldTail) {
      // Unsupported and network-failed tail requests both retain the exact
      // pre-existing from-zero replay path below.
      const outcome = await seedFromHistoryTail({ yieldIfSeeded: true })
      if (outcome === "superseded") return
    }

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
          void deleteSessionSnapshot(id)
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

    const saveCommittedSnapshot = () => {
      if (gen !== attachGen.current || ac.signal.aborted || !committedDurable || !committedCursor) return
      const snapshot = committedSessionSnapshot(
        committedDurable,
        committedCursor,
        sessionCache.current.get(id)?.olderPage ?? null,
      )
      if (snapshot) void saveSessionSnapshot(id, snapshot)
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
        saveCommittedSnapshot()
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
          saveCommittedSnapshot()
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
          void deleteSessionSnapshot(id)
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
      if (frame.kind === "replay-reset") {
        void deleteSessionSnapshot(id)
        // The server rejected/replaced the durable generation. Keep the old
        // projection visible while replay works, but rebuild row-backed paging
        // solely from the replacement generation.
        sessionCache.current.update(id, { historyRows: [], olderPage: undefined })
        lastHistorySeq = -1
        olderLoader.current = null
        setOlderHistory({ hasMore: false, loading: false })
      }
      if (frame.kind === "event" && machine.phase === "replay") {
        bootPerf.noteReplayEvent(firstBootAttach)
      }
      if (frame.kind === "event" && isPersistedSessionEvent(frame.event)) {
        const entry = sessionCache.current.get(id)
        if (entry?.historyRows) {
          lastHistorySeq = appendMonotonicHistoryRow(
            entry.historyRows,
            { seq: frame.seq, event: frame.event },
            lastHistorySeq,
          )
        }
      }
      applyStep(machine.handle(frame))
      if (frame.kind === "event" && machine.phase === "live") {
        committedDurable = machine.durable
        committedCursor = machine.cursor
        saveCommittedSnapshot()
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
        reconnecting = attempt > 0
        // A first attempt on an already-connected server must not dip the app to
        // "connecting": every effect keyed on connectionState (summary stream,
        // modes, PR board, announcements) would tear down and refetch on the
        // connected→connecting→connected round trip — doubling boot traffic.
        setConnectionState((prev) =>
          attempt > 0 ? "reconnecting" : prev === "connected" ? prev : "connecting",
        )
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
          // A newer server can refuse a VALID cursor because the suffix from it
          // is over its replay budget. Dropping the cursor there would ask for
          // the unbounded from-zero replay the server just refused, so re-seed
          // from the bounded history tail instead and resume from ITS boundary.
          let reseeded = false
          if (err.code === "replay-too-large") {
            const outcome = await seedFromHistoryTail({ yieldIfSeeded: false })
            if (gen !== attachGen.current || ac.signal.aborted) return
            if (outcome === "superseded") return
            reseeded = outcome === "seeded"
          }
          if (!reseeded) {
            // The server refuses this cursor outright (400), or the tail fetch
            // itself failed. Keeping the cursor would fail identically forever,
            // so forget the resume point and take a full replay — the screen
            // still keeps its projection until the next replay-end commits.
            committedCursor = null
            committedDurable = null
            sessionCache.current.update(id, { durable: null, cursor: null })
            void deleteSessionSnapshot(id)
          }
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

  const loadOlderHistory = useCallback(async (): Promise<void> => {
    await olderLoader.current?.()
  }, [])

  return {
    sessionId,
    setSessionId,
    transcript,
    setTranscript,
    transcriptLoading,
    setTranscriptLoading,
    catchingUp,
    olderHistory,
    pendingSends,
    setPendingSends,
    goal,
    setGoalState,
    sessionIdRef,
    transcriptRef,
    settleTimer,
    attachSession,
    loadOlderHistory,
    stopStream,
  }
}
