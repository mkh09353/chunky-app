import { AlertCircle, Moon, Sun, WifiOff } from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { ChatTopBar, ChatView } from "./components/ChatView"
import { CommandPalette } from "./components/CommandPalette"
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPopup, DialogTitle } from "./components/ui/dialog"
import { Composer } from "./components/Composer"
import { SettingsCenter } from "./components/settings/SettingsCenter"
import { needsOnboarding, OnboardingWizard } from "./components/settings/OnboardingWizard"
import { Sidebar } from "./components/Sidebar"
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
import type { GoalSnapshot, RewindPoint } from "@chunky/protocol"
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
import { useTheme } from "./lib/theme"
import { initialState, isStreaming, reduce, type TranscriptState } from "./lib/transcript"

type ConnectionState = "booting" | "connecting" | "connected" | "reconnecting" | "offline" | "error"
type AppMode = "live" | "demo"

const REPLAY_SETTLE_MS = 120
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
  const [cacheGuard, setCacheGuard] = useState<{ text: string; images: { base64: string; mediaType: string }[]; approxTokens: number; reason: string; delivery?: "interject" } | null>(null)
  const [foldThreads, setFoldThreads] = useState(false)
  const [goal, setGoalState] = useState<GoalSnapshot | null>(null)
  const [dialog, setDialog] = useState<"rename" | "fork" | "rewind" | "goal" | "ship" | "stats" | null>(null)
  const [dialogText, setDialogText] = useState("")
  const [rewindPoints, setRewindPoints] = useState<RewindPoint[]>([])
  const [selectedRewind, setSelectedRewind] = useState<RewindPoint | null>(null)
  const [forkWorktree, setForkWorktree] = useState(false)
  const [goalWorkflows, setGoalWorkflows] = useState(false)
  const [goalTurns, setGoalTurns] = useState("")
  const [stats, setStats] = useState<{ usage: unknown; scoreboard: unknown } | null>(null)
  const [statsTab, setStatsTab] = useState<"usage" | "scoreboard">("usage")
  const [notice, setNotice] = useState<string | null>(null)

  // ---- Demo/mock fallback state (preserved polish) ----
  const [demoThreads, setDemoThreads] = useState<Thread[]>(THREADS)
  const [demoActiveId, setDemoActiveId] = useState(THREADS[0]!.id)
  const [demoModel, setDemoModel] = useState<Model>(MODELS[0]!)
  const [demoStreamingId, setDemoStreamingId] = useState<string | null>(null)
  const demoTimer = useRef<ReturnType<typeof setInterval> | null>(null)

  const [paletteOpen, setPaletteOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [onboardingOpen, setOnboardingOpen] = useState(false)

  const streamAbort = useRef<AbortController | null>(null)
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
    async (text: string, opts: { delivery?: "interject"; images?: { base64: string; mediaType: string }[] } = {}) => {
      setSendError(null)
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

  const openDialog = useCallback(async (kind: NonNullable<typeof dialog>) => {
    if (!live || !config || !sessionId) return
    setDialogText(kind === "rename" ? (sessions.find((s) => s.sessionId === sessionId)?.title ?? "") : "")
    setSelectedRewind(null)
    if (kind === "rewind") setRewindPoints(await getRewindPoints(config.baseUrl, sessionId).catch(() => []))
    if (kind === "stats") { setStatsTab("usage"); setStats(await Promise.all([getUsage(config.baseUrl, sessionId), getScoreboard(config.baseUrl, sessionId)]).then(([usage, scoreboard]) => ({ usage, scoreboard })).catch(() => null)) }
    setDialog(kind)
  }, [live, config, sessionId, sessions])

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
    { id: "settings", label: "Open Settings", hint: "⌘,", group: "Integration" },
    { id: "onboarding", label: "Run Onboarding", group: "Integration" },
  ], [repos, sessions, uiModels])

  const runAction = useCallback(
    (a: PaletteAction) => {
      if (a.id === "new") void handleNewThread()
      else if (a.id === "theme") toggle()
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
            headerRight={<>{goal && <button type="button" onClick={() => void openDialog("goal")} className="rounded-full border border-primary/30 bg-primary/10 px-2 py-1 text-[11px] font-medium text-primary">Goal · {goal.status}{goal.turns != null ? ` · ${goal.turns} turns` : ""}</button>}{themeToggle}</>}
            onRename={() => void openDialog("rename")} onFork={() => void openDialog("fork")} onRewind={() => void openDialog("rewind")} onGoal={() => void openDialog("goal")} onShip={() => void openDialog("ship")} onStats={() => void openDialog("stats")}
            repos={live ? repos : undefined}
            activeRepoId={activeRepoId}
            onSelectRepo={(id) => void handleSelectRepo(id)}
            onAddRepo={handleAddRepo}
            onRemoveRepo={(id) => void handleRemoveRepo(id)}
            reposBusy={addingRepo}
            reposDisabled={!live || connectionState === "booting"}
          />

          <section className="content-panel flex min-h-0 min-w-0 flex-1 flex-col">
            {statusBanner}
            <ChatView
              thread={activeThread}
              streamingId={liveStreamingId}
              loading={live && transcriptLoading}
              transcript={live ? transcript : undefined}
              modelName={uiModel.name}
              foldAll={foldThreads}
            />
            {(transcript.background.tasks > 0 || transcript.background.monitors > 0) && <div className="px-5 pb-1 text-center text-[11px] text-muted-foreground">Background: {transcript.background.tasks} task{transcript.background.tasks === 1 ? "" : "s"} · {transcript.background.monitors} monitor{transcript.background.monitors === 1 ? "" : "s"}</div>}
            <Composer
              model={uiModel}
              models={uiModels}
              onModelChange={handleModelChange}
              onRefreshModels={live ? refreshModels : undefined}
              onSend={(t, opts) => void handleSend(t, opts)}
              onSearchFiles={live && config ? (query) => searchFiles(config.baseUrl, query, activeRepoId) : undefined}
              streaming={streaming}
              onStop={handleStop}
              queue={transcript.queue.entries}
              todos={transcript.todos}
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
          </section>
        </div>

        <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} onRun={runAction} actions={paletteActions} />
        <SettingsCenter
          open={settingsOpen}
          onOpenChange={(open) => {
            setSettingsOpen(open)
            if (!open && live && config) void refreshModels()
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
        {notice && <div className="fixed right-5 bottom-5 z-50 rounded-xl border border-primary/25 bg-popover px-4 py-3 text-[13px] shadow-panel"><span>{notice}</span><button type="button" className="ml-3 text-primary" onClick={() => setNotice(null)}>Dismiss</button></div>}
        <Dialog open={dialog !== null} onOpenChange={(open) => !open && setDialog(null)}><DialogPopup>
          <DialogHeader><DialogTitle>{dialog === "rename" ? "Rename session" : dialog === "fork" ? "Fork session" : dialog === "rewind" ? "Rewind session" : dialog === "goal" ? "Goal mode" : dialog === "ship" ? "Ship it" : "Usage & scoreboard"}</DialogTitle><DialogDescription>{dialog === "rewind" ? "Choose a completed turn, then explicitly confirm restoring files and conversation." : dialog === "ship" ? "Optional notes for the handoff brief." : ""}</DialogDescription></DialogHeader>
          <div className="px-6 pb-2">{(dialog === "rename" || dialog === "fork" || dialog === "goal" || dialog === "ship") && <textarea value={dialogText} onChange={(event) => setDialogText(event.target.value)} placeholder={dialog === "goal" ? "Objective…" : dialog === "fork" ? "Optional directive…" : dialog === "ship" ? "Optional handoff notes…" : "Session title"} className="min-h-20 w-full rounded-lg border border-input bg-transparent p-2 text-sm outline-none focus:ring-2 focus:ring-ring/40" />}{dialog === "fork" && <label className="mt-3 flex gap-2 text-sm"><input type="checkbox" checked={forkWorktree} onChange={(event) => setForkWorktree(event.target.checked)} /> Create a git worktree</label>}{dialog === "goal" && <><label className="mt-3 flex gap-2 text-sm"><input type="checkbox" checked={goalWorkflows} onChange={(event) => setGoalWorkflows(event.target.checked)} /> Use workflows mode</label><input value={goalTurns} onChange={(event) => setGoalTurns(event.target.value)} placeholder="Optional max turns" inputMode="numeric" className="mt-2 w-full rounded-lg border border-input bg-transparent p-2 text-sm" />{goal && <div className="mt-3 flex gap-2"><Button size="sm" variant="outline" onClick={() => void goalAction(goal.status === "active" ? "pause" : "resume")}>{goal.status === "active" ? "Pause" : "Resume"}</Button><Button size="sm" variant="outline" onClick={() => void goalAction("clear")}>Clear</Button></div>}</>}{dialog === "rewind" && <div className="max-h-60 overflow-auto">{rewindPoints.map((point) => <button type="button" onClick={() => setSelectedRewind(point)} key={point.turn} className={`mb-1 w-full rounded-lg border p-2 text-left text-sm ${selectedRewind?.turn === point.turn ? "border-primary bg-primary/10" : "border-border"}`}>Turn {point.turn} · {point.userText}</button>)}{selectedRewind && <p className="mt-2 text-xs text-destructive">Confirming restores files AND conversation to turn {selectedRewind.turn}.</p>}</div>}{dialog === "stats" && <><div className="mb-2 flex gap-1 border-b border-border"><button type="button" onClick={() => setStatsTab("usage")} className={`px-3 py-2 text-sm ${statsTab === "usage" ? "border-primary border-b-2 text-primary" : "text-muted-foreground"}`}>Usage</button><button type="button" onClick={() => setStatsTab("scoreboard")} className={`px-3 py-2 text-sm ${statsTab === "scoreboard" ? "border-primary border-b-2 text-primary" : "text-muted-foreground"}`}>Scoreboard</button></div><pre className="max-h-80 overflow-auto rounded-lg bg-muted p-3 text-[11px]">{JSON.stringify(stats?.[statsTab], null, 2)}</pre></>}</div>
          <DialogFooter>{dialog !== "stats" && <Button onClick={() => void runDialog()} disabled={(dialog === "rewind" && !selectedRewind) || (dialog === "rename" && !dialogText.trim())}>{dialog === "rewind" ? "Confirm restore" : dialog === "goal" ? "Start goal" : dialog === "ship" ? "Ship it" : "Continue"}</Button>}</DialogFooter>
        </DialogPopup></Dialog>
      </div>
    </TooltipProvider>
  )
}
