import { AlertCircle, EyeOff, Moon, Sun, WifiOff } from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { ChatTopBar, ChatView } from "./components/ChatView"
import { CommandPalette } from "./components/CommandPalette"
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPopup, DialogTitle } from "./components/ui/dialog"
import { Composer } from "./components/Composer"
import { SettingsCenter } from "./components/settings/SettingsCenter"
import { needsOnboarding, OnboardingWizard } from "./components/settings/OnboardingWizard"
import { ContextMeter } from "./components/ContextMeter"
import { QueueChips } from "./components/QueueChips"
import { TodosPanel } from "./components/TodosPanel"
import { Sidebar } from "./components/Sidebar"
import { BrowserPane } from "./components/BrowserPane"
import { Button } from "./components/ui/button"
import { Tooltip, TooltipPopup, TooltipProvider, TooltipTrigger } from "./components/ui/tooltip"
import {
  addRepo,
  createSession,
  fetchModel,
  fetchServerInfo,
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
import { applyMode, deleteMode, getCacheGuard, getModes, saveMode, setCacheGuard as saveCacheGuardTokens } from "./lib/configApi"
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
import type { GoalSnapshot, ModeSpec, RewindPoint } from "@chunky/protocol"
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
import { initialState, isStreaming, reduce, type TranscriptState } from "./lib/transcript"

type ConnectionState = "booting" | "connecting" | "connected" | "reconnecting" | "offline" | "error"
type AppMode = "live" | "demo"

const REPLAY_SETTLE_MS = 120
/** How long a local apply suppresses the echoed mode.applied notice. */
const SELF_APPLY_WINDOW_MS = 10_000
const ACTIVE_REPO_KEY = "chunky.activeRepoId"
const LAST_SESSION_KEY = "chunky.lastSessionByRepo"

function readLastSessions(): Record<string, string> {
  try {
    const raw = localStorage.getItem(LAST_SESSION_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {}
  } catch {
    return {}
  }
}

function writeLastSession(repoId: string, sessionId: string) {
  try {
    const map = readLastSessions()
    map[repoId] = sessionId
    localStorage.setItem(LAST_SESSION_KEY, JSON.stringify(map))
  } catch {
    /* ignore quota */
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

function rowsToModels(rows: ModelRow[]): Model[] {
  return rows.map((r) => ({
    id: `${r.provider}/${r.model.id}`,
    name: r.model.name || prettyModel(r.model.id),
    vendor: r.provider,
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
  const [transcript, setTranscript] = useState<TranscriptState>(initialState)
  const [transcriptLoading, setTranscriptLoading] = useState(false)
  const [modelSel, setModelSel] = useState<ModelSelection | null>(null)
  const [modelRows, setModelRows] = useState<ModelRow[]>([])
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)
  const [workspace, setWorkspace] = useState("")
  const [repos, setRepos] = useState<Repo[]>([])
  const [activeRepoId, setActiveRepoId] = useState<string | null>(null)
  const [addingRepo, setAddingRepo] = useState(false)
  const [cacheGuard, setCacheGuard] = useState<{ text: string; images: { base64: string; mediaType: string }[]; approxTokens: number; reason: string; delivery?: MessageDelivery } | null>(null)
  const [foldThreads, setFoldThreads] = useState(false)
  const [goal, setGoalState] = useState<GoalSnapshot | null>(null)
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
  const [onboardingOpen, setOnboardingOpen] = useState(false)
  const [browserOpen, setBrowserOpen] = useState(false)
  // Saved modes as slash aliases ("/fire") + a signal that opens the composer's
  // model picker for `/model`.
  const [slashModes, setSlashModes] = useState<SlashCommand[]>([])
  const [modelPickerSignal, setModelPickerSignal] = useState(0)

  const streamAbort = useRef<AbortController | null>(null)
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
  const activeRepoIdRef = useRef<string | null>(null)
  const repoListGen = useRef(0)
  const attachGen = useRef(0)
  const onboardingChecked = useRef(false)
  const lastSessionByRepo = useRef<Record<string, string>>(readLastSessions())

  sessionIdRef.current = sessionId
  activeRepoIdRef.current = activeRepoId

  const live = appMode === "live"
  const streaming = live ? isStreaming(transcript) || sending : demoStreamingId !== null
  // Server-authoritative: the session row carries the off-the-record flag.
  const incognitoSession =
    live && sessions.find((s) => s.sessionId === sessionId)?.incognito === true

  const uiModels = useMemo(() => {
    if (!live) return MODELS
    const list = rowsToModels(modelRows)
    return list.length > 0 ? list : [modelSelectionToUi(modelSel, modelRows)]
  }, [live, modelRows, modelSel])

  const uiModel = useMemo(() => {
    if (!live) return demoModel
    return modelSelectionToUi(modelSel, modelRows)
  }, [live, demoModel, modelSel, modelRows])

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
      const t = sessionToThread(s, {
        liveStatus: s.sessionId === sessionId ? transcript.status : undefined,
        isActive: s.sessionId === sessionId,
        modelName: uiModel.name,
      })
      // Prefer repo identity over raw workspace path for project linkage.
      if (activeRepo) t.projectId = `repo:${activeRepo.id}`
      return t
    })
  }, [live, demoThreads, sessions, sessionId, transcript.status, uiModel.name, activeRepo])

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

  // Active model's context limit for the context-window meter (undefined in demo).
  const contextLimit = useMemo(() => {
    if (!live) return undefined
    const row = modelRows.find(
      (r) => r.provider === modelSel?.provider && r.model.id === modelSel?.model,
    )
    return row?.model.contextLimit
  }, [live, modelRows, modelSel])

  // Session-scoped rich data lives on TranscriptState (auto-resets on switch).
  const liveTodos = live ? transcript.todos : []
  const liveUsage = live ? transcript.usage : null
  const liveCompacted = live ? transcript.compacted : 0
  const liveQueue = live ? transcript.queue.entries : []

  // ---- Live: refresh sessions for a repo (generation-guarded against tab races) ----
  const refreshSessions = useCallback(
    async (baseUrl: string, repoId: string | null = activeRepoIdRef.current) => {
      const gen = ++repoListGen.current
      const list = await listSessions(baseUrl, repoId)
      if (gen !== repoListGen.current) return list
      // Only apply if still viewing this repo (or boot with matching ref).
      if (repoId != null && repoId !== activeRepoIdRef.current) return list
      setSessions(list)
      return list
    },
    [],
  )

  // ---- Live: attach SSE (abort on switch, reconnect with full replay reset) ----
  const attachSession = useCallback(async (baseUrl: string, id: string) => {
    streamAbort.current?.abort()
    const ac = new AbortController()
    streamAbort.current = ac
    const gen = ++attachGen.current

    setSessionId(id)
    void getGoal(baseUrl, id).then(setGoalState).catch(() => setGoalState(null))
    const repoForSession = activeRepoIdRef.current
    if (repoForSession) {
      lastSessionByRepo.current[repoForSession] = id
      writeLastSession(repoForSession, id)
    }
    setTranscript(initialState)
    setTranscriptLoading(true)
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
      if (ev.type === "session.rewound") {
        void attachSession(baseUrl, id)
        return
      }
      // Live-only broadcast (never persisted, never a transcript item): another
      // window/the TUI applied a mode, so re-read the model + alias state here.
      if (ev.type === "mode.applied") {
        modeAppliedRef.current(ev.name, ev.spec)
        return
      }
      setTranscript((s) => reduce(s, ev))
      if (ev.type === "goal.update") setGoalState(ev.goal)
      // Surface title updates from session list by refreshing occasionally on status idle.
      if (ev.type === "session.status" && ev.status === "idle") {
        void refreshSessions(baseUrl, activeRepoIdRef.current).catch(() => {})
      }
    }

    for (;;) {
      try {
        if (gen !== attachGen.current) return
        setConnectionState(attempt === 0 ? "connecting" : "reconnecting")
        await openEventStream(baseUrl, id, onEvent, ac.signal, onOpen)
        if (ac.signal.aborted || gen !== attachGen.current) return
        setConnectionState("reconnecting")
        attempt += 1
        await sleep(reconnectDelay(attempt - 1), ac.signal)
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
      }
      if (ac.signal.aborted || gen !== attachGen.current) return
      // Full replay on reattach — reset projection to avoid duplicate events.
      setTranscript(initialState)
      setTranscriptLoading(true)
    }
  }, [refreshSessions])

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

  // ---- Boot ----
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const cfg = await loadConfig()
      if (cancelled) return
      setConfig(cfg)

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

        let repoId: string | null = null
        if (reg) {
          const remembered = localStorage.getItem(ACTIVE_REPO_KEY)
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
          `Can't reach Chunky server at ${cfg.baseUrl}. Start it with \`bun run server\`, or continue in demo mode. (${(err as Error).message})`,
        )
      }
    })()
    return () => {
      cancelled = true
      streamAbort.current?.abort()
      if (settleTimer.current != null) clearTimeout(settleTimer.current)
    }
  }, [openRepoThreads])

  // Poll model selection lightly so external changes show up.
  useEffect(() => {
    if (!config || appMode !== "live") return
    const t = setInterval(() => {
      void fetchModel(config.baseUrl).then((m) => m && setModelSel(m))
    }, 15_000)
    return () => clearInterval(t)
  }, [config, appMode])

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
    const [sel, rows] = await Promise.all([
      fetchModel(config.baseUrl),
      listAllModels(config.baseUrl),
    ])
    if (sel) setModelSel(sel)
    setModelRows(rows)
  }, [config, appMode])

  /** Saved modes → slash aliases. Demo/offline never touches the server. */
  const refreshModes = useCallback(async () => {
    if (appMode !== "live") {
      setSlashModes([])
      return
    }
    try {
      const { modes } = await getModes()
      setSlashModes(modeCommands(modes, (m) => `Apply mode: ${prettyModel(m.model)}`))
    } catch {
      /* keep the last known aliases; the menu is a convenience, not state */
    }
  }, [appMode])

  useEffect(() => {
    if (appMode !== "live") {
      setSlashModes([])
      return
    }
    if (connectionState !== "connected") return
    void refreshModes()
  }, [appMode, connectionState, refreshModes])

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
    [refreshModels, refreshModes],
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
      await refreshSessions(config.baseUrl, repoId)
      void attachSession(config.baseUrl, created.sessionId)
    } catch (err) {
      setConnError((err as Error).message)
    }
  }, [live, stopDemoStream, activeThread.projectId, config, refreshSessions, attachSession])

  const handleSelectRepo = useCallback(
    async (id: string) => {
      if (!config || id === activeRepoIdRef.current) return
      setActiveRepoId(id)
      activeRepoIdRef.current = id
      try {
        localStorage.setItem(ACTIVE_REPO_KEY, id)
      } catch {
        /* ignore */
      }
      // Drop current stream before loading the other repo's threads.
      streamAbort.current?.abort()
      setSessions([])
      setSessionId(null)
      setTranscript(initialState)
      setTranscriptLoading(true)
      await openRepoThreads(config.baseUrl, id)
    },
    [config, openRepoThreads],
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
        if (openId) {
          try {
            localStorage.setItem(ACTIVE_REPO_KEY, openId)
          } catch {
            /* ignore */
          }
        }
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

  const handleRemoveRepo = useCallback(
    async (id: string) => {
      if (!config) return
      const repo = repos.find((r) => r.id === id)
      const ok = window.confirm(
        `Remove ${repo?.name ?? "this repo"} from the list?\n\nThis only unregisters the folder in Chunky — files and threads on disk stay put. You can add it back any time.`,
      )
      if (!ok) return
      try {
        const wasOpen = id === activeRepoIdRef.current
        const reg = await removeRepo(config.baseUrl, id)
        setRepos(reg.repos)
        delete lastSessionByRepo.current[id]
        try {
          localStorage.setItem(LAST_SESSION_KEY, JSON.stringify(lastSessionByRepo.current))
        } catch {
          /* ignore */
        }
        if (wasOpen) {
          const openId = reg.activeId ?? reg.repos[0]?.id ?? null
          setActiveRepoId(openId)
          activeRepoIdRef.current = openId
          if (openId) {
            try {
              localStorage.setItem(ACTIVE_REPO_KEY, openId)
            } catch {
              /* ignore */
            }
          }
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
      if (dialog === "fork") { const fork = await forkSession(config.baseUrl, sessionId, { worktree: forkWorktree, directive: dialogText.trim() || undefined }); setNotice(`Forked a new session${fork.worktree ? ` in ${fork.worktree.branch}` : ""}.`); await refreshSessions(config.baseUrl) }
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
        const detail = applied?.model
          ? `: ${prettyModel(applied.model)}${applied.effort ? ` (${applied.effort})` : ""} · ${applied.provider}`
          : ""
        setNotice(`Mode "${applied?.applied || name}" applied${detail}.`)
      } catch (err) {
        setNotice(`Mode "${name}": ${(err as Error).message}`)
      }
    },
    [refreshModels, refreshModes, markSelfApplied],
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
    [refreshModels, refreshModes, markSelfApplied],
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
          openSettingsAt("sidekick")
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
    async (m: Model) => {
      if (!live) {
        setDemoModel(m)
        return
      }
      if (!config) throw new Error("Not connected")
      const parts = splitModelKey(m.id)
      if (!parts) throw new Error(`Invalid model id: ${m.id}`)
      // Await server confirmation before the picker treats the switch as done.
      const next = await selectModel(config.baseUrl, {
        provider: parts.provider,
        model: parts.model,
      })
      setModelSel(next)
    },
    [live, config],
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
    try {
      const [info, reg, sel, rows] = await Promise.all([
        fetchServerInfo(config.baseUrl),
        listRepos(config.baseUrl).catch(() => null),
        fetchModel(config.baseUrl),
        listAllModels(config.baseUrl).catch(() => [] as ModelRow[]),
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
        void attachSession(config.baseUrl, sessionIdRef.current)
        void refreshSessions(config.baseUrl, activeRepoIdRef.current).catch(() => {})
      } else {
        await openRepoThreads(config.baseUrl, activeRepoIdRef.current)
      }
    } catch (err) {
      setConnectionState("offline")
      setConnError(
        `Can't reach Chunky server at ${config.baseUrl}. (${(err as Error).message})`,
      )
    }
  }, [config, attachSession, openRepoThreads, refreshSessions])

  const paletteActions = useMemo<PaletteAction[]>(() => [
    { id: "new", label: "New session", hint: "⌘N", group: "Session" },
    ...repos.map((repo) => ({ id: `repo:${repo.id}`, label: `Switch repo: ${repo.name}`, group: "Repositories" })),
    ...sessions.map((session) => ({ id: `session:${session.sessionId}`, label: `Switch session: ${session.title || session.sessionId.slice(0, 8)}`, group: "Sessions" })),
    ...uiModels.map((model) => ({ id: `model:${model.id}`, label: `Switch model: ${model.name}`, group: "Models" })),
    ...["Rename session", "Fork session", "Rewind to turn", "Goal mode", "Ship it", "Usage & scoreboard"].map((label) => ({ id: `action:${label}`, label, group: "Session" })),
    { id: "theme", label: "Toggle theme", group: "Appearance" },
    { id: "browser", label: browserOpen ? "Close browser" : "Open browser", group: "Workspace" },
    { id: "settings", label: "Open Settings", hint: "⌘,", group: "Integration" },
    { id: "onboarding", label: "Run Onboarding", group: "Integration" },
  ], [repos, sessions, uiModels, browserOpen])

  const runAction = useCallback(
    (a: PaletteAction) => {
      if (a.id === "new") void handleNewThread()
      else if (a.id === "theme") toggle()
      else if (a.id === "browser") setBrowserOpen((open) => !open)
      else if (a.id === "settings") setSettingsOpen(true)
      else if (a.id === "onboarding") { if (live) setOnboardingOpen(true) }
      else if (a.id.startsWith("repo:")) void handleSelectRepo(a.id.slice(5))
      else if (a.id.startsWith("session:")) handleSelectThread(a.id.slice(8))
      else if (a.id.startsWith("model:")) { const model = uiModels.find((item) => item.id === a.id.slice(6)); if (model) void handleModelChange(model) }
      else if (a.id.startsWith("action:")) { const kind = a.id.slice(7); const map: Record<string, NonNullable<typeof dialog>> = { "Rename session": "rename", "Fork session": "fork", "Rewind to turn": "rewind", "Goal mode": "goal", "Ship it": "ship", "Usage & scoreboard": "stats" }; void openDialog(map[kind]!) }
    },
    [handleNewThread, toggle, handleSelectRepo, handleSelectThread, uiModels, handleModelChange, openDialog, live],
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

  const themeToggle = (
    <Tooltip>
      <TooltipTrigger render={<Button variant="ghost" size="icon-sm" onClick={toggle} />}>
        <Sun className={cn("size-4 transition-all", resolved === "dark" && "hidden")} />
        <Moon className={cn("size-4 transition-all", resolved === "light" && "hidden")} />
      </TooltipTrigger>
      <TooltipPopup>{resolved === "dark" ? "Light mode" : "Dark mode"}</TooltipPopup>
    </Tooltip>
  )

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
            thread={activeThread}
            headerRight={<>{incognitoSession && <span title="This session is off the record — nothing is written to disk." className="flex items-center gap-1 rounded-full border border-destructive/40 bg-destructive/10 px-2 py-1 font-medium text-[11px] text-destructive"><EyeOff className="size-3" />Incognito</span>}{goal && <button type="button" onClick={() => void openDialog("goal")} className="rounded-full border border-primary/30 bg-primary/10 px-2 py-1 text-[11px] font-medium text-primary">Goal · {goal.status}{goal.turns != null ? ` · ${goal.turns} turns` : ""}</button>}{themeToggle}</>}
            onRename={() => void openDialog("rename")} onFork={() => void openDialog("fork")} onRewind={() => void openDialog("rewind")} onGoal={() => void openDialog("goal")} onShip={() => void openDialog("ship")} onStats={() => void openDialog("stats")}
            repos={live ? repos : undefined}
            activeRepoId={activeRepoId}
            onSelectRepo={(id) => void handleSelectRepo(id)}
            onAddRepo={handleAddRepo}
            onRemoveRepo={(id) => void handleRemoveRepo(id)}
            reposBusy={addingRepo}
            reposDisabled={!live || connectionState === "booting"}
            onToggleBrowser={() => setBrowserOpen((open) => !open)}
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
              <div className="flex flex-col gap-2">
                <TodosPanel todos={liveTodos} />
                <QueueChips entries={liveQueue} />
                <Composer
                model={uiModel}
                models={uiModels}
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
                openModelPickerSignal={modelPickerSignal}
                streaming={streaming}
                onStop={handleStop}
                contextMeter={<ContextMeter usage={liveUsage} limit={contextLimit} />}
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
            {browserOpen ? <BrowserPane onClose={() => setBrowserOpen(false)} /> : null}
          </section>
        </div>

        <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} onRun={runAction} actions={paletteActions} />
        <SettingsCenter
          open={settingsOpen}
          onOpenChange={(open) => {
            setSettingsOpen(open)
            if (!open && live && config) {
              void refreshModels()
              void refreshModes()
            }
          }}
          initialSection={settingsSection}
          onModesChanged={() => {
            void refreshModels()
            void refreshModes()
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
        />
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
