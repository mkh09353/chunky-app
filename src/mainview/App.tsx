import { AlertCircle, EyeOff, WifiOff } from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { ChatTopBar, ChatView } from "./components/ChatView"
import { CommandPalette } from "./components/CommandPalette"
import { VoiceButton } from "./components/VoiceButton"
import { VoiceHud } from "./components/VoiceHud"
import { codeToLabel } from "./lib/pushToTalk"
import { useVoiceAgent } from "./hooks/useVoiceAgent"
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPopup, DialogTitle } from "./components/ui/dialog"
import { Composer, type ModeOption } from "./components/Composer"
import { SettingsCenter } from "./components/settings/SettingsCenter"
import {
  devOnboardingRequested,
  needsOnboarding,
  OnboardingWizard,
} from "./components/settings/OnboardingWizard"
import { ContextMeter } from "./components/ContextMeter"
import { QueueChips } from "./components/QueueChips"
import { TodosPanel } from "./components/TodosPanel"
import { loadTerminalsOpen, TerminalDrawer } from "./components/TerminalDrawer"
import { GitToolbar } from "./components/GitPanel"
import { Sidebar } from "./components/Sidebar"
import { SidekickPicker } from "./components/SidekickPicker"
import { BrowserPane } from "./components/BrowserPane"
import { FactoryPane } from "./components/FactoryPane"
import { ExternalLinkMenu } from "./components/ExternalLinkMenu"
import { ConfirmHost } from "./components/ConfirmDialog"
import { confirm } from "./lib/confirm"
import { announceAppBrowserTarget, resetAppBrowserAnnounce } from "./lib/appBrowser"
import { announceAppZooTarget, resetAppZooAnnounce } from "./lib/appZoo"
import { consumeAppOpenUrl, subscribeBrowserNavigation } from "./lib/browserNav"
import { Button } from "./components/ui/button"
import { TooltipProvider } from "./components/ui/tooltip"
import {
  addRepo,
  createSession,
  deleteQueueEntry,
  fetchModel,
  fetchServerInfo,
  fetchServerRetiring,
  interruptSession,
  forkSession, getGoal, getRewindPoints, getScoreboard, getUsage, renameSession, rewindSession, setGoal, shipSession,
  listAllModels,
  listRepos,
  listSessions,
  loadConfig,
  openEventStream,
  prettyModel,
  QueueFullError,
  removeRepo,
  selectModel,
  searchFiles,
  sendMessage,
  splitModelKey,
  type AppConfig,
  type ModelRow,
  type ModelSelection,
  type Repo,
  type SessionSummary,
} from "./lib/api"
// `setCacheGuard` is aliased: the local state setter of the same name owns the
// pre-send confirm bar, while this one persists the server-side threshold.
import { applyMode, deleteMode, getAdvisorStatus, getCacheGuard, getModes, getSidekick, saveMode, setCacheGuard as saveCacheGuardTokens, type AdvisorStatus, type SidekickConfig } from "./lib/configApi"
import { buildComposerStatus } from "./lib/composerStatus"
import { ComposerStatus } from "./components/ComposerStatus"
import {
  defaultCloneParent,
  extractClonePath,
  joinPath,
  parseGitUrl,
  runCloneSession,
} from "./lib/cloneRepo"
import { cloneRoots } from "./lib/dirSearch"
import { reresolveConnection, shouldReresolve, subscribeServerChanged } from "./lib/reresolve"
import {
  desktopUiSnapshot,
  forgetRepoSessions,
  loadDesktopUiState,
  rememberActiveRepo,
  rememberLastSession,
} from "./lib/desktopState"
import type { CloneStatus } from "./components/RepoTabs"
import { asScoreboard, asUsage, compactTokens, type ScoreboardResponse, type UsageResponse } from "./lib/stats"
import {
  incognitoAppliedLine,
  NO_INCOGNITO_MODES,
  notIncognitoLine,
  resolveIncognitoCommand,
  unknownModeLine,
  type SavedMode,
} from "./lib/incognitoModes"
import { ScoreboardTable, UsageTable } from "./components/StatsTables"
import {
  BARE_COMMAND_RE,
  COMMANDS,
  modeCommands,
  savedModeForCommand,
  type SlashCommand,
} from "./lib/slashCommands"
import type { GoalSnapshot, ModeInfo, ModeSpec, QueueEntry, RewindPoint } from "@chunky/protocol"
import { activeModeName } from "./lib/modes"
import { followUpNotice, steerQueuedMessage } from "./lib/queueActions"
import type { PaletteAction } from "./components/CommandPalette"
import { cn } from "./lib/cn"
import {
  MODELS,
  PROJECTS,
  THREADS,
  type Model,
  type Project,
  type Thread,
} from "./lib/mock"
import {
  buildActiveThread,
  projectFromWorkspace,
  sessionToThread,
  streamingMessageId,
} from "./lib/mapTranscript"
import { isIntentionalAbort, reconnectDelay, sleep } from "./lib/reconnect"
import type { MessageDelivery } from "@chunky/protocol"
import { useTheme } from "./lib/theme"
import { initialState, isStreaming, isTreeIdle, reduce, type TranscriptState } from "./lib/transcript"
import { isPersistedSessionEvent, rebuildTranscript, SessionCache } from "./lib/sessionCache"
import hornUrl from "./assets/horn.wav"

type ConnectionState = "booting" | "connecting" | "connected" | "reconnecting" | "offline" | "error"
type AppMode = "live" | "demo"

const REPLAY_SETTLE_MS = 120
/** Recent agent-activity lines kept for the clone popover's progress log. */
const CLONE_LOG_LINES = 8

/** How long a local apply suppresses the echoed mode.applied notice. */
const SELF_APPLY_WINDOW_MS = 10_000
const MIN_COMPLETION_NOTIFY_MS = 3_000

/** Best effort only: browsers may reject playback before a user gesture. */
function playCompletionHorn(): void {
  try {
    void new Audio(hornUrl).play().catch(() => {})
  } catch {
    // Audio is unavailable in a few embedded/browser contexts.
  }
}

function projectFromRepo(repo: Repo | null | undefined): Project | undefined {
  if (!repo) return undefined
  return {
    id: `repo:${repo.id}`,
    name: repo.name,
    path: repo.path,
    owner: "local",
    mark: repo.name.slice(0, 1).toUpperCase() || "?",
  }
}

function modelSelectionToUi(sel: ModelSelection | null, rows: ModelRow[]): Model {
  if (!sel?.model) {
    return rows[0]
      ? {
          id: `${rows[0].provider}/${rows[0].model.id}`,
          name: rows[0].model.name || prettyModel(rows[0].model.id),
          vendor: rows[0].provider,
          note: rows[0].ready ? "ready" : "not logged in",
        }
      : { id: "unknown", name: "No model", vendor: "—", note: "unavailable" }
  }
  const row = rows.find((r) => r.provider === sel.provider && r.model.id === sel.model)
  return {
    id: `${sel.provider}/${sel.model}`,
    name: row?.model.name || prettyModel(sel.model),
    vendor: sel.provider,
    note: [
      sel.effort ? `effort ${sel.effort}` : null,
      row?.ready === false ? "not logged in" : null,
      row?.model.contextLimit ? `${Math.round(row.model.contextLimit / 1000)}k ctx` : null,
    ]
      .filter(Boolean)
      .join(" · ") || "active",
  }
}

/** Same executor pairing? Used to tell a session PIN apart from the inherited
 *  global default (both come back in the same shape from /api/model). */
function sameSelection(a: ModelSelection | null, b: ModelSelection | null): boolean {
  if (!a || !b) return a === b
  return (
    a.provider === b.provider &&
    a.model === b.model &&
    (a.effort ?? null) === (b.effort ?? null) &&
    (a.speed ?? null) === (b.speed ?? null)
  )
}

function rowsToModels(rows: ModelRow[]): Model[] {
  return rows.map((r) => ({
    id: `${r.provider}/${r.model.id}`,
    name: r.model.name || prettyModel(r.model.id),
    vendor: r.provider,
    reasoning: r.model.reasoning,
    ready: r.ready,
    note: [
      r.ready ? "ready" : "not logged in",
      r.model.contextLimit ? `${Math.round(r.model.contextLimit / 1000)}k ctx` : null,
      r.model.reasoning ? "reasoning" : null,
    ]
      .filter(Boolean)
      .join(" · "),
  }))
}

