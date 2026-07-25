import { AlertCircle, Moon, Sun, WifiOff } from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { ChatTopBar, ChatView } from "./components/ChatView"
import { CommandPalette } from "./components/CommandPalette"
import { Composer } from "./components/Composer"
import { SettingsDialog } from "./components/SettingsDialog"
import { Sidebar } from "./components/Sidebar"
import { Button } from "./components/ui/button"
import { Tooltip, TooltipPopup, TooltipProvider, TooltipTrigger } from "./components/ui/tooltip"
import {
  addRepo,
  createSession,
  fetchModel,
  fetchServerInfo,
  interruptSession,
  listAllModels,
  listRepos,
  listSessions,
  loadConfig,
  openEventStream,
  prettyModel,
  QueueFullError,
  removeRepo,
  selectModel,
  sendMessage,
  splitModelKey,
  type AppConfig,
  type ModelRow,
  type ModelSelection,
  type Repo,
  type SessionSummary,
} from "./lib/api"
import { cn } from "./lib/cn"
import {
  MODELS,
  PROJECTS,
  THREADS,
  type Model,
  type PaletteAction,
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
  const { mode, setMode, resolved, toggle } = useTheme()

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

  // ---- Demo/mock fallback state (preserved polish) ----
  const [demoThreads, setDemoThreads] = useState<Thread[]>(THREADS)
  const [demoActiveId, setDemoActiveId] = useState(THREADS[0]!.id)
  const [demoModel, setDemoModel] = useState<Model>(MODELS[0]!)
  const [demoStreamingId, setDemoStreamingId] = useState<string | null>(null)
  const demoTimer = useRef<ReturnType<typeof setInterval> | null>(null)

  const [paletteOpen, setPaletteOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)

  const streamAbort = useRef<AbortController | null>(null)
  const settleTimer = useRef<number | null>(null)
  const sessionIdRef = useRef<string | null>(null)
  const activeRepoIdRef = useRef<string | null>(null)
  const repoListGen = useRef(0)
  const attachGen = useRef(0)
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
      setTranscript((s) => reduce(s, ev))
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
    async (text: string) => {
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
        const blocked = await sendMessage(config.baseUrl, sessionId, text)
        if (blocked?.blocked === "cache-cold") {
          // Phase 0: auto-confirm with force so the user isn't stuck.
          const again = await sendMessage(config.baseUrl, sessionId, text, { force: true })
          if (again) {
            setSendError("Send blocked by cache guard even after confirm.")
          }
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

  const runAction = useCallback(
    (a: PaletteAction) => {
      if (a.id === "new-thread" || a.id === "new-project") void handleNewThread()
      else if (a.id === "toggle-theme") toggle()
      else if (a.id === "settings") setSettingsOpen(true)
      else if (a.id.startsWith("model-")) {
        const m = uiModels.find((x) => a.label.includes(x.name))
        if (m) void handleModelChange(m)
      } else if (a.id.startsWith("thread-")) {
        const t = threads.find((x) => x.title === a.label)
        if (t) handleSelectThread(t.id)
      }
    },
    [handleNewThread, toggle, uiModels, handleModelChange, threads, handleSelectThread],
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
            headerRight={themeToggle}
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
            />
            <Composer
              model={uiModel}
              models={uiModels}
              onModelChange={handleModelChange}
              onRefreshModels={live ? refreshModels : undefined}
              onSend={(t) => void handleSend(t)}
              streaming={streaming}
              onStop={handleStop}
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

        <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} onRun={runAction} />
        <SettingsDialog
          open={settingsOpen}
          onOpenChange={setSettingsOpen}
          mode={mode}
          onModeChange={setMode}
          connection={{
            state: live ? connectionState : "offline",
            baseUrl: config?.baseUrl ?? "http://localhost:4620",
            workspace: activeRepo?.path || workspace || config?.workspace || "",
            sessionCount: sessions.length,
            mode: appMode,
          }}
        />
      </div>
    </TooltipProvider>
  )
}