export function App() {
  const { resolved, toggle } = useTheme()

  // ---- Live server state ----
  const [config, setConfig] = useState<AppConfig | null>(null)
  const [connectionState, setConnectionState] = useState<ConnectionState>("booting")
  const [connError, setConnError] = useState<string | null>(null)
  const [appMode, setAppMode] = useState<AppMode>("live")
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [sessionId, setSessionId] = useState<string | null>(null)
  // Sessions whose run finished while they weren't being viewed: their rows
  // show "Done" with an unread dot until selected.
  const [unreadDone, setUnreadDone] = useState<Set<string>>(new Set())
  const wasRunning = useRef<Map<string, boolean>>(new Map())
  const runningSince = useRef<Map<string, number>>(new Map())
  // Sessions outside the selected repo are not in `sessions`, so their
  // transition bookkeeping is deliberately separate from the sidebar's list.
  const backgroundWasRunning = useRef<Map<string, boolean>>(new Map())
  const backgroundRunningSince = useRef<Map<string, number>>(new Map())
  const [unreadRepoIds, setUnreadRepoIds] = useState<Set<string>>(new Set())
  const [transcript, setTranscript] = useState<TranscriptState>(initialState)
  const [transcriptLoading, setTranscriptLoading] = useState(false)
  const [modelSel, setModelSel] = useState<ModelSelection | null>(null)
  // Session-pinned executor selections: POST /api/model/select with a sessionId
  // pins that session only, so its display must survive global refreshes/SSE.
  const [sessionModelSel, setSessionModelSel] = useState<Record<string, ModelSelection>>({})
  const [modelRows, setModelRows] = useState<ModelRow[]>([])
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)
  const [workspace, setWorkspace] = useState("")
  const [repos, setRepos] = useState<Repo[]>([])
  const [activeRepoId, setActiveRepoId] = useState<string | null>(null)
  const [addingRepo, setAddingRepo] = useState(false)
  // Live state of the "clone from a URL" bootstrap session (null = idle).
  const [cloneStatus, setCloneStatus] = useState<CloneStatus | null>(null)
  const [cloneRootDirs, setCloneRootDirs] = useState<string[]>([])
  const [cacheGuard, setCacheGuard] = useState<{ text: string; images: { base64: string; mediaType: string }[]; approxTokens: number; reason: string; delivery?: MessageDelivery } | null>(null)
  const [foldThreads, setFoldThreads] = useState(false)
  const [terminalsOpen, setTerminalsOpen] = useState(loadTerminalsOpen)
  const [goal, setGoalState] = useState<GoalSnapshot | null>(null)
  // Server-side agent config behind the composer status rule. Null = unknown
  // (demo/offline or a failed read) and simply renders no chip.
  const [advisorStatus, setAdvisorStatus] = useState<AdvisorStatus | null>(null)
  const [sidekickConfig, setSidekickConfig] = useState<SidekickConfig | null>(null)
  const [dialog, setDialog] = useState<"rename" | "fork" | "rewind" | "goal" | "ship" | "stats" | "incognito" | null>(null)
  const [incognitoModes, setIncognitoModes] = useState<SavedMode[]>([])
  const [dialogText, setDialogText] = useState("")
  const [rewindPoints, setRewindPoints] = useState<RewindPoint[]>([])
  const [selectedRewind, setSelectedRewind] = useState<RewindPoint | null>(null)
  const [forkWorktree, setForkWorktree] = useState(false)
  const [goalWorkflows, setGoalWorkflows] = useState(false)
  const [goalTurns, setGoalTurns] = useState("")
  const [stats, setStats] = useState<{
    usage: UsageResponse | null
    usageError: string | null
    scoreboard: ScoreboardResponse | null
    scoreboardError: string | null
  } | null>(null)
  const [statsTab, setStatsTab] = useState<"usage" | "scoreboard">("usage")
  // TUI parity: bare /scoreboard is server-wide, `/scoreboard session` scopes it.
  const [scoreboardScope, setScoreboardScope] = useState<"session" | "all">("all")
  const [notice, setNotice] = useState<string | null>(null)

  // ---- Demo/mock fallback state (preserved polish) ----
  const [demoThreads, setDemoThreads] = useState<Thread[]>(THREADS)
  const [demoActiveId, setDemoActiveId] = useState(THREADS[0]!.id)
  const [demoModel, setDemoModel] = useState<Model>(MODELS[0]!)
  const [demoStreamingId, setDemoStreamingId] = useState<string | null>(null)
  const demoTimer = useRef<ReturnType<typeof setInterval> | null>(null)

  const [paletteOpen, setPaletteOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsSection, setSettingsSection] = useState<string | undefined>(undefined)
  // Dev-only: `?onboarding=1` opens the flow immediately against fixture data
  // (see devOnboardingRequested); always false in production builds.
  const [onboardingOpen, setOnboardingOpen] = useState(devOnboardingRequested)
  const [browserOpen, setBrowserOpen] = useState(false)
  // The factory shares the content-panel side region with the browser pane.
  const [factoryOpen, setFactoryOpen] = useState(false)
  // The link context menu's "Open in Chunky browser" mounts the pane; the pane
  // itself picks the URL up from the same store.
  useEffect(() => subscribeBrowserNavigation(() => setBrowserOpen(true)), [])
  // Saved modes as slash aliases ("/fire") + a signal that opens the composer's
  // model picker for `/model`.
  const [slashModes, setSlashModes] = useState<SlashCommand[]>([])
  // The same saved modes, as the composer's selector lists them, plus the
  // server's snapshot of the live pairing (what makes one of them "active").
  const [savedModes, setSavedModes] = useState<ModeInfo[]>([])
  const [currentModeSpec, setCurrentModeSpec] = useState<ModeSpec | null>(null)
  const [modelPickerSignal, setModelPickerSignal] = useState(0)
  // `/sidekick` inside a live chat edits THIS session only (Settings stays global).
  const [sidekickPickerOpen, setSidekickPickerOpen] = useState(false)

  const streamAbort = useRef<AbortController | null>(null)
  const cloneAbort = useRef<AbortController | null>(null)
  // handleSend runs before the dialog/settings actions are declared, so slash
  // dispatch is reached through a ref (same trick as the TUI's doModeRef).
  const dispatchSlashRef = useRef<(command: string) => Promise<boolean>>(async () => false)
  // Same reason for the live `mode.applied` broadcast: attachSession must keep a
  // stable identity (it seeds the boot effect), so the SSE handler can't take
  // refreshModels/refreshModes as deps — it reads them through this ref.
  const modeAppliedRef = useRef<(name: string, spec: ModeSpec) => void>(() => {})
  // Set just BEFORE this window POSTs an apply: the server broadcasts
  // mode.applied to every stream, and the local caller already shows a notice.
  const selfAppliedMode = useRef<{ name: string; at: number } | null>(null)
  const settleTimer = useRef<number | null>(null)
  const sessionIdRef = useRef<string | null>(null)
  const transcriptRef = useRef<TranscriptState>(initialState)
  const goalRef = useRef<GoalSnapshot | null>(null)
  const activeRepoIdRef = useRef<string | null>(null)
  const repoListGen = useRef(0)
  const attachGen = useRef(0)
  // Session lists are populated by both the selected-repo refresh and the
  // existing all-repo poll. Transcript projections are bounded because a
  // lengthy history can be much larger than a sidebar row.
  const repoSessionCache = useRef(new Map<string | null, SessionSummary[]>())
  const sessionCache = useRef(new SessionCache(20))
  const onboardingChecked = useRef(false)
  // Seeded from the synchronous snapshot, then replaced with the durable
  // desktop.json state once the connection boots (see the live-connect effect).
  const lastSessionByRepo = useRef<Record<string, string>>({
    ...desktopUiSnapshot().lastSessionByRepo,
  })

  sessionIdRef.current = sessionId
  transcriptRef.current = transcript
  goalRef.current = goal
  activeRepoIdRef.current = activeRepoId

  const live = appMode === "live"
  const streaming = live ? isStreaming(transcript) || sending : demoStreamingId !== null
  // Server-authoritative: the session row carries the off-the-record flag.
  const incognitoSession =
    live && sessions.find((s) => s.sessionId === sessionId)?.incognito === true

  // The CURRENT session's effective executor: its pin when it has one, else the
  // global default. One session's switch never moves another session's display.
  const effectiveModelSel = useMemo(
    () => (live && sessionId ? (sessionModelSel[sessionId] ?? modelSel) : modelSel),
    [live, sessionId, sessionModelSel, modelSel],
  )

  const uiModels = useMemo(() => {
    if (!live) return MODELS
    const list = rowsToModels(modelRows)
    return list.length > 0 ? list : [modelSelectionToUi(effectiveModelSel, modelRows)]
  }, [live, modelRows, effectiveModelSel])

  // The mode in effect, derived from the server's own `current` pairing (see
  // lib/modes) — it names the selector, and dissolves the moment the live
  // configuration stops matching any saved mode.
  const activeMode = useMemo(
    () => (live ? activeModeName(savedModes, currentModeSpec) : null),
    [live, savedModes, currentModeSpec],
  )
  const modeOptions = useMemo<ModeOption[]>(
    () =>
      live
        ? savedModes.map((m) => ({
            name: m.name,
            detail: `${prettyModel(m.model)}${m.effort ? ` (${m.effort})` : ""}`,
          }))
        : [],
    [live, savedModes],
  )

  const uiModel = useMemo(() => {
    if (!live) return demoModel
    return modelSelectionToUi(effectiveModelSel, modelRows)
  }, [live, demoModel, effectiveModelSel, modelRows])

  // ---- Demo helpers (offline fallback only) ----
  const stopDemoStream = useCallback(() => {
    if (demoTimer.current) {
      clearInterval(demoTimer.current)
      demoTimer.current = null
    }
    setDemoStreamingId(null)
  }, [])

  useEffect(() => () => stopDemoStream(), [stopDemoStream])

  const activeRepo = useMemo(
    () => repos.find((r) => r.id === activeRepoId) ?? null,
    [repos, activeRepoId],
  )

  // ---- Session list → sidebar threads (scoped to active repo in live mode) ----
  const projects: Project[] = useMemo(() => {
    if (!live) return PROJECTS
    const fromRepo = projectFromRepo(activeRepo)
    if (fromRepo) return [fromRepo]
    if (workspace) return [projectFromWorkspace(workspace)]
    return []
  }, [live, activeRepo, workspace])

  const threads: Thread[] = useMemo(() => {
    if (!live) return demoThreads
    return sessions.map((s) => {
      // Each row labels itself with ITS OWN pinned model when it has one.
      const rowSel = sessionModelSel[s.sessionId] ?? modelSel
      const t = sessionToThread(s, {
        liveBusy: s.sessionId === sessionId ? !isTreeIdle(transcript) : undefined,
        isActive: s.sessionId === sessionId,
        modelName: modelSelectionToUi(rowSel, modelRows).name,
        unread: unreadDone.has(s.sessionId) && s.sessionId !== sessionId,
      })
      // Prefer repo identity over raw workspace path for project linkage.
      if (activeRepo) t.projectId = `repo:${activeRepo.id}`
      return t
    })
  }, [
    live,
    demoThreads,
    sessions,
    sessionId,
    transcript.status,
    sessionModelSel,
    modelSel,
    modelRows,
    activeRepo,
    unreadDone,
  ])

  const repoTabUnreadIds = useMemo(() => {
    const out = new Set(unreadRepoIds)
    // The selected repo's list is already local state. Its tab is unread only
    // for another session, never merely because the selected thread completed.
    if (
      activeRepoId &&
      sessions.some((s) => unreadDone.has(s.sessionId) && s.sessionId !== sessionId)
    ) {
      out.add(activeRepoId)
    }
    return out
  }, [activeRepoId, sessions, unreadDone, unreadRepoIds, sessionId])

  const activeThread: Thread = useMemo(() => {
    if (!live) {
      return demoThreads.find((t) => t.id === demoActiveId) ?? demoThreads[0]!
    }
    const session = sessions.find((s) => s.sessionId === sessionId)
    const t = buildActiveThread(session, transcript, uiModel.name)
    if (activeRepo) t.projectId = `repo:${activeRepo.id}`
    return t
  }, [live, demoThreads, demoActiveId, sessions, sessionId, transcript, uiModel.name, activeRepo])

  const liveStreamingId = useMemo(
    () => (live ? streamingMessageId(activeThread.messages, streaming) : demoStreamingId),
    [live, activeThread.messages, streaming, demoStreamingId],
  )

  // Pre-filled clone destination: a native root (~/code, ~/Projects, …) when the
  // app can see the filesystem, else the folder holding the active repo.
  const cloneParentDefault = useMemo(
    () => defaultCloneParent(cloneRootDirs, activeRepo?.path || workspace || null),
    [cloneRootDirs, activeRepo, workspace],
  )

  // TUI-parity status rule under the composer: which mode/config is actually
  // live (executor + sidekick/advisor/goal/incognito). Demo yields one dim chip.
  const statusChips = useMemo(
    () =>
      buildComposerStatus({
        mode: live ? "live" : "demo",
        incognito: incognitoSession,
        executor: live ? effectiveModelSel : null,
        sidekick: sidekickConfig,
        advisor: advisorStatus,
        goal,
      }),
    [live, incognitoSession, effectiveModelSel, sidekickConfig, advisorStatus, goal],
  )

  // Active model's context limit for the context-window meter (undefined in demo).
  const contextLimit = useMemo(() => {
    if (!live) return undefined
    const row = modelRows.find(
      (r) => r.provider === effectiveModelSel?.provider && r.model.id === effectiveModelSel?.model,
    )
    return row?.model.contextLimit
  }, [live, modelRows, effectiveModelSel])

  // Working directory for the git panel: the active session's own workspace
  // wins, then the open repo, then the server workspace.
  const gitCwd = useMemo(() => {
    if (!live) return undefined
    const sessionWorkspace = sessions.find((s) => s.sessionId === sessionId)?.workspace
    return sessionWorkspace || activeRepo?.path || workspace || config?.workspace || undefined
  }, [live, sessions, sessionId, activeRepo, workspace, config])

  // Session-scoped rich data lives on TranscriptState (auto-resets on switch).
  const liveTodos = live ? transcript.todos : []
  const liveUsage = live ? transcript.usage : null
  const liveCompacted = live ? transcript.compacted : 0
  const liveQueue = live ? transcript.queue.entries : []

  /** Read the global default AND (when given) a session's EFFECTIVE selection,
   *  so pins survive an app reload and pins made in the TUI/another window show
   *  up here. The session entry is kept only when it differs from the global
   *  default — an unpinned session keeps tracking the global (which the 15s
   *  poll refreshes) instead of freezing at load-time state. */
  const hydrateSessionModel = useCallback(async (baseUrl: string, id: string | null) => {
    const [globalSel, sessionSel] = await Promise.all([
      fetchModel(baseUrl),
      id ? fetchModel(baseUrl, id) : Promise.resolve(null),
    ])
    if (globalSel) setModelSel(globalSel)
    if (!id || !sessionSel) return
    setSessionModelSel((prev) => {
      if (sameSelection(globalSel, sessionSel)) {
        if (!(id in prev)) return prev
        const next = { ...prev }
        delete next[id]
        return next
      }
      if (sameSelection(prev[id] ?? null, sessionSel)) return prev
      return { ...prev, [id]: sessionSel }
    })
  }, [])

  // ---- Live: refresh sessions for a repo (generation-guarded against tab races) ----
  const refreshSessions = useCallback(
    async (baseUrl: string, repoId: string | null = activeRepoIdRef.current) => {
      const gen = ++repoListGen.current
      const list = await listSessions(baseUrl, repoId)
      if (gen !== repoListGen.current) return list
      repoSessionCache.current.set(repoId, list)
      sessionCache.current.reconcileRepo(repoId, new Set(list.map((session) => session.sessionId)))
      // Only apply if still viewing this repo (or boot with matching ref).
      if (repoId != null && repoId !== activeRepoIdRef.current) return list
      setSessions(list)
      return list
    },
    [],
  )

  // ---- Live: attach SSE (abort on switch, reconcile cached projection with full replay) ----
  const attachSession = useCallback(async (baseUrl: string, id: string, opts?: { fresh?: boolean }) => {
    const previousId = sessionIdRef.current
    if (previousId) {
      sessionCache.current.set(previousId, {
        transcript: transcriptRef.current,
        goal: goalRef.current,
        repoId: activeRepoIdRef.current,
        events: sessionCache.current.get(previousId)?.events ?? [],
      })
    }
    streamAbort.current?.abort()
    const ac = new AbortController()
    streamAbort.current = ac
    const gen = ++attachGen.current

    setSessionId(id)
    // Pins are server state: read this session's effective executor on attach.
    void hydrateSessionModel(baseUrl, id)
    void getGoal(baseUrl, id).then((nextGoal) => {
      if (gen !== attachGen.current) return
      goalRef.current = nextGoal
      setGoalState(nextGoal)
      sessionCache.current.update(id, { goal: nextGoal })
    }).catch(() => {})
    const repoForSession = activeRepoIdRef.current
    if (repoForSession) {
      lastSessionByRepo.current[repoForSession] = id
      rememberLastSession(repoForSession, id)
    }
    const cached = sessionCache.current.get(id)
    let replayIndex = 0
    let replayMatched = !cached
    let shadowEvents: Parameters<typeof reduce>[1][] | null = null
    let shadowSettleTimer: number | null = null
    const clearShadowSettle = () => {
      if (shadowSettleTimer != null) window.clearTimeout(shadowSettleTimer)
      shadowSettleTimer = null
    }
    const finishShadowReplay = () => {
      clearShadowSettle()
      if (!shadowEvents || gen !== attachGen.current) return
      const rebuilt = rebuildTranscript(shadowEvents)
      const rebuiltEvents = shadowEvents.filter(isPersistedSessionEvent)
      shadowEvents = null
      replayMatched = true
      setTranscript(rebuilt)
      sessionCache.current.set(id, {
        transcript: rebuilt,
        goal: goalRef.current,
        repoId: activeRepoIdRef.current,
        events: rebuiltEvents,
      })
    }
    const scheduleShadowSettle = () => {
      clearShadowSettle()
      shadowSettleTimer = window.setTimeout(finishShadowReplay, REPLAY_SETTLE_MS)
    }
    const rememberEvent = (event: Parameters<typeof reduce>[1], nextTranscript = transcriptRef.current) => {
      sessionCache.current.remember(id, nextTranscript, goalRef.current, activeRepoIdRef.current, event)
    }
    setTranscript(cached?.transcript ?? initialState)
    setGoalState(cached?.goal ?? null)
    if (!cached) sessionCache.current.set(id, { transcript: initialState, goal: null, repoId: activeRepoIdRef.current, events: [] })
    // A just-created session has no history to replay — don't flash the
    // "Replaying session history…" state while its stream connects.
    setTranscriptLoading(!opts?.fresh && !cached)
    setSendError(null)
    setConnError(null)

    const onOpen = () => {
      if (gen !== attachGen.current) return
      setConnectionState("connected")
      setAppMode("live")
      if (settleTimer.current != null) clearTimeout(settleTimer.current)
      settleTimer.current = window.setTimeout(() => {
        settleTimer.current = null
        if (!ac.signal.aborted && gen === attachGen.current) setTranscriptLoading(false)
      }, REPLAY_SETTLE_MS)
    }

    let attempt = 0
    const onEvent = (ev: Parameters<typeof reduce>[1]) => {
      if (gen !== attachGen.current) return
      attempt = 0
      // The server always sends history from event zero and exposes no replay
      // boundary/cursor. Silently discard the cached persisted prefix; the
      // first new event is reduced onto the projection already on screen.
      if (cached && replayIndex < cached.events.length && JSON.stringify(ev) === JSON.stringify(cached.events[replayIndex])) {
        replayIndex += 1
        if (replayIndex === cached.events.length) replayMatched = true
        return
      }
      // Any prefix disagreement means the cache cannot safely be extended. Do
      // a complete projection rebuild off-screen, retaining the old transcript
      // until the replay burst settles, then swap once without duplicates.
      if (cached && !replayMatched && !shadowEvents) shadowEvents = cached.events.slice(0, replayIndex)
      if (shadowEvents) {
        shadowEvents.push(ev)
        scheduleShadowSettle()
        return
      }
      // These arrive only on the live stream, never in Store.history. They
      // must update the visible/cache projection but must not contaminate a
      // shadow rebuild of persisted history.
      if (!isPersistedSessionEvent(ev)) {
        if (ev.type === "session.rewound") {
          sessionCache.current.delete(id)
          void attachSession(baseUrl, id)
          return
        }
        if (ev.type === "mode.applied") {
          rememberEvent(ev)
          modeAppliedRef.current(ev.name, ev.spec)
          return
        }
        if (consumeAppOpenUrl(ev)) { rememberEvent(ev); return }
        setTranscript((s) => {
          const next = reduce(s, ev)
          rememberEvent(ev, next)
          return next
        })
        return
      }
      // Live-only broadcast (never persisted, never a transcript item): another
      // window/the TUI applied a mode, so re-read the model + alias state here.
      // The agent asking for our browser pane. Also live-only: claimed here and
      // never reduced, so it cannot become a rendered transcript item. Only
      // http(s) actually opens the pane — openInAppBrowser owns that rule.
      setTranscript((s) => {
        const next = reduce(s, ev)
        rememberEvent(ev, next)
        return next
      })
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
        finishShadowReplay()
        setConnectionState("reconnecting")
        attempt += 1
        await sleep(reconnectDelay(attempt - 1), ac.signal)
        if (await handOverToReplacement()) return
      } catch (err) {
        if (isIntentionalAbort(err, ac.signal) || gen !== attachGen.current) return
        attempt += 1
        setConnectionState("reconnecting")
        setTranscriptLoading(false)
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
      replayIndex = 0
      replayMatched = !cached
      shadowEvents = null
    }
  }, [refreshSessions, hydrateSessionModel])

  /** Load sessions for a repo and attach last/newest/created session. */
  const openRepoThreads = useCallback(
    async (baseUrl: string, repoId: string | null) => {
      const list = await refreshSessions(baseUrl, repoId)
      if (repoId != null && repoId !== activeRepoIdRef.current) return

      const remembered = repoId ? lastSessionByRepo.current[repoId] : undefined
      const pick =
        (remembered && list.find((s) => s.sessionId === remembered)?.sessionId) ||
        list[0]?.sessionId

      if (pick) {
        void attachSession(baseUrl, pick)
        return
      }

      try {
        const created = await createSession(baseUrl, repoId)
        if (repoId != null && repoId !== activeRepoIdRef.current) return
        await refreshSessions(baseUrl, repoId)
        void attachSession(baseUrl, created.sessionId)
      } catch (err) {
        setTranscriptLoading(false)
        setConnError(`Can't create a session: ${(err as Error).message}`)
        setConnectionState("error")
      }
    },
    [attachSession, refreshSessions],
  )

  /**
   * Resolve the server again and reattach to whatever is serving this workspace
   * now. Shared by the two "the server moved" signals: the retiring probe below
   * and Bun's announcement after it replaces the installed runtime. Returns
   * false when nothing changed, so callers can fall back to their own retrying.
   */
  const moveToResolvedServer = useCallback(async (): Promise<boolean> => {
    if (appMode !== "live") return false
    const next = await reresolveConnection()
    if (!next?.baseUrl || next.baseUrl === config?.baseUrl) return false
    setConfig(next)
    setConnectionState("reconnecting")
    const sessionId = sessionIdRef.current
    if (sessionId) void attachSession(next.baseUrl, sessionId)
    else void openRepoThreads(next.baseUrl, activeRepoIdRef.current)
    return true
  }, [appMode, config, attachSession, openRepoThreads])

  // ---- Boot ----
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const cfg = await loadConfig()
      if (cancelled) return
      setConfig(cfg)

      if (cfg.connectionError) {
        setConnectionState("offline")
        setConnError(cfg.connectionError)
        return
      }

      try {
        const [info, reg, sel, rows] = await Promise.all([
          fetchServerInfo(cfg.baseUrl),
          listRepos(cfg.baseUrl).catch(() => null),
          fetchModel(cfg.baseUrl),
          listAllModels(cfg.baseUrl).catch(() => [] as ModelRow[]),
        ])
        if (cancelled) return

        setWorkspace(info.workspace || cfg.workspace || "")
        setModelSel(sel)
        setModelRows(rows)
        setConnectionState("connected")
        setAppMode("live")
        setConnError(null)

        // Durable UI state (open tab + per-tab thread) lives in desktop.json,
        // not in the webview's storage, so it survives updates/reinstalls.
        const ui = await loadDesktopUiState()
        if (cancelled) return
        lastSessionByRepo.current = { ...ui.lastSessionByRepo }

        let repoId: string | null = null
        if (reg) {
          const remembered = ui.activeRepoId
          repoId =
            (remembered && reg.repos.some((r) => r.id === remembered) ? remembered : null) ??
            reg.activeId ??
            reg.repos[0]?.id ??
            null
          setRepos(reg.repos)
          setActiveRepoId(repoId)
          activeRepoIdRef.current = repoId
        }

        await openRepoThreads(cfg.baseUrl, repoId)
      } catch (err) {
        if (cancelled) return
        setConnectionState("offline")
        setConnError(
          `Can't reach Chunky server at ${cfg.baseUrl}. (${(err as Error).message})`,
        )
      }
    })()
    return () => {
      cancelled = true
      streamAbort.current?.abort()
      if (settleTimer.current != null) clearTimeout(settleTimer.current)
    }
  }, [openRepoThreads])

  /**
   * Tell the server how to drive our browser pane. The endpoint lives in the
   * server's memory and dies with it, so every (re)connect has to re-announce;
   * losing the connection clears the memo so the next connect actually posts.
   * Demo/offline and the browser-only dev build never announce (no live server,
   * and no native pane to drive).
   */
  useEffect(() => {
    if (!config) return
    if (appMode === "live" && connectionState === "connected") {
      void announceAppBrowserTarget(config.baseUrl)
      // Same lifetime, same rules: the zoo board's local service has to be
      // re-announced on every connect for the zoo_* tools to exist.
      void announceAppZooTarget(config.baseUrl)
    } else {
      resetAppBrowserAnnounce()
      resetAppZooAnnounce()
    }
  }, [config, appMode, connectionState])

  // Poll model selection lightly so external changes show up.
  useEffect(() => {
    if (!config || appMode !== "live") return
    const t = setInterval(() => {
      void fetchModel(config.baseUrl).then((m) => m && setModelSel(m))
    }, 15_000)
    return () => clearInterval(t)
  }, [config, appMode])

  // Poll the selected repo for the sidebar, and the others for completion
  // badges. Only the attached session has an SSE stream of its own.
  useEffect(() => {
    if (!config || appMode !== "live" || connectionState !== "connected") return
    const refreshAllRepos = () => {
      void refreshSessions(config.baseUrl).catch(() => {})
      const otherRepos = repos.filter((repo) => repo.id !== activeRepoIdRef.current)
      void Promise.all(
        otherRepos.map(async (repo) => {
          try {
            const list = await listSessions(config.baseUrl, repo.id)
            if (appMode !== "live" || connectionState !== "connected") return null
            repoSessionCache.current.set(repo.id, list)
            sessionCache.current.reconcileRepo(repo.id, new Set(list.map((session) => session.sessionId)))

            const now = Date.now()
            let completed = false
            const next = new Map(backgroundWasRunning.current)
            for (const session of list) {
              const key = `${repo.id}:${session.sessionId}`
              const wasRunning = backgroundWasRunning.current.get(key)
              if (session.busy ?? session.running) {
                if (!wasRunning) backgroundRunningSince.current.set(key, now)
              } else if (wasRunning) {
                const since = backgroundRunningSince.current.get(key)
                backgroundRunningSince.current.delete(key)
                if (since != null && now - since >= MIN_COMPLETION_NOTIFY_MS) completed = true
              }
              next.set(key, !!(session.busy ?? session.running))
            }
            backgroundWasRunning.current = next
            return completed ? repo.id : null
          } catch {
            // A stale/unavailable repo must not block the remaining polls.
            return null
          }
        }),
      ).then((completedRepoIds) => {
        const ids = completedRepoIds.filter((id): id is string => id != null)
        if (ids.length === 0) return
        setUnreadRepoIds((prev) => {
          const next = new Set(prev)
          for (const id of ids) next.add(id)
          return next
        })
        // A batch may contain several completed sessions/repos, but gets one horn.
        playCompletionHorn()
      })
    }
    /** Proactive handover: a server that is draining after an update will stop
     *  serving shortly, so move to its replacement BEFORE the stream drops
     *  rather than after. Advisory — a failure just leaves the reconnect loop
     *  to notice the hard way. */
    const checkRetirement = () => {
      void fetchServerRetiring(config.baseUrl).then(async (retiring) => {
        if (!retiring || appMode !== "live") return
        await moveToResolvedServer()
      }).catch(() => {})
    }

    refreshAllRepos()
    checkRetirement()
    const t = setInterval(() => {
      refreshAllRepos()
      checkRetirement()
    }, 5_000)
    return () => clearInterval(t)
  }, [config, appMode, connectionState, refreshSessions, repos, moveToResolvedServer])

  // Bun replaced the installed Chunky server and resolved a new one; reattach
  // to it. The superseded server is draining, so this is a handover, not a loss.
  useEffect(() => {
    if (appMode !== "live") return
    return subscribeServerChanged(() => {
      void moveToResolvedServer()
    })
  }, [appMode, moveToResolvedServer])

  // A transition is meaningful only after this connected renderer observed the
  // running state. That avoids replay/initial-load notifications and dots.
  useEffect(() => {
    if (appMode !== "live" || connectionState !== "connected") {
      wasRunning.current.clear()
      runningSince.current.clear()
      backgroundWasRunning.current.clear()
      backgroundRunningSince.current.clear()
      return
    }
    const next = new Map<string, boolean>()
    const newlyDone: string[] = []
    let completed = false
    const now = Date.now()
    for (const s of sessions) {
      const isRunning =
        s.sessionId === sessionId ? !isTreeIdle(transcript) : !!(s.busy ?? s.running)
      const previous = wasRunning.current.get(s.sessionId)
      if (isRunning && !previous) runningSince.current.set(s.sessionId, now)
      if (previous && !isRunning) {
        const since = runningSince.current.get(s.sessionId)
        runningSince.current.delete(s.sessionId)
        const qualifies = since != null && now - since >= MIN_COMPLETION_NOTIFY_MS
        if (qualifies) completed = true
        if (qualifies && s.sessionId !== sessionId) newlyDone.push(s.sessionId)
      }
      next.set(s.sessionId, isRunning)
    }
    wasRunning.current = next
    if (completed) playCompletionHorn()
    setUnreadDone((prev) => {
      let changed = false
      const out = new Set(prev)
      for (const id of newlyDone) if (!out.has(id)) { out.add(id); changed = true }
      if (sessionId && out.has(sessionId)) { out.delete(sessionId); changed = true }
      return changed ? out : prev
    })
  }, [sessions, sessionId, transcript.status, appMode, connectionState])

  // Only ask a reachable live server once per app lifetime. Demo/offline mode
  // never touches onboarding endpoints.
  useEffect(() => {
    if (!config || appMode !== "live" || connectionState !== "connected" || onboardingChecked.current) return
    onboardingChecked.current = true
    void needsOnboarding().then((needed) => {
      if (needed) setOnboardingOpen(true)
    })
  }, [config, appMode, connectionState])

  /** Refresh current selection + full provider catalogs (picker open / retry). */
  const refreshModels = useCallback(async () => {
    if (!config || appMode !== "live") return
    const [rows] = await Promise.all([
      listAllModels(config.baseUrl),
      hydrateSessionModel(config.baseUrl, sessionIdRef.current),
    ])
    setModelRows(rows)
  }, [config, appMode, hydrateSessionModel])

  /** Advisor + sidekick config for the composer status rule. The sidekick read
   *  is SESSION-SCOPED (effective = per-session override over the global
   *  default) so another session's change never rewrites this one's chip.
   *  Demo/offline never touches the server, and a failed read degrades to
   *  "no chip" (never noise). */
  const refreshAgents = useCallback(async () => {
    if (appMode !== "live") {
      setAdvisorStatus(null)
      setSidekickConfig(null)
      return
    }
    const sid = sessionId
    const [advisor, sidekick] = await Promise.all([
      getAdvisorStatus().catch(() => null),
      getSidekick(sid).catch(() => null),
    ])
    // A session switch can land mid-flight; drop a stale session's answer.
    if (sid !== sessionIdRef.current) return
    setAdvisorStatus(advisor)
    setSidekickConfig(sidekick)
  }, [appMode, sessionId])

  /** Saved modes → slash aliases. Demo/offline never touches the server. */
  const refreshModes = useCallback(async () => {
    if (appMode !== "live") {
      setSlashModes([])
      setSavedModes([])
      setCurrentModeSpec(null)
      return
    }
    try {
      const { modes, current } = await getModes()
      setSlashModes(modeCommands(modes, (m) => `Apply mode: ${prettyModel(m.model)}`))
      setSavedModes(modes)
      setCurrentModeSpec(current ?? null)
    } catch {
      /* keep the last known aliases; the menu is a convenience, not state */
    }
  }, [appMode])

  useEffect(() => {
    if (appMode !== "live") {
      setSlashModes([])
      setSavedModes([])
      setCurrentModeSpec(null)
      return
    }
    if (connectionState !== "connected") return
    void refreshModes()
    void refreshAgents()
  }, [appMode, connectionState, refreshModes, refreshAgents])

  const slashCommands = useMemo<SlashCommand[]>(() => [...COMMANDS, ...slashModes], [slashModes])

  /** Remember that THIS window is about to apply `name`, so the echoed
   *  mode.applied broadcast doesn't double up on the caller's own notice. */
  const markSelfApplied = useCallback((name: string) => {
    selfAppliedMode.current = { name: name.toLowerCase(), at: Date.now() }
  }, [])

  /** Server said a mode was applied on this session's stream (this window, the
   *  TUI, or another app window): re-read models + aliases, then notice once. */
  const handleModeApplied = useCallback(
    (name: string, spec: ModeSpec) => {
      void refreshModels()
      void refreshModes()
      void refreshAgents()
      const self = selfAppliedMode.current
      if (self && self.name === name.toLowerCase() && Date.now() - self.at < SELF_APPLY_WINDOW_MS) {
        selfAppliedMode.current = null
        return
      }
      const detail = spec?.model
        ? `: ${prettyModel(spec.model)}${spec.effort ? ` (${spec.effort})` : ""}`
        : ""
      setNotice(`Mode "${name}" applied${detail}`)
    },
    [refreshModels, refreshModes, refreshAgents],
  )
  modeAppliedRef.current = handleModeApplied

  // ---- Actions ----
  const handleNewThread = useCallback(async () => {
    if (!live) {
      stopDemoStream()
      const t: Thread = {
        id: `demo-${Date.now()}`,
        projectId: activeThread.projectId,
        title: "New thread",
        updated: "now",
        preview: "Start a new conversation…",
        status: { kind: "idle", ago: "now" },
        branch: "main",
        messages: [],
      }
      setDemoThreads((prev) => [t, ...prev])
      setDemoActiveId(t.id)
      return
    }
    if (!config) return
    const repoId = activeRepoIdRef.current
    try {
      const created = await createSession(config.baseUrl, repoId)
      if (repoId != null && repoId !== activeRepoIdRef.current) return
      // Attach right away; the sidebar list can catch up in the background.
      void attachSession(config.baseUrl, created.sessionId, { fresh: true })
      void refreshSessions(config.baseUrl, repoId).catch(() => {})
    } catch (err) {
      setConnError((err as Error).message)
    }
  }, [live, stopDemoStream, activeThread.projectId, config, refreshSessions, attachSession])

  const handleSelectRepo = useCallback(
    async (id: string) => {
      if (!config || id === activeRepoIdRef.current) return
      setUnreadRepoIds((prev) => {
        if (!prev.has(id)) return prev
        const next = new Set(prev)
        next.delete(id)
        return next
      })
      const prefix = `${id}:`
      for (const key of backgroundWasRunning.current.keys()) {
        if (key.startsWith(prefix)) backgroundWasRunning.current.delete(key)
      }
      for (const key of backgroundRunningSince.current.keys()) {
        if (key.startsWith(prefix)) backgroundRunningSince.current.delete(key)
      }
      setActiveRepoId(id)
      activeRepoIdRef.current = id
      rememberActiveRepo(id)
      // Drop current stream before loading the other repo's threads.
      streamAbort.current?.abort()
      const cached = repoSessionCache.current.get(id)
      setSessions(cached ?? [])
      setSessionId(null)
      setTranscript(initialState)
      setTranscriptLoading(!cached)
      // Pick from cached rows now; fetch/reconcile happens in the background.
      const remembered = lastSessionByRepo.current[id]
      const pick = (remembered && cached?.find((s) => s.sessionId === remembered)?.sessionId) || cached?.[0]?.sessionId
      if (pick) {
        void attachSession(config.baseUrl, pick)
        void refreshSessions(config.baseUrl, id).catch(() => {})
      } else {
        void openRepoThreads(config.baseUrl, id)
      }
    },
    [config, openRepoThreads, attachSession, refreshSessions],
  )

  const handleAddRepo = useCallback(
    async (path: string) => {
      if (!config) throw new Error("Not connected")
      setAddingRepo(true)
      try {
        const reg = await addRepo(config.baseUrl, path)
        setRepos(reg.repos)
        const openId = reg.activeId ?? reg.repos[reg.repos.length - 1]?.id ?? null
        setActiveRepoId(openId)
        activeRepoIdRef.current = openId
        rememberActiveRepo(openId)
        streamAbort.current?.abort()
        setSessions([])
        setSessionId(null)
        setTranscript(initialState)
        setTranscriptLoading(true)
        await openRepoThreads(config.baseUrl, openId)
      } finally {
        setAddingRepo(false)
      }
    },
    [config, openRepoThreads],
  )

  /** Bounded destination roots for the clone form (native only; harmless empty
   *  in the browser build, where the fallback is the active repo's parent). */
  useEffect(() => {
    void cloneRoots().then(setCloneRootDirs).catch(() => setCloneRootDirs([]))
  }, [])

  useEffect(() => () => cloneAbort.current?.abort(), [])

  /**
   * "Add repo from a git URL": spin up a throwaway BOOTSTRAP session pinned to
   * the destination folder, give it a clone goal, and stream its work into the
   * popover. Registration stays here — the agent's shell has no server
   * credentials — so on completion we resolve the path and run the normal
   * addRepo flow, which also switches the UI to the new repo.
   */
  const handleCloneRepo = useCallback(
    async (rawUrl: string, rawParent: string) => {
      if (!config || appMode !== "live") throw new Error("Connect to the server to clone a repository.")
      const parsed = parseGitUrl(rawUrl)
      if (!parsed) throw new Error("That doesn't look like a git URL.")
      const parentDir = rawParent.trim().replace(/\/+$/, "")
      if (!parentDir.startsWith("/")) throw new Error("Enter an absolute destination folder.")

      cloneAbort.current?.abort()
      const ac = new AbortController()
      cloneAbort.current = ac
      const push = (line: string) =>
        setCloneStatus((prev) =>
          prev ? { ...prev, lines: [...prev.lines, line].slice(-CLONE_LOG_LINES) } : prev,
        )
      setCloneStatus({
        phase: "running",
        url: parsed.url,
        sessionId: null,
        lines: [`◎ Starting an agent in ${parentDir}…`],
        error: null,
      })

      let lastMessage = ""
      try {
        const run = await runCloneSession(
          config.baseUrl,
          { url: parsed.url, parentDir, leaf: parsed.leaf },
          {
            onSession: (id) => setCloneStatus((prev) => (prev ? { ...prev, sessionId: id } : prev)),
            onProgress: push,
          },
          ac.signal,
        )
        if (ac.signal.aborted) return
        lastMessage = run.lastMessage
        // The agent is asked to print the absolute path; fall back to the
        // conventional destination. addRepo validates existence either way.
        const path =
          extractClonePath(run.text, { parentDir, leaf: parsed.leaf }) ??
          joinPath(parentDir, parsed.leaf)
        setCloneStatus((prev) =>
          prev
            ? {
                ...prev,
                phase: "registering",
                lines: [...prev.lines, `◎ Registering ${path}…`].slice(-CLONE_LOG_LINES),
              }
            : prev,
        )
        await handleAddRepo(path)
        setCloneStatus(null)
      } catch (err) {
        if (ac.signal.aborted) return
        const detail = (err as Error).message || "The clone didn't finish."
        setCloneStatus((prev) =>
          prev ? { ...prev, phase: "error", error: detail, agentMessage: lastMessage } : prev,
        )
        throw new Error(detail)
      } finally {
        if (cloneAbort.current === ac) cloneAbort.current = null
      }
    },
    [config, appMode, handleAddRepo],
  )

  const handleCancelClone = useCallback(() => {
    cloneAbort.current?.abort()
    cloneAbort.current = null
    setCloneStatus(null)
  }, [])

  /** "View thread": attach the main transcript to the bootstrap session so the
   *  user can watch the clone in the normal chat surface. */
  const handleViewCloneThread = useCallback(
    (id: string) => {
      if (!config) return
      void attachSession(config.baseUrl, id)
    },
    [config, attachSession],
  )

  const handleRemoveRepo = useCallback(
    async (id: string) => {
      if (!config) return
      const repo = repos.find((r) => r.id === id)
      const ok = await confirm({
        title: `Remove ${repo?.name ?? "this repo"} from the list?`,
        body: "This only unregisters the folder in Chunky — files and threads on disk stay put. You can add it back any time.",
        confirmLabel: "Remove",
        destructive: true,
      })
      if (!ok) return
      try {
        const wasOpen = id === activeRepoIdRef.current
        const reg = await removeRepo(config.baseUrl, id)
        setRepos(reg.repos)
        delete lastSessionByRepo.current[id]
        forgetRepoSessions(id)
        if (wasOpen) {
          const openId = reg.activeId ?? reg.repos[0]?.id ?? null
          setActiveRepoId(openId)
          activeRepoIdRef.current = openId
          rememberActiveRepo(openId)
          streamAbort.current?.abort()
          setSessions([])
          setSessionId(null)
          setTranscript(initialState)
          setTranscriptLoading(true)
          await openRepoThreads(config.baseUrl, openId)
        }
      } catch (err) {
        setConnError((err as Error).message)
      }
    },
    [config, repos, openRepoThreads],
  )

  const handleSelectThread = useCallback(
    (id: string) => {
      if (!live) {
        stopDemoStream()
        setDemoActiveId(id)
        return
      }
      if (!config || id === sessionId) return
      void attachSession(config.baseUrl, id)
    },
    [live, stopDemoStream, config, sessionId, attachSession],
  )

  const handleSend = useCallback(
    async (
      text: string,
      opts: {
        delivery?: MessageDelivery
        images?: { base64: string; mediaType: string }[]
      } = {},
    ) => {
      setSendError(null)
      // Slash commands dispatch instead of sending; unknown ones fall through
      // and are sent as ordinary chat text (TUI parity).
      const command = text.trim()
      if (command.startsWith("/") && (await dispatchSlashRef.current(command))) return
      if (!live) {
        // Minimal demo echo so offline mode still feels alive.
        stopDemoStream()
        const userId = `du-${Date.now()}`
        const asstId = `da-${Date.now()}`
        setDemoThreads((prev) =>
          prev.map((t) =>
            t.id === demoActiveId
              ? {
                  ...t,
                  title: t.messages.length === 0 ? text.slice(0, 40) : t.title,
                  updated: "now",
                  preview: text,
                  messages: [
                    ...t.messages,
                    { id: userId, role: "user", blocks: [{ type: "text", content: text }] },
                    {
                      id: asstId,
                      role: "assistant",
                      model: demoModel.name,
                      blocks: [
                        {
                          type: "text",
                          content: `*(Demo mode — server offline.)*\n\nYou said: “${text.slice(0, 200)}${text.length > 200 ? "…" : ""}”`,
                        },
                      ],
                    },
                  ],
                }
              : t,
          ),
        )
        setDemoStreamingId(asstId)
        setTimeout(() => setDemoStreamingId(null), 400)
        return
      }

      if (!config || !sessionId) {
        setSendError("No active session.")
        return
      }
      setSending(true)
      try {
        const blocked = await sendMessage(config.baseUrl, sessionId, text, opts)
        if (blocked?.blocked === "cache-cold") {
          // Explicit confirm bar in the Composer (no silent force-resend).
          setCacheGuard({ text, images: opts.images ?? [], approxTokens: blocked.warning.approxTokens, reason: blocked.warning.reason, delivery: opts.delivery })
        }
        // Refresh session list so title/activity update soon.
        void refreshSessions(config.baseUrl, activeRepoIdRef.current).catch(() => {})
      } catch (err) {
        if (err instanceof QueueFullError) {
          setSendError(err.message)
        } else {
          setSendError((err as Error).message)
        }
      } finally {
        setSending(false)
      }
    },
    [live, stopDemoStream, demoActiveId, demoModel.name, config, sessionId, refreshSessions],
  )

  const handleStop = useCallback(() => {
    if (!live) {
      stopDemoStream()
      return
    }
    if (!config || !sessionId) return
    void interruptSession(config.baseUrl, sessionId)
  }, [live, stopDemoStream, config, sessionId])

  /** Usage (session-scoped) + scoreboard (session or server-wide), settled
   *  independently so one endpoint failing still renders the other. */
  const loadStats = useCallback(
    async (scope: "session" | "all") => {
      if (!config || !sessionId) return
      const [usage, scoreboard] = await Promise.allSettled([
        getUsage(config.baseUrl, sessionId),
        getScoreboard(config.baseUrl, scope === "session" ? sessionId : undefined),
      ])
      setStats({
        usage: usage.status === "fulfilled" ? asUsage(usage.value) : null,
        usageError: usage.status === "rejected" ? (usage.reason as Error).message : null,
        scoreboard: scoreboard.status === "fulfilled" ? asScoreboard(scoreboard.value) : null,
        scoreboardError: scoreboard.status === "rejected" ? (scoreboard.reason as Error).message : null,
      })
    },
    [config, sessionId],
  )

  const openStats = useCallback(
    async (tab: "usage" | "scoreboard", scope: "session" | "all") => {
      if (!live || !config || !sessionId) return
      setStatsTab(tab)
      setScoreboardScope(scope)
      setStats(null)
      setDialog("stats")
      await loadStats(scope)
    },
    [live, config, sessionId, loadStats],
  )

  const openDialog = useCallback(async (kind: NonNullable<typeof dialog>) => {
    if (!live || !config || !sessionId) return
    if (kind === "stats") {
      await openStats("usage", "all")
      return
    }
    setDialogText(kind === "rename" ? (sessions.find((s) => s.sessionId === sessionId)?.title ?? "") : "")
    setSelectedRewind(null)
    if (kind === "rewind") setRewindPoints(await getRewindPoints(config.baseUrl, sessionId).catch(() => []))
    setDialog(kind)
  }, [live, config, sessionId, sessions, openStats])

  const runDialog = useCallback(async () => {
    if (!config || !sessionId || !dialog) return
    try {
      if (dialog === "rename") { await renameSession(config.baseUrl, sessionId, dialogText.trim()); await refreshSessions(config.baseUrl); }
      if (dialog === "fork") { sessionCache.current.delete(sessionId); const fork = await forkSession(config.baseUrl, sessionId, { worktree: forkWorktree, directive: dialogText.trim() || undefined }); setNotice(`Forked a new session${fork.worktree ? ` in ${fork.worktree.branch}` : ""}.`); await refreshSessions(config.baseUrl) }
      if (dialog === "rewind" && selectedRewind) { await rewindSession(config.baseUrl, sessionId, selectedRewind.turn); setNotice(`Restoring turn ${selectedRewind.turn}…`) }
      if (dialog === "goal") { const maxTurns = Number(goalTurns); setGoalState(await setGoal(config.baseUrl, sessionId, { objective: dialogText.trim(), mode: goalWorkflows ? "workflows" : "direct", ...(Number.isFinite(maxTurns) && maxTurns > 0 ? { maxTurns } : {}) })) }
      if (dialog === "ship") { await shipSession(config.baseUrl, sessionId, dialogText.trim() || undefined); setNotice("Ship it started — Chunky is preparing a handoff session.") }
      setDialog(null)
    } catch (err) { setSendError((err as Error).message) }
  }, [config, sessionId, dialog, dialogText, forkWorktree, selectedRewind, goalTurns, goalWorkflows, refreshSessions])

  const goalAction = useCallback(async (action: "pause" | "resume" | "clear") => {
    if (!config || !sessionId) return
    setGoalState(await setGoal(config.baseUrl, sessionId, { action }).catch(() => goal))
  }, [config, sessionId, goal])

  const openSettingsAt = useCallback((section?: string) => {
    setSettingsSection(section)
    setSettingsOpen(true)
  }, [])

  /** Apply a saved mode server-side, then re-read the model/provider UI state. */
  const applyModeByName = useCallback(
    async (name: string) => {
      try {
        markSelfApplied(name)
        const applied = await applyMode(name)
        await refreshModels()
        void refreshModes()
        void refreshAgents()
        const detail = applied?.model
          ? `: ${prettyModel(applied.model)}${applied.effort ? ` (${applied.effort})` : ""} · ${applied.provider}`
          : ""
        setNotice(`Mode "${applied?.applied || name}" applied${detail}.`)
      } catch (err) {
        setNotice(`Mode "${name}": ${(err as Error).message}`)
      }
    },
    [refreshModels, refreshModes, refreshAgents, markSelfApplied],
  )

  /** Steer a queued message into the running turn. The server's promote route
   *  claims the entry atomically, so the only client-side job is the fallback
   *  when it no longer has it (see lib/queueActions) — which is why the chip's
   *  own text is passed down: a server that lost its queue still can't swallow
   *  what the user typed. Throwing keeps the chip on screen with the reason. */
  const handleQueueSteer = useCallback(
    async (entry: QueueEntry) => {
      if (!config || !sessionId) throw new Error("Not connected to the Chunky server.")
      const { followUp } = await steerQueuedMessage(
        config.baseUrl,
        sessionId,
        entry.id,
        entry.shown || entry.text,
      )
      return followUpNotice(followUp)
    },
    [config, sessionId],
  )

  /** Drop a queued message. A 404 means the drainer already claimed it, which
   *  the helper reports as `removed: false`; queue.changed repaints either way. */
  const handleQueueDelete = useCallback(
    async (entry: QueueEntry) => {
      if (!config || !sessionId) throw new Error("Not connected to the Chunky server.")
      await deleteQueueEntry(config.baseUrl, sessionId, entry.id)
    },
    [config, sessionId],
  )

  /** Persist an edited mode spec from the composer's per-mode flyout.
   *  The caller hands over the WHOLE spec (lib/modeSlots spreads the original,
   *  so `incognito` and any undeclared field round-trip), and the server's POST
   *  replaces the stored mode under its canonical name. Editing the mode that's
   *  in effect re-applies it, otherwise the change would sit dormant.
   *  Throws on failure so the flyout can show the reason inline. */
  const handleSaveModeSpec = useCallback(
    async (name: string, spec: ModeSpec) => {
      const next = await saveMode({ name, spec })
      setSavedModes(next.modes)
      setCurrentModeSpec(next.current ?? null)
      setSlashModes(modeCommands(next.modes, (m) => `Apply mode: ${prettyModel(m.model)}`))
      if (activeMode && activeMode.toLowerCase() === name.toLowerCase()) {
        await applyModeByName(name)
        return
      }
      setNotice(`Mode "${name}" updated.`)
    },
    [activeMode, applyModeByName],
  )

  /** `/mode` subcommands: bare opens Settings → Modes, save/rm hit the server. */
  const runModeCommand = useCallback(
    async (rest: string) => {
      if (!rest) {
        openSettingsAt("modes")
        return
      }
      const save = rest.match(/^save\s+(\S+)$/i)
      if (save) {
        try {
          await saveMode({ name: save[1]! })
          await refreshModes()
          setNotice(`Mode "${save[1]}" saved from the current pairing.`)
        } catch (err) {
          setNotice(`Mode save failed: ${(err as Error).message}`)
        }
        return
      }
      const rm = rest.match(/^(?:rm|delete)\s+(\S+)$/i)
      if (rm) {
        try {
          await deleteMode(rm[1]!)
          await refreshModes()
          setNotice(`Mode "${rm[1]}" deleted.`)
        } catch (err) {
          setNotice(`Mode delete failed: ${(err as Error).message}`)
        }
        return
      }
      await applyModeByName(rest)
    },
    [openSettingsAt, refreshModes, applyModeByName],
  )

  /** `/incognito [name]` — the mode-apply flow filtered to incognito modes
   *  (modes carrying a provider allowlist). Exactly one → apply it; several →
   *  picker; none → explain how to make one. */
  const runIncognito = useCallback(
    async (rest: string) => {
      try {
        const { modes } = await getModes()
        const action = resolveIncognitoCommand(modes as SavedMode[], rest)
        if (action.kind === "none") return setNotice(NO_INCOGNITO_MODES)
        if (action.kind === "unknown") return setNotice(unknownModeLine(action.name))
        if (action.kind === "not-incognito") return setNotice(notIncognitoLine(action.name))
        if (action.kind === "pick") {
          setIncognitoModes(action.modes)
          setDialog("incognito")
          return
        }
        markSelfApplied(action.name)
        const applied = await applyMode(action.name)
        await refreshModels()
        void refreshModes()
        void refreshAgents()
        setNotice(
          incognitoAppliedLine(
            applied?.applied || action.name,
            `${prettyModel(applied?.model ?? "")}${applied?.effort ? ` (${applied.effort})` : ""} · ${applied?.provider ?? ""}`,
          ),
        )
      } catch (err) {
        setNotice(`Incognito request failed: ${(err as Error).message}`)
      }
    },
    [refreshModels, refreshModes, refreshAgents, markSelfApplied],
  )

  /** `/cacheguard [tokens|off]` — same parsing + wording as the TUI, backed by
   *  GET/POST ROUTES.cacheGuard (the pre-send confirm bar reads the same setting). */
  const runCacheGuard = useCallback(async (rest: string) => {
    const trimmed = rest.trim().toLowerCase()
    const describe = (tokens: number | null) =>
      tokens == null
        ? "Cache guard: off — cold-cache sends go through without confirmation. `/cacheguard <tokens>` (e.g. 100k) to enable."
        : `Cache guard: a send that would re-send ≥${compactTokens(tokens)} tokens on a cold cache asks for confirmation first. \`/cacheguard <tokens|off>\` to change.`
    try {
      if (!trimmed) {
        setNotice(describe((await getCacheGuard()).tokens))
        return
      }
      let tokens: number | null
      if (trimmed === "off" || trimmed === "none" || trimmed === "0") {
        tokens = null
      } else {
        const m = trimmed.match(/^(\d+(?:\.\d+)?)(k|m)?$/)
        if (!m) {
          setNotice("Usage: /cacheguard <tokens|off> — e.g. /cacheguard 100k, /cacheguard 50000, /cacheguard off")
          return
        }
        tokens = Math.round(Number(m[1]) * (m[2] === "m" ? 1_000_000 : m[2] === "k" ? 1_000 : 1))
      }
      const body = await saveCacheGuardTokens(tokens)
      setNotice(
        body.tokens == null
          ? "Cache guard off — cold-cache sends go through without confirmation."
          : `Cache guard set: confirm before re-sending ≥${compactTokens(body.tokens)} tokens on a cold cache.`,
      )
    } catch (err) {
      setNotice(`Cache guard request failed: ${(err as Error).message}`)
    }
  }, [])

  /** Dispatch a typed slash command. Returns false when it should be sent as
   *  chat text instead (unknown command, or a live-only command in demo mode). */
  const dispatchSlash = useCallback(
    async (command: string): Promise<boolean> => {
      const head = (command.split(/\s+/)[0] ?? "").toLowerCase()
      const rest = command.slice(head.length).trim()

      // Local commands work offline too.
      switch (head) {
        case "/help":
          setNotice(
            ["Commands", ...slashCommands.map((c) => `${c.name} — ${c.description}`)].join("\n"),
          )
          return true
        case "/settings":
          openSettingsAt()
          return true
        case "/clear":
          void handleNewThread()
          return true
        case "/model":
          setModelPickerSignal((n) => n + 1)
          return true
        case "/resume":
          setPaletteOpen(true)
          return true
      }

      // Everything below needs the live server; in demo it stays chat text.
      if (!live) return false

      // Saved modes double as commands: a bare `/fire` applies the "fire" mode.
      if (BARE_COMMAND_RE.test(command)) {
        const modeName = savedModeForCommand(command, slashModes)
        if (modeName) {
          await applyModeByName(modeName)
          return true
        }
      }

      switch (head) {
        case "/rename":
          await openDialog("rename")
          return true
        case "/rewind":
          await openDialog("rewind")
          return true
        case "/usage":
        case "/scoreboard": {
          if (!sessionId) {
            setNotice(`No session yet — send a message first, then ${head}.`)
            return true
          }
          // `/scoreboard session` scopes to this thread (TUI parity).
          const scope = head === "/scoreboard" && !/^session\b/i.test(rest) ? "all" : "session"
          await openStats(head === "/usage" ? "usage" : "scoreboard", scope)
          return true
        }
        case "/cacheguard":
          await runCacheGuard(rest)
          return true
        case "/workers":
          openSettingsAt("workflow")
          return true
        case "/reviewer":
          openSettingsAt("reviewer")
          return true
        case "/fork":
          await openDialog("fork")
          if (rest) setDialogText(rest)
          return true
        case "/goal":
          await openDialog("goal")
          if (rest) setDialogText(rest)
          return true
        case "/shipit":
          await openDialog("ship")
          if (rest) setDialogText(rest)
          return true
        case "/mode":
          await runModeCommand(rest)
          return true
        case "/incognito":
          await runIncognito(rest)
          return true
        case "/advisor":
          openSettingsAt("advisor")
          return true
        case "/sidekick":
          // From a live session this is a per-session override surface; without
          // a session (demo/offline) fall back to the global Settings page.
          if (live && sessionId) setSidekickPickerOpen(true)
          else openSettingsAt("sidekick")
          return true
        case "/skills":
          openSettingsAt("skills")
          return true
        case "/provider":
          openSettingsAt("providers")
          return true
      }
      return false
    },
    [slashCommands, slashModes, live, sessionId, openSettingsAt, handleNewThread, openDialog, openStats, applyModeByName, runModeCommand, runCacheGuard, runIncognito],
  )
  dispatchSlashRef.current = dispatchSlash

  const confirmCacheGuard = useCallback(async () => {
    if (!cacheGuard || !config || !sessionId) return
    const pending = cacheGuard
    setCacheGuard(null)
    setSending(true)
    try {
      const blocked = await sendMessage(config.baseUrl, sessionId, pending.text, { force: true, delivery: pending.delivery, images: pending.images })
      if (blocked) setSendError("Send blocked by cache guard even after confirmation.")
    } catch (err) {
      setSendError((err as Error).message)
    } finally {
      setSending(false)
    }
  }, [cacheGuard, config, sessionId])

  const handleModelChange = useCallback(
    async (m: Model, options?: { effort?: string; speed?: string }) => {
      if (!live) {
        setDemoModel(m)
        return
      }
      if (!config) throw new Error("Not connected")
      const parts = splitModelKey(m.id)
      if (!parts) throw new Error(`Invalid model id: ${m.id}`)
      const sid = sessionId
      // Await server confirmation before the picker treats the switch as done.
      // This picker is SESSION-scoped: the selection is pinned to this session
      // (the global default lives in Settings → Models).
      const next = await selectModel(
        config.baseUrl,
        {
          provider: parts.provider,
          model: parts.model,
          ...(options?.effort ? { effort: options.effort } : {}),
          ...(options?.speed ? { speed: options.speed } : {}),
        },
        sid,
      )
      if (sid) setSessionModelSel((prev) => ({ ...prev, [sid]: next }))
      else setModelSel(next)
      // Picking a model by hand breaks the mode's pairing (the server drops its
      // own activeMode here too), so re-read what is now current: the selector
      // must fall back from the mode name to the model name.
      void refreshModes()
    },
    [live, config, sessionId, refreshModes],
  )

  const enterDemo = useCallback(() => {
    streamAbort.current?.abort()
    setAppMode("demo")
    setConnectionState("offline")
  }, [])

  const retryLive = useCallback(async () => {
    if (!config) return
    setAppMode("live")
    setConnError(null)
    setConnectionState("connecting")
    // The server we lost may have been replaced by a newer build on another
    // port, so resolve again before retrying the address that failed.
    const resolved = (await reresolveConnection()) ?? config
    const baseUrl = resolved.baseUrl || config.baseUrl
    if (resolved.baseUrl && resolved.baseUrl !== config.baseUrl) setConfig(resolved)
    try {
      const [info, reg, sel, rows] = await Promise.all([
        fetchServerInfo(baseUrl),
        listRepos(baseUrl).catch(() => null),
        fetchModel(baseUrl),
        listAllModels(baseUrl).catch(() => [] as ModelRow[]),
      ])
      setWorkspace(info.workspace || "")
      setModelSel(sel)
      setModelRows(rows)
      setConnectionState("connected")

      if (reg) {
        setRepos(reg.repos)
        const remembered = activeRepoIdRef.current
        const repoId =
          (remembered && reg.repos.some((r) => r.id === remembered) ? remembered : null) ??
          reg.activeId ??
          reg.repos[0]?.id ??
          null
        setActiveRepoId(repoId)
        activeRepoIdRef.current = repoId
      }

      if (sessionIdRef.current) {
        void attachSession(baseUrl, sessionIdRef.current)
        void refreshSessions(baseUrl, activeRepoIdRef.current).catch(() => {})
      } else {
        await openRepoThreads(baseUrl, activeRepoIdRef.current)
      }
    } catch (err) {
      setConnectionState("offline")
      setConnError(
        `Can't reach Chunky server at ${baseUrl}. (${(err as Error).message})`,
      )
    }
  }, [config, attachSession, openRepoThreads, refreshSessions])

  const paletteActions = useMemo<PaletteAction[]>(() => [
    { id: "new", label: "New session", hint: "⌘N", group: "Session" },
    ...repos.map((repo) => ({ id: `repo:${repo.id}`, label: `Switch repo: ${repo.name}`, group: "Repositories" })),
    ...sessions.map((session) => ({ id: `session:${session.sessionId}`, label: `Switch session: ${session.title || session.sessionId.slice(0, 8)}`, group: "Sessions" })),
    ...uiModels.map((model) => ({ id: `model:${model.id}`, label: `Switch model: ${model.name}`, group: "Models" })),
    ...["Rename session", "Fork session", "Rewind to turn", "Goal mode", "Ship it", "Usage & scoreboard"].map((label) => ({ id: `action:${label}`, label, group: "Session" })),
    { id: "terminal", label: "Toggle terminal", hint: "Ctrl+`", group: "Workspace" },
    { id: "theme", label: "Toggle theme", group: "Appearance" },
    { id: "browser", label: browserOpen ? "Close browser" : "Open browser", group: "Workspace" },
    { id: "factory", label: factoryOpen ? "Close Factory" : "Open Factory", group: "Workspace" },
    { id: "settings", label: "Open Settings", hint: "⌘,", group: "Integration" },
    { id: "onboarding", label: "Run Onboarding", group: "Integration" },
  ], [repos, sessions, uiModels, browserOpen, factoryOpen])

  /** Stable app-action dispatch shared by the palette and the voice agent. */
  const dispatchAppAction = useCallback(
    (action: { type: "select-repo"; repoId: string } | { type: "select-session"; sessionId: string } | { type: "new-session" }) => {
      if (action.type === "select-repo") void handleSelectRepo(action.repoId)
      else if (action.type === "select-session") handleSelectThread(action.sessionId)
      else void handleNewThread()
    },
    [handleSelectRepo, handleSelectThread, handleNewThread],
  )

  // One guard for both the header button and the push-to-talk hotkey.
  const voiceEnabled = live && connectionState !== "booting" && connectionState !== "offline"

  const voice = useVoiceAgent({
    enabled: voiceEnabled,
    baseUrl: live && config ? config.baseUrl : null,
    getRepos: useCallback(async () => {
      if (!config) return []
      const data = await listRepos(config.baseUrl)
      return (data.repos ?? []).map((repo) => ({ id: repo.id, name: repo.name, path: repo.path }))
    }, [config]),
    getSessions: useCallback(
      async (repoId?: string | null) => (config ? listSessions(config.baseUrl, repoId ?? activeRepoIdRef.current) : []),
      [config],
    ),
    dispatchAppAction,
    refresh: useCallback(() => {
      if (config) void refreshSessions(config.baseUrl, activeRepoIdRef.current).catch(() => {})
    }, [config, refreshSessions]),
  })

  const runAction = useCallback(
    (a: PaletteAction) => {
      if (a.id === "new") dispatchAppAction({ type: "new-session" })
      else if (a.id === "terminal") setTerminalsOpen((value) => !value)
      else if (a.id === "theme") toggle()
      else if (a.id === "browser") setBrowserOpen((open) => { if (!open) setFactoryOpen(false); return !open })
      else if (a.id === "factory") setFactoryOpen((open) => { if (!open) setBrowserOpen(false); return !open })
      else if (a.id === "settings") setSettingsOpen(true)
      else if (a.id === "onboarding") { if (live) setOnboardingOpen(true) }
      else if (a.id.startsWith("repo:")) dispatchAppAction({ type: "select-repo", repoId: a.id.slice(5) })
      else if (a.id.startsWith("session:")) dispatchAppAction({ type: "select-session", sessionId: a.id.slice(8) })
      else if (a.id.startsWith("model:")) { const model = uiModels.find((item) => item.id === a.id.slice(6)); if (model) void handleModelChange(model) }
      else if (a.id.startsWith("action:")) { const kind = a.id.slice(7); const map: Record<string, NonNullable<typeof dialog>> = { "Rename session": "rename", "Fork session": "fork", "Rewind to turn": "rewind", "Goal mode": "goal", "Ship it": "ship", "Usage & scoreboard": "stats" }; void openDialog(map[kind]!) }
    },
    [dispatchAppAction, toggle, uiModels, handleModelChange, openDialog, live],
  )

  // Global shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey
      if (meta && e.key.toLowerCase() === "k") {
        e.preventDefault()
        setPaletteOpen((o) => !o)
      } else if (meta && e.key === ",") {
        e.preventDefault()
        setSettingsOpen(true)
      } else if (meta && e.shiftKey && e.key.toLowerCase() === "l") {
        e.preventDefault()
        toggle()
      } else if (meta && e.key.toLowerCase() === "n") {
        e.preventDefault()
        void handleNewThread()
      } else if (e.ctrlKey && !e.metaKey && !e.altKey && (e.key === "`" || e.code === "Backquote")) {
        // Ctrl+` toggles the terminal drawer (Cmd+T is taken by thread folding).
        e.preventDefault()
        setTerminalsOpen((value) => !value)
      } else if (meta && e.key.toLowerCase() === "t") {
        e.preventDefault()
        setFoldThreads((value) => !value)
      } else if (e.key === "Escape" && streaming && live) {
        handleStop()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [toggle, handleNewThread, streaming, live, handleStop])

  // The theme switch lives in the top bar's overflow menu now (ChatTopBar),
  // which is handed `resolved` + `toggle` directly.

  const statusBanner =
    connectionState === "booting" ? (
      <div className="flex items-center justify-center gap-2 border-border border-b bg-muted/40 px-4 py-1.5 text-[12px] text-muted-foreground">
        Connecting to Chunky server…
      </div>
    ) : connectionState === "reconnecting" && live ? (
      <div className="flex items-center justify-center gap-2 border-border border-b bg-muted/40 px-4 py-1.5 text-[12px] text-muted-foreground">
        Reconnecting stream…
      </div>
    ) : connError && (connectionState === "offline" || connectionState === "error") ? (
      <div className="flex items-center justify-between gap-3 border-destructive/30 border-b bg-destructive/10 px-4 py-1.5 text-[12px] text-destructive">
        <span className="flex min-w-0 items-center gap-2">
          {connectionState === "offline" ? (
            <WifiOff className="size-3.5 shrink-0" />
          ) : (
            <AlertCircle className="size-3.5 shrink-0" />
          )}
          <span className="truncate">{connError}</span>
        </span>
        <span className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={() => void retryLive()}
            className="cursor-pointer font-medium underline-offset-2 hover:underline"
          >
            Retry
          </button>
          {appMode !== "demo" && (
            <button
              type="button"
              onClick={enterDemo}
              className="cursor-pointer font-medium underline-offset-2 hover:underline"
            >
              Demo mode
            </button>
          )}
        </span>
      </div>
    ) : appMode === "demo" ? (
      <div className="flex items-center justify-between gap-3 border-border border-b bg-amber-500/10 px-4 py-1.5 text-[12px] text-amber-700 dark:text-amber-300">
        <span className="flex items-center gap-2">
          <WifiOff className="size-3.5" />
          Offline demo — mock data only. Not connected to the server.
        </span>
        <button
          type="button"
          onClick={() => void retryLive()}
          className="cursor-pointer font-medium underline-offset-2 hover:underline"
        >
          Connect
        </button>
      </div>
    ) : sendError ? (
      <div className="flex items-center justify-between gap-3 border-destructive/30 border-b bg-destructive/10 px-4 py-1.5 text-[12px] text-destructive">
        <span className="truncate">{sendError}</span>
        <button
          type="button"
          onClick={() => setSendError(null)}
          className="cursor-pointer font-medium underline-offset-2 hover:underline"
        >
          Dismiss
        </button>
      </div>
    ) : null

  return (
    <TooltipProvider delay={300}>
      <div className="shell-chrome chunky-aurora flex h-screen w-screen overflow-hidden">
        <Sidebar
          projects={projects}
          threads={threads}
          // Live sessions are fetched per repo (listSessions(baseUrl, repoId)),
          // so the repo tab already says which one they belong to. Only the demo
          // list can span projects, so only it labels its rows.
          showProjects={!live}
          activeProjectId={activeThread.projectId}
          activeThreadId={live ? sessionId ?? "" : demoActiveId}
          onSelectThread={handleSelectThread}
          onNewThread={() => void handleNewThread()}
          onOpenSettings={() => setSettingsOpen(true)}
          onOpenPalette={() => setPaletteOpen(true)}
          onRenameThread={(id) => { if (live) { handleSelectThread(id); window.setTimeout(() => void openDialog("rename"), 0) } }}
          connectionLabel={
            live
              ? connectionState === "connected"
                ? "Live"
                : connectionState === "reconnecting"
                  ? "Reconnecting"
                  : connectionState === "connecting" || connectionState === "booting"
                    ? "Connecting"
                    : "Offline"
              : "Demo"
          }
        />

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <ChatTopBar
            repoStatus={live ? <GitToolbar cwd={gitCwd} /> : null}
            headerRight={<>{incognitoSession && <span title="This session is off the record — nothing is written to disk." className="flex items-center gap-1 rounded-full border border-destructive/40 bg-destructive/10 px-2 py-1 font-medium text-[11px] text-destructive"><EyeOff className="size-3" />Incognito</span>}{goal && <button type="button" onClick={() => void openDialog("goal")} className="rounded-full border border-primary/30 bg-primary/10 px-2 py-1 text-[11px] font-medium text-primary">Goal · {goal.status}{goal.turns != null ? ` · ${goal.turns} turns` : ""}</button>}<VoiceButton state={voice.state} active={voice.active} error={voice.error} disabled={!voiceEnabled} onToggle={voice.toggle} apiKeyPromptOpen={voice.apiKeyPromptOpen} onApiKeyPromptOpenChange={voice.setApiKeyPromptOpen} onSubmitApiKey={voice.submitApiKey} /></>}
            theme={resolved}
            onToggleTheme={toggle}
            onRename={() => void openDialog("rename")} onFork={() => void openDialog("fork")} onRewind={() => void openDialog("rewind")} onGoal={() => void openDialog("goal")} onShip={() => void openDialog("ship")} onStats={() => void openDialog("stats")}
            repos={live ? repos : undefined}
            activeRepoId={activeRepoId}
            unreadRepoIds={repoTabUnreadIds}
            onSelectRepo={(id) => void handleSelectRepo(id)}
            onAddRepo={handleAddRepo}
            onRemoveRepo={(id) => void handleRemoveRepo(id)}
            // Cloning needs a reachable server (the agent does the work), so the
            // section disappears entirely in demo/offline mode.
            onCloneRepo={live && connectionState === "connected" ? handleCloneRepo : undefined}
            cloneStatus={cloneStatus}
            onCancelClone={handleCancelClone}
            onViewCloneThread={handleViewCloneThread}
            defaultCloneParent={cloneParentDefault}
            reposBusy={addingRepo}
            reposDisabled={!live || connectionState === "booting"}
            onToggleBrowser={() => setBrowserOpen((open) => !open)}
            onToggleTerminal={() => setTerminalsOpen((value) => !value)}
            terminalOpen={terminalsOpen}
          />

          <section className="content-panel flex min-h-0 min-w-0 flex-1">
            <div className="flex min-h-0 min-w-0 flex-1 flex-col">
              {statusBanner}
              <ChatView
                thread={activeThread}
                streamingId={liveStreamingId}
                loading={live && transcriptLoading}
                transcript={live ? transcript : undefined}
                modelName={uiModel.name}
                foldAll={foldThreads}
                compacted={liveCompacted}
              />
              {(transcript.background.tasks > 0 || transcript.background.monitors > 0) && <div className="px-5 pb-1 text-center text-[11px] text-muted-foreground">Background: {transcript.background.tasks} task{transcript.background.tasks === 1 ? "" : "s"} · {transcript.background.monitors} monitor{transcript.background.monitors === 1 ? "" : "s"}</div>}
              <TerminalDrawer
                open={terminalsOpen}
                onOpenChange={setTerminalsOpen}
                cwd={activeRepo?.path || workspace || config?.workspace || undefined}
                resolvedTheme={resolved}
              />
              <div className="flex flex-col gap-2">
                <TodosPanel todos={liveTodos} />
                <QueueChips
                  entries={liveQueue}
                  running={streaming}
                  onSteer={live && config && sessionId ? handleQueueSteer : undefined}
                  onDelete={live && config && sessionId ? handleQueueDelete : undefined}
                />
                <Composer
                model={uiModel}
                models={uiModels}
                modelEffort={effectiveModelSel?.effort ?? null}
                modelSpeed={effectiveModelSel?.speed ?? null}
                onModelChange={handleModelChange}
                onRefreshModels={live ? refreshModels : undefined}
                // While the agent is running, plain ⏎ enqueues; ⌥⏎ interjects.
                onSend={(t, opts) =>
                  void handleSend(t, {
                    ...opts,
                    delivery: opts?.delivery ?? (streaming ? "queue" : "auto"),
                  })
                }
                onSearchFiles={live && config ? (query) => searchFiles(config.baseUrl, query, activeRepoId) : undefined}
                commands={slashCommands}
                modes={modeOptions}
                modeSpecs={live ? savedModes : []}
                activeMode={activeMode}
                onSelectMode={live ? applyModeByName : undefined}
                onSaveMode={live ? handleSaveModeSpec : undefined}
                openModelPickerSignal={modelPickerSignal}
                streaming={streaming}
                onStop={handleStop}
                contextMeter={<ContextMeter usage={liveUsage} limit={contextLimit} />}
                status={<ComposerStatus chips={statusChips} selectorLabel={activeMode ?? uiModel.name} />}
                cacheGuard={cacheGuard}
                onCacheConfirm={() => void confirmCacheGuard()}
                onCacheCancel={() => setCacheGuard(null)}
                disabled={
                  live &&
                  (connectionState === "booting" ||
                    connectionState === "offline" ||
                    !sessionId ||
                    sending)
                }
                />
              </div>
            </div>
            {browserOpen ? (
              <BrowserPane
                onClose={() => setBrowserOpen(false)}
                baseUrl={live && connectionState === "connected" ? config?.baseUrl ?? null : null}
              />
            ) : factoryOpen ? (
              <FactoryPane
                onClose={() => setFactoryOpen(false)}
                baseUrl={live && connectionState === "connected" ? config?.baseUrl ?? null : null}
                repoId={activeRepoId}
                onOpenSession={live ? handleSelectThread : undefined}
              />
            ) : null}
            <ExternalLinkMenu />
          </section>
        </div>

        {voice.visible && (
          <VoiceHud
            state={voice.state}
            muted={voice.muted}
            error={voice.error}
            userLine={voice.userLine}
            assistantLine={voice.assistantLine}
            tools={voice.tools}
            mode={voice.mode}
            holding={voice.holding}
            hotkeyLabel={codeToLabel(voice.hotkeyCode)}
            onToggleMode={voice.toggleMode}
            onHold={voice.setHolding}
            onEnd={voice.stop}
          />
        )}

        {/* One host for every in-app confirmation (lib/confirm.ts). */}
        <ConfirmHost />
        <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} onRun={runAction} actions={paletteActions} />
        <SettingsCenter
          open={settingsOpen}
          onOpenChange={(open) => {
            setSettingsOpen(open)
            if (!open && live && config) {
              void refreshModels()
              void refreshModes()
              void refreshAgents()
            }
          }}
          initialSection={settingsSection}
          onModesChanged={() => {
            void refreshModels()
            void refreshModes()
            void refreshAgents()
          }}
          connection={{
            state: live ? connectionState : "offline",
            baseUrl: config?.baseUrl ?? "http://localhost:4620",
            workspace: activeRepo?.path || workspace || config?.workspace || "",
            sessionCount: sessions.length,
            mode: appMode,
          }}
        />
        <OnboardingWizard
          open={onboardingOpen}
          onOpenChange={setOnboardingOpen}
          onComplete={() => { void refreshModels() }}
          onOpenProviderSettings={() => openSettingsAt("providers")}
        />
        {live && sessionId && (
          <SidekickPicker
            open={sidekickPickerOpen}
            onOpenChange={setSidekickPickerOpen}
            sessionId={sessionId}
            rows={modelRows}
            onChanged={(next) => {
              // Repaint the composer status now, then re-read the effective
              // (per-session) config authoritatively. Modes too: the seat is
              // part of a mode's pairing, so this can end the active mode.
              setSidekickConfig(next)
              void refreshAgents()
              void refreshModes()
            }}
          />
        )}
        {notice && <div className="fixed right-5 bottom-5 z-50 max-h-[60vh] max-w-sm overflow-y-auto rounded-xl border border-primary/25 bg-popover px-4 py-3 text-[13px] shadow-panel"><span className="whitespace-pre-line">{notice}</span><button type="button" className="ml-3 text-primary" onClick={() => setNotice(null)}>Dismiss</button></div>}
        <Dialog open={dialog !== null} onOpenChange={(open) => !open && setDialog(null)}><DialogPopup>
          <DialogHeader><DialogTitle>{dialog === "rename" ? "Rename session" : dialog === "fork" ? "Fork session" : dialog === "rewind" ? "Rewind session" : dialog === "goal" ? "Goal mode" : dialog === "ship" ? "Ship it" : dialog === "incognito" ? "Go incognito" : "Usage & scoreboard"}</DialogTitle><DialogDescription>{dialog === "rewind" ? "Choose a completed turn, then explicitly confirm restoring files and conversation." : dialog === "ship" ? "Optional notes for the handoff brief." : dialog === "incognito" ? "Pick an incognito mode. Applying it takes NEW sessions off the record — this one stays as it is." : ""}</DialogDescription></DialogHeader>
          <div className="px-6 pb-2">{(dialog === "rename" || dialog === "fork" || dialog === "goal" || dialog === "ship") && <textarea value={dialogText} onChange={(event) => setDialogText(event.target.value)} placeholder={dialog === "goal" ? "Objective…" : dialog === "fork" ? "Optional directive…" : dialog === "ship" ? "Optional handoff notes…" : "Session title"} className="min-h-20 w-full rounded-lg border border-input bg-transparent p-2 text-sm outline-none focus:ring-2 focus:ring-ring/40" />}{dialog === "fork" && <label className="mt-3 flex gap-2 text-sm"><input type="checkbox" checked={forkWorktree} onChange={(event) => setForkWorktree(event.target.checked)} /> Create a git worktree</label>}{dialog === "goal" && <><label className="mt-3 flex gap-2 text-sm"><input type="checkbox" checked={goalWorkflows} onChange={(event) => setGoalWorkflows(event.target.checked)} /> Use workflows mode</label><input value={goalTurns} onChange={(event) => setGoalTurns(event.target.value)} placeholder="Optional max turns" inputMode="numeric" className="mt-2 w-full rounded-lg border border-input bg-transparent p-2 text-sm" />{goal && <div className="mt-3 flex gap-2"><Button size="sm" variant="outline" onClick={() => void goalAction(goal.status === "active" ? "pause" : "resume")}>{goal.status === "active" ? "Pause" : "Resume"}</Button><Button size="sm" variant="outline" onClick={() => void goalAction("clear")}>Clear</Button></div>}</>}{dialog === "rewind" && <div className="max-h-60 overflow-auto">{rewindPoints.map((point) => <button type="button" onClick={() => setSelectedRewind(point)} key={point.turn} className={`mb-1 w-full rounded-lg border p-2 text-left text-sm ${selectedRewind?.turn === point.turn ? "border-primary bg-primary/10" : "border-border"}`}>Turn {point.turn} · {point.userText}</button>)}{selectedRewind && <p className="mt-2 text-xs text-destructive">Confirming restores files AND conversation to turn {selectedRewind.turn}.</p>}</div>}{dialog === "incognito" && <div className="max-h-60 overflow-auto">{incognitoModes.map((mode) => <button type="button" key={mode.name} onClick={() => { setDialog(null); void runIncognito(mode.name) }} className="mb-1 flex w-full flex-col gap-0.5 rounded-lg border border-border p-2 text-left hover:border-primary/50 hover:bg-accent"><span className="font-medium text-sm">{mode.name}</span><span className="text-[11.5px] text-muted-foreground">{prettyModel(mode.model)} · {mode.provider}{mode.incognito?.allow?.length ? ` · allows ${mode.incognito.allow.join(", ")}` : ""}</span></button>)}</div>}{dialog === "stats" && <><div className="mb-2 flex items-center gap-1 border-b border-border"><button type="button" onClick={() => setStatsTab("usage")} className={`px-3 py-2 text-sm ${statsTab === "usage" ? "border-primary border-b-2 text-primary" : "text-muted-foreground"}`}>Usage</button><button type="button" onClick={() => setStatsTab("scoreboard")} className={`px-3 py-2 text-sm ${statsTab === "scoreboard" ? "border-primary border-b-2 text-primary" : "text-muted-foreground"}`}>Scoreboard</button>{statsTab === "scoreboard" && <div className="ml-auto flex items-center gap-1 pb-1 text-[11px]">{(["session", "all"] as const).map((scope) => <button key={scope} type="button" onClick={() => { setScoreboardScope(scope); void loadStats(scope) }} className={cn("rounded-full border px-2 py-0.5", scoreboardScope === scope ? "border-primary/40 bg-primary/10 text-primary" : "border-border text-muted-foreground")}>{scope === "session" ? "This session" : "All sessions"}</button>)}</div>}</div><div className="max-h-80 overflow-auto">{!stats ? <p className="px-3 py-6 text-center text-[12px] text-muted-foreground">Loading…</p> : statsTab === "usage" ? (stats.usage ? <UsageTable body={stats.usage} /> : <p className="px-3 py-6 text-center text-[12px] text-destructive">{stats.usageError ?? "No usage yet."}</p>) : (stats.scoreboard ? <ScoreboardTable body={stats.scoreboard} /> : <p className="px-3 py-6 text-center text-[12px] text-destructive">{stats.scoreboardError ?? "No scoreboard data."}</p>)}</div></>}</div>
          <DialogFooter>{dialog !== "stats" && dialog !== "incognito" && <Button onClick={() => void runDialog()} disabled={(dialog === "rewind" && !selectedRewind) || (dialog === "rename" && !dialogText.trim())}>{dialog === "rewind" ? "Confirm restore" : dialog === "goal" ? "Start goal" : dialog === "ship" ? "Ship it" : "Continue"}</Button>}</DialogFooter>
        </DialogPopup></Dialog>
      </div>
    </TooltipProvider>
  )
}
