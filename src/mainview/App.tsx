import { AlertCircle, EyeOff, WifiOff } from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { ChatTopBar, ChatView } from "./components/ChatView"
import { CommandPalette } from "./components/CommandPalette"
import { SessionPortsPopover } from "./components/SessionPortsPopover"
import { VoiceButton } from "./components/VoiceButton"
import { VoiceHud } from "./components/VoiceHud"
import { codeToLabel } from "./lib/pushToTalk"
import { useVoiceAgent } from "./hooks/useVoiceAgent"
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPopup, DialogTitle } from "./components/ui/dialog"
import { Composer, type ModeOption } from "./components/Composer"
import { QuickKeys } from "./components/QuickKeys"
import { quickKeyForHotkey, type QuickKey } from "./lib/quickKeys"
import { SettingsCenter } from "./components/settings/SettingsCenter"
import {
  devOnboardingRequested,
  needsOnboarding,
  OnboardingWizard,
} from "./components/settings/OnboardingWizard"
import { ContextMeter } from "./components/ContextMeter"
import { QueueChips } from "./components/QueueChips"
import { ActiveWorkersStrip } from "./components/ActiveWorkersStrip"
import { TodosPanel } from "./components/TodosPanel"
import { loadTerminalsOpen, TerminalDrawer } from "./components/TerminalDrawer"
import { GitToolbar } from "./components/GitPanel"
import { gitIdentity } from "./lib/git"
import { pickDisplayName } from "./lib/identity"
import { Sidebar } from "./components/Sidebar"
import { PrWidget } from "./components/PrWidget"
import { PrPanel } from "./components/PrPanel"
import { SidekickPicker } from "./components/SidekickPicker"
import { BrowserPane } from "./components/BrowserPane"
import { ZooWorkspace } from "./components/zoo/ZooWorkspace"
import { RepoFilesPane } from "./components/RepoFilesPane"
import { ExternalLinkMenu } from "./components/ExternalLinkMenu"
import { ApiKeyRequestHost } from "./components/ApiKeyDialog"
import { ConfirmHost } from "./components/ConfirmDialog"
import { confirm } from "./lib/confirm"
import { FileLinkProvider } from "./lib/fileLinkContext"
import { announceAppBrowserTarget, resetAppBrowserAnnounce } from "./lib/appBrowser"
import { announceAppZooTarget, resetAppZooAnnounce } from "./lib/appZoo"
import { subscribeBrowserNavigation } from "./lib/browserNav"
import { resolvePaneSlot } from "./lib/browserPaneSlot"
import { getPrReviews, refreshPrReviews } from "./lib/prApi"
import {
  hasNewActivity,
  loadPrLastSeen,
  savePrLastSeen,
  summarize,
} from "./lib/prReviews"
import type { PrReviewsState } from "@chunky/protocol"
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
  delegatesAvailable,
  stopDelegate,
  stopDelegateAvailable,
  forkSession, getGoal, getRewindPoints, getScoreboard, getUsage, renameSession, rewindSession, setGoal, shipSession,
  listAllModels,
  listRepos,
  listSessions,
  loadConfig,
  openSessionStream,
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
import { applyMode, deleteMode, getCacheGuard, getModes, getSessionAgentConfig, getSoloAdvisorStatus, saveMode, setCacheGuard as saveCacheGuardTokens, type AdvisorStatus, type SessionAgentConfig, type SidekickConfig } from "./lib/configApi"
import { buildComposerStatus } from "./lib/composerStatus"
import { isSoloActive } from "./lib/solo"
import { activeModeName, modeChipLabel, sessionModeName } from "./lib/modes"
import { ComposerStatus } from "./components/ComposerStatus"
import {
  defaultCloneParent,
  extractClonePath,
  joinPath,
  parseGitUrl,
  runCloneSession,
} from "./lib/cloneRepo"
import { cloneRoots } from "./lib/dirSearch"
import { reresolveConnection, subscribeServerChanged } from "./lib/reresolve"
import {
  describeSetupStage,
  subscribeSetupStage,
  type SetupStage,
} from "./lib/setupStatus"
import { OldServersNotice } from "./components/OldServersNotice"
import { classifyServers, subscribeOldServers } from "./lib/oldServers"
import { serverMismatchWarning } from "./lib/serverMismatch"
import { inspectChunkyServers, type ServerInspection } from "./lib/serverLifecycle"
import {
  desktopUiSnapshot,
  displayNameSnapshot,
  forgetRepoSessions,
  loadDesktopUiState,
  quickKeysSnapshot,
  pinnedSessionsSnapshot,
  rememberActiveRepo,
  saveDisplayName,
  savePinnedSessions,
  saveQuickKeys,
  saveSessionShelves,
  sessionShelvesSnapshot,
} from "./lib/desktopState"
import { pinsFromRecord, prunePins, setPin } from "./lib/sessionPins"
import {
  classifyShelf,
  reconcileShelfPins,
  shelfPinsFromRecord,
  type ShelfPin,
} from "./lib/sessionShelf"
import { useMinuteClock } from "./hooks/useMinuteClock"
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
import type { GoalSnapshot, ModeInfo, ModeSpec, QueueEntry, RewindPoint, StopDelegateRequest } from "@chunky/protocol"
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
import { isIntentionalAbort, sleep } from "./lib/reconnect"
import type { MessageDelivery, SessionDelta } from "@chunky/protocol"
import { useTheme } from "./lib/theme"
import { initialState, isStreaming, isTreeIdle, mainItems } from "./lib/transcript"
import { SessionCache } from "./lib/sessionCache"
import {
  createPendingSend,
  dropPendingSend,
  markPendingSendFailed,
  samePendingSends,
  shouldAppendOptimistically,
  unresolvedPendingSends,
} from "./lib/pendingSends"
import {
  absorbAuthoritative,
  applySessionDelta,
  applySessionSnapshot,
  createCompletionTracker,
  forgetRepoTracking,
  isSessionBusy,
  mergeSummaryLists,
  sameSummaryList,
  sessionsInWorkspace,
  sessionsWithoutRepository,
  trackCompletions,
  unionSummaries,
  type SummaryMap,
} from "./lib/sessionSummaries"
import {
  addUnreadSessions,
  buildRepoActivity,
  clearUnreadSession,
  sameRepoRows,
} from "./lib/repoActivity"
import { ActivityOverlay } from "./components/ActivityOverlay"
import {
  buildHomeFeed,
  homeGoalCandidates,
  updateBusySince,
  type FeedRepo,
} from "./lib/homeFeed"
import { HomeView } from "./components/HomeView"
import { UsageView } from "./components/UsageView"
import { EvalsView } from "./components/EvalsView"
import { useAttachedSession, type AppMode, type ConnectionState } from "./hooks/useAttachedSession"
import hornUrl from "./assets/horn.wav"

/** Safety poll while the session stream is healthy: it only has to catch what
 *  shell rows cannot express (a detached spawn settling with the root idle). */
const SAFETY_POLL_MS = 20_000
/** Poll cadence when the session stream is unavailable (older server, or it
 *  dropped) — the behaviour this app had before the stream existed. */
const FALLBACK_POLL_MS = 5_000
/** Debounce on the targeted poll that confirms a `busy` the stream can't state. */
const BUSY_CONFIRM_MS = 300
/** Floor between two such polls, so a long-running delegate cannot turn every
 *  streamed delta into a request. */
const BUSY_CONFIRM_GAP_MS = 2_000
const SESSION_STREAM_RETRY_MS = 5_000
/** The retirement check keeps its own cadence: handover latency must not follow
 *  the session-summary cadence. */
const RETIREMENT_POLL_MS = 5_000
/** Recent agent-activity lines kept for the clone popover's progress log. */
const CLONE_LOG_LINES = 8

/** How long a local apply suppresses the echoed mode.applied notice. */
const SELF_APPLY_WINDOW_MS = 10_000
const MIN_COMPLETION_NOTIFY_MS = 3_000
/** Home's elapsed times are in seconds, so it keeps a faster clock than the
 *  sidebar's minute heartbeat — but only while it is the surface on screen. */
const HOME_CLOCK_MS = 5_000
/** How often Home re-asks which sessions are blocked. One GET per candidate
 *  session, so this is deliberately slow: a blocked goal is not a race. */
const HOME_GOAL_SWEEP_MS = 45_000
/** Let the app settle before looking for servers left over from a previous run. */
const OLD_SERVER_SCAN_DELAY_MS = 8_000

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

/**
 * The message that seeds a "set this provider up for me" session (Settings →
 * Providers → + Custom → "Set it up with a chat").
 *
 * Plain text on purpose: it is a real user message in the transcript, not a
 * hidden system prompt. It never carries a credential — the agent is told to
 * send the user back to the form for that, because keys must not land in a
 * transcript.
 */
function providerSetupBrief(providerName: string, baseURL?: string): string {
  const where = baseURL ? ` Its base URL is ${baseURL}.` : ""
  return (
    `I want to add ${providerName} as a model provider in Chunky.${where} ` +
    `Work out how ${providerName} exposes an OpenAI-compatible API — the base URL and chat-completions route — ` +
    `and whether it authenticates with an API key or with OAuth, then tell me in a sentence or two what you found. ` +
    `Register it with the manage_providers tool, then call request_api_key so the app can collect the key from me securely, ` +
    `and finish with a manage_providers test to confirm the credential works. ` +
    `Never ask me to type or paste the key into this chat — request_api_key opens a secure dialog in the app for that. ` +
    `If you need me to fetch the key from ${providerName} first, tell me where to get it and then request it.`
  )
}

/** One repository's qualifying completions from a single fold.
 *
 *  `done` is what lets the far-left overview say WHICH sessions just finished
 *  rather than only that a repo has news — the repo-level dot is derived from
 *  the same result, so the two can never disagree. */
interface RepoCompletion {
  repoId: string
  done: string[]
}

/** Durable pseudo-tab key. Never sent to the server as a repository id. */
const NO_REPO_SCOPE = "__no_repo__"

export function App() {
  const { resolved, toggle } = useTheme()

  // ---- Live server state ----
  const [config, setConfig] = useState<AppConfig | null>(null)
  const [connectionState, setConnectionState] = useState<ConnectionState>("booting")
  const [connError, setConnError] = useState<string | null>(null)
  const [serverWarning, setServerWarning] = useState<string | null>(null)
  // First-run install progress pushed by Bun. Disposable: null on a warm launch
  // (and cleared once the connection resolves), so the banner keeps its usual
  // wording whenever there is nothing extra to say.
  const [setupStage, setSetupStage] = useState<SetupStage | null>(null)
  const [appMode, setAppMode] = useState<AppMode>("live")
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  // Sessions to revisit: completion adds unselected rows automatically, and a
  // row context menu can add/remove the same marker manually. Clicking a row
  // acknowledges and clears its marker, including the already-active row.
  const [unreadDone, setUnreadDone] = useState<Set<string>>(new Set())
  // Explicit sidebar shelf choices (settle / move to active), keyed by session.
  // Durable per device: the protocol has no settled lifecycle, so desktop.json
  // is the only record. Absent = the sidebar decides for itself.
  const [shelfPins, setShelfPins] = useState<ReadonlyMap<string, ShelfPin>>(() =>
    shelfPinsFromRecord(sessionShelvesSnapshot()),
  )
  // Threads the user stuck to the top of the sidebar, mapped to when they were
  // pinned. A third axis, independent of shelf and archive (see lib/sessionPins)
  // and durable per device for the same reason: the protocol has no pin.
  const [pinnedSessions, setPinnedSessions] = useState<ReadonlyMap<string, number>>(() =>
    pinsFromRecord(pinnedSessionsSnapshot()),
  )
  const selectedTracker = useRef(createCompletionTracker())
  // Sessions outside the selected repo are not in `sessions`, so their
  // transition bookkeeping is deliberately separate from the sidebar's list
  // (and keyed by `${repoId}:${sessionId}`).
  const backgroundTracker = useRef(createCompletionTracker())
  const [unreadRepoIds, setUnreadRepoIds] = useState<Set<string>>(new Set())
  // Every repository's rows, published from the same loop that feeds the
  // sidebar (no extra requests). The far-left overview and Home read this.
  const [repoRows, setRepoRows] = useState<ReadonlyMap<string, SessionSummary[]>>(new Map())
  // Which surface owns the main panel. Session state, never persisted: Home is
  // a thing you open, not a mode the app remembers for you. The chat column
  // stays MOUNTED behind it so a round-trip cannot cost the reader their scroll
  // position (or a re-attach).
  const [mainView, setMainView] = useState<"chat" | "home" | "usage" | "zoo" | "evals">("chat")
  // sessionId -> when THIS client first saw the session busy, for Home's
  // elapsed times. Absent = we started watching mid-run and cannot say.
  const [busySince, setBusySince] = useState<ReadonlyMap<string, number>>(new Map())
  // sessionId -> goal, for the sessions Home has asked about. Only `blocked`
  // produces a row; a failed sweep just leaves the section short.
  const [homeGoals, setHomeGoals] = useState<ReadonlyMap<string, GoalSnapshot | null>>(new Map())
  const [homeGoalsLoading, setHomeGoalsLoading] = useState(false)
  // Home's own clock (seconds-grained, and only ticking while Home is up).
  const [homeNow, setHomeNow] = useState(() => Date.now())
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
  // Server-side agent config behind the composer status rule. Null = unknown
  // (demo/offline or a failed read) and simply renders no chip.
  const [advisorStatus, setAdvisorStatus] = useState<AdvisorStatus | null>(null)
  // The opt-in advisor that survives solo (lib/solo); null = unknown.
  const [soloAdvisorStatus, setSoloAdvisorStatus] = useState<AdvisorStatus | null>(null)
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
  /** The ONE server base URL that answered "no such endpoint" to
   *  POST .../stop-delegate. Held as a URL rather than a boolean so moving onto
   *  another server — a reconnect, or an in-place upgrade that swaps baseUrl
   *  without remounting — brings the control back by itself. Never persisted. */
  const [stopDelegateUnsupportedOn, setStopDelegateUnsupportedOn] = useState<string | null>(null)
  /** Same idea, same lifetime, for GET .../delegates: the ONE base URL that has
   *  no delegate-status endpoint. Polling stops there and nowhere else, and a
   *  move onto another server starts asking again. */
  const [delegatesUnsupportedOn, setDelegatesUnsupportedOn] = useState<string | null>(null)
  // Superseded servers still running after an upgrade. Dismissal is in-memory
  // on purpose: it should come back next launch if they are still there.
  const [oldServers, setOldServers] = useState<ServerInspection | null>(null)
  const [oldServersDismissed, setOldServersDismissed] = useState(false)

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
  const [filesRepoId, setFilesRepoId] = useState<string | null>(null)
  // The browser pane's mount is one-way (see `resolvePaneSlot`): its native
  // webview may never be disconnected, so "closed" is only ever hidden.
  const [browserMounted, setBrowserMounted] = useState(false)
  const openRepoFiles = useCallback((repoId: string) => {
    setFilesRepoId(repoId)
    setBrowserOpen(false)
  }, [])
  // PR reviews: the board is polled here (the sidebar widget needs it whether or
  // not the panel is open); the slide-over owns actions and setup.
  const [prOpen, setPrOpen] = useState(false)
  const [prState, setPrState] = useState<PrReviewsState | null>(null)
  const [prUnsupported, setPrUnsupported] = useState(false)
  const [prError, setPrError] = useState<string | null>(null)
  const [prLoading, setPrLoading] = useState(false)
  const [prLastSeen, setPrLastSeen] = useState<number | null>(() => loadPrLastSeen())
  // The link context menu's "Open in Chunky browser" mounts the pane; the pane
  // itself picks the URL up from the same store.
  useEffect(() => subscribeBrowserNavigation(() => {
    setFilesRepoId(null)
    setBrowserOpen(true)
  }), [])
  useEffect(() => {
    if (filesRepoId && !repos.some((repo) => repo.id === filesRepoId)) setFilesRepoId(null)
  }, [filesRepoId, repos])
  // One answer for the side slot: the files pane wins it, the browser pane is
  // mounted from the first time it is opened and hidden whenever it is not
  // showing.
  const browserSlot = resolvePaneSlot({
    mounted: browserMounted,
    browserOpen,
    filesShowing: filesRepoId != null,
  })
  useEffect(() => {
    if (browserSlot.mounted && !browserMounted) setBrowserMounted(true)
  }, [browserSlot.mounted, browserMounted])
  // Saved modes as slash aliases ("/fire") + a signal that opens the composer's
  // model picker for `/model`.
  const [slashModes, setSlashModes] = useState<SlashCommand[]>([])
  // Saved definitions are global, but applied/effective configuration is keyed
  // by session so switching chats can never carry a label or delegate display.
  const [savedModes, setSavedModes] = useState<ModeInfo[]>([])
  const [globalMode, setGlobalMode] = useState<string | null>(null)
  const [sessionAgentConfig, setSessionAgentConfig] = useState<Record<string, SessionAgentConfig>>({})
  const [modelPickerSignal, setModelPickerSignal] = useState(0)
  // `/sidekick` inside a live chat edits THIS session only (Settings stays global).
  const [sidekickPickerOpen, setSidekickPickerOpen] = useState(false)
  // Composer quick keys. The list is durable config in desktop.json; the editor's
  // open state is here so the global ⌘⇧<letter> handler can stand down while it
  // is up.
  const [quickKeys, setQuickKeys] = useState<QuickKey[]>(quickKeysSnapshot)
  const [quickKeyEditorOpen, setQuickKeyEditorOpen] = useState(false)
  // Optional sidebar name the user set in Settings. "" = no override.
  const [nameOverride, setNameOverride] = useState<string>(displayNameSnapshot)
  // Quick keys come from Bun-managed desktop.json (the load is memoized, so this
  // shares the boot read); demo/offline builds simply get the empty list.
  useEffect(() => {
    let cancelled = false
    void loadDesktopUiState().then((ui) => {
      if (cancelled) return
      setQuickKeys(ui.quickKeys)
      setNameOverride(ui.displayName)
      setShelfPins(shelfPinsFromRecord(ui.sessionShelves))
      setPinnedSessions(pinsFromRecord(ui.pinnedSessions))
    })
    return () => {
      cancelled = true
    }
  }, [])

  const cloneAbort = useRef<AbortController | null>(null)
  // handleSend runs before the dialog/settings actions are declared, so slash
  // dispatch is reached through a ref (same trick as the TUI's doModeRef).
  const dispatchSlashRef = useRef<(command: string) => Promise<boolean>>(async () => false)
  // Same reason for the live `mode.applied` broadcast: attachSession must keep a
  // stable identity (it seeds the boot effect), so the SSE handler can't take
  // refreshModels/refreshModes as deps — it reads them through this ref.
  const modeAppliedRef = useRef<(name: string, spec: ModeSpec, sessionId?: string) => void>(() => {})
  // Set just BEFORE this window POSTs an apply: the server broadcasts
  // mode.applied to every stream, and the local caller already shows a notice.
  const selfAppliedMode = useRef<{ name: string; at: number } | null>(null)
  const activeRepoIdRef = useRef<string | null>(null)
  const repoListGen = useRef(0)
  // Session lists are populated by both the selected-repo refresh and the
  // existing all-repo poll. Transcript projections are bounded because a
  // lengthy history can be much larger than a sidebar row.
  const repoSessionCache = useRef(new Map<string | null, SessionSummary[]>())
  const sessionCache = useRef(new SessionCache(20))
  /** Monotonic source of optimistic row ids. Distinct from mapTranscript's
   *  `ev-N` ids, so a pending row can never collide with a mapped one. */
  const pendingSendSeq = useRef(0)
  // Every session the server knows about, folded from the session stream and
  // from authoritative polls (see lib/sessionSummaries).
  const shellSummaries = useRef<SummaryMap>(new Map())
  const onboardingChecked = useRef(false)
  // Seeded from the synchronous snapshot, then replaced with the durable
  // desktop.json state once the connection boots (see the live-connect effect).
  const lastSessionByRepo = useRef<Record<string, string>>({
    ...desktopUiSnapshot().lastSessionByRepo,
  })

  activeRepoIdRef.current = activeRepoId

  /** Read global + session effective selection. The server's `pinned` bit is
   * authoritative even when a pin happens to equal the global value. */
  const hydrateSessionModel = useCallback(async (baseUrl: string, id: string | null) => {
    const [globalSel, sessionSel] = await Promise.all([
      fetchModel(baseUrl),
      id ? fetchModel(baseUrl, id) : Promise.resolve(null),
    ])
    if (globalSel) setModelSel(globalSel)
    if (!id || !sessionSel) return
    setSessionModelSel((prev) => {
      if (sessionSel.pinned === true) return { ...prev, [id]: sessionSel }
      if (!(id in prev)) return prev
      const next = { ...prev }
      delete next[id]
      return next
    })
  }, [])
  // ---- Live: refresh sessions for a repo (generation-guarded against tab races) ----
  const refreshSessions = useCallback(
    async (baseUrl: string, repoId: string | null = activeRepoIdRef.current) => {
      const gen = ++repoListGen.current
      const list = await listSessions(baseUrl, repoId, repoId === null ? "none" : undefined)
      if (gen !== repoListGen.current) return list
      // Authoritative rows (they carry `busy`) — fold them into the shared map
      // so a later streamed row can inherit what only a poll can know.
      shellSummaries.current = absorbAuthoritative(shellSummaries.current, list)
      repoSessionCache.current.set(repoId, list)
      sessionCache.current.reconcileRepo(repoId, new Set(list.map((session) => session.sessionId)))
      // Only apply if still viewing this repo (or boot with matching ref).
      if (repoId != null && repoId !== activeRepoIdRef.current) return list
      setSessions(list)
      return list
    },
    [],
  )

  // The attached session's whole SSE machine (hooks/useAttachedSession). Moved
  // out of this component verbatim; the names below are the ones the rest of
  // App already used, so every call site downstream is unchanged.
  const {
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
  } = useAttachedSession({
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
  })

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

  // Pinned mode identity is authoritative per session. Inheriting sessions use
  // the saved mode matching the global pairing; their snapshot intentionally
  // has activeMode=null even though the complete default mode is in effect.
  const activeMode = live && sessionId
    ? sessionModeName(
        sessionAgentConfig[sessionId]?.source,
        sessionAgentConfig[sessionId]?.activeMode,
        globalMode,
      )
    : null
  // Does the mode belong to THIS session (the server kept an activeMode for it)
  // rather than being the inherited default's name? A pinned mode is identity
  // and outlives any solo flag; see lib/modes.modeChipLabel.
  const modePinned =
    live && sessionId ? sessionAgentConfig[sessionId]?.source === "session-mode" : false

  // SOLO: a raw model pick runs the model alone (see lib/solo). Session-pinned
  // solo applies to the ATTACHED session only; with no pin the global state
  // answers. While it holds, no saved mode is in effect — the selector, its
  // flyout and the status rule must all stop implying otherwise.
  const solo = useMemo(
    () =>
      isSoloActive({
        live,
        sessionId,
        sessionModelSel,
        modelSel,
        sessionSolo: sessionId ? (sessionAgentConfig[sessionId]?.selection.solo ?? null) : null,
      }),
    [live, sessionId, sessionModelSel, modelSel, sessionAgentConfig],
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
        // `undefined` hands the row back to its own summary — which is what a
        // transcript still catching up cannot speak for.
        //
        // For the attached session the live tree is the FASTER answer, but not
        // the complete one: the server counts work the transcript may never see
        // as a thread (a detached spawn outliving the turn, a delegate whose
        // `thread.status` we missed). So the two are OR-ed — either source
        // saying "still working" keeps the row spinning, and the row settles
        // only when both agree it is done.
        liveBusy:
          s.sessionId === sessionId && !catchingUp
            ? !isTreeIdle(transcript) || isSessionBusy(s)
            : undefined,
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
    catchingUp,
    sessionModelSel,
    modelSel,
    modelRows,
    activeRepo,
    unreadDone,
  ])

  // ---- Sidebar shelf (inbox vs history) -----------------------------------
  //
  // Deliberately NOT `status.kind === "done"`: presentation says what a row is
  // doing, this says where it lives. Its own clock ticks so a thread ages into
  // history on time instead of whenever something else happens to re-render.
  const shelfNow = useMinuteClock()

  const settledThreadIds = useMemo(() => {
    const out = new Set<string>()
    if (!live) return out
    for (const s of sessions) {
      // Same OR as the `threads` memo above: the shelf must not file a thread
      // into history while a detached delegate is still working on it.
      const busy =
        s.sessionId === sessionId && !catchingUp
          ? !isTreeIdle(transcript) || isSessionBusy(s)
          : isSessionBusy(s)
      const shelf = classifyShelf({
        busy,
        unread: unreadDone.has(s.sessionId) && s.sessionId !== sessionId,
        attached: !!s.attached || s.sessionId === sessionId,
        lastActivity: s.lastActivity,
        pin: shelfPins.get(s.sessionId),
        now: shelfNow,
      })
      if (shelf === "settled") out.add(s.sessionId)
    }
    return out
    // `transcript.status` stands in for the tree's liveness here, exactly as it
    // does in `threads` above.
  }, [live, sessions, sessionId, catchingUp, transcript.status, unreadDone, shelfPins, shelfNow])

  // Real work on a thread retires whatever the user filed it as: a settled
  // thread that starts running belongs back in the working list, and an active
  // pin has served its purpose once the thread moves on its own. Merely being
  // attached is NOT activity, so reading a settled thread leaves it settled.
  useEffect(() => {
    if (!live || shelfPins.size === 0) return
    const next = reconcileShelfPins(shelfPins, sessions)
    if (!next) return
    setShelfPins(next)
    saveSessionShelves(next)
  }, [live, sessions, shelfPins])

  // Forget pins whose session is gone (deleted, or on a repository that was
  // removed). Absence is the ONLY signal `prunePins` has, so this refuses to
  // run until the row cache can speak for every scope: one list per registered
  // repository AND one for the repository-less scope. Anything less would
  // delete the pins of every scope that simply has not been listed yet.
  useEffect(() => {
    if (!live || pinnedSessions.size === 0) return
    const cache = repoSessionCache.current
    if (!cache.has(null)) return
    if (!repos.every((repo) => cache.has(repo.id))) return
    const known = new Set<string>()
    for (const rows of cache.values()) for (const row of rows) known.add(row.sessionId)
    // The live list is fresher than the cache for the tab being viewed.
    for (const row of sessions) known.add(row.sessionId)
    if (known.size === 0) return
    const next = prunePins(pinnedSessions, known)
    if (!next) return
    setPinnedSessions(next)
    savePinnedSessions(next)
  }, [live, sessions, repos, repoRows, pinnedSessions])

  const repoTabUnreadIds = useMemo(() => {
    const out = new Set(unreadRepoIds)
    // The selected repo's list is already local state. Its tab is unread only
    // for another session, never merely because the selected thread completed —
    // and never for a thread the user has already filed into history.
    if (
      activeRepoId &&
      sessions.some(
        (s) =>
          unreadDone.has(s.sessionId) &&
          s.sessionId !== sessionId &&
          !settledThreadIds.has(s.sessionId),
      )
    ) {
      out.add(activeRepoId)
    }
    return out
  }, [activeRepoId, sessions, unreadDone, unreadRepoIds, sessionId, settledThreadIds])

  /** Which repository tabs have work in flight.
   *
   *  Read off the same cross-repo rows the far-left overview uses, through the
   *  shared `isSessionBusy` — so a tab spins for a sidekick or a detached spawn
   *  exactly as its sidebar row does, not only for a root turn. Working beats
   *  unread on the tab: "something is happening here" is the more urgent of the
   *  two, and a repo that is still running will produce its own unread mark
   *  when it finishes. */
  const repoTabWorkingIds = useMemo(() => {
    const out = new Set<string>()
    if (!live) return out
    for (const [repoId, rows] of repoRows) {
      if (rows.some((s) => isSessionBusy(s))) out.add(repoId)
    }
    return out
  }, [live, repoRows])

  // Which optimistic rows are still worth showing, DERIVED from the transcript
  // that is actually on screen. Deriving it (rather than deleting the row when
  // `message.user` arrives) is what makes the swap atomic: the transcript is
  // published on a cadence, so an event-driven delete would blank the row for
  // up to a flush interval before the authoritative one appeared.
  const visiblePendingSends = useMemo(
    () => unresolvedPendingSends(pendingSends, mainItems(transcript), transcript.queue.entries),
    [pendingSends, transcript],
  )
  // Resolved entries are pruned from state once the derivation says so. Guarded
  // by identity, so this settles in one pass instead of re-rendering forever.
  useEffect(() => {
    if (!samePendingSends(pendingSends, visiblePendingSends)) setPendingSends(visiblePendingSends)
  }, [pendingSends, visiblePendingSends])

  const activeThread: Thread = useMemo(() => {
    if (!live) {
      return demoThreads.find((t) => t.id === demoActiveId) ?? demoThreads[0]!
    }
    const session = sessions.find((s) => s.sessionId === sessionId)
    const t = buildActiveThread(session, transcript, uiModel.name, visiblePendingSends)
    if (activeRepo) t.projectId = `repo:${activeRepo.id}`
    return t
  }, [live, demoThreads, demoActiveId, sessions, sessionId, transcript, uiModel.name, activeRepo, visiblePendingSends])

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
        solo,
        soloAdvisor: soloAdvisorStatus,
        goal,
      }),
    [live, incognitoSession, effectiveModelSel, sidekickConfig, advisorStatus, solo, soloAdvisorStatus, goal],
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
    const summary = sessions.find((s) => s.sessionId === sessionId)
    if (activeRepoId === null || summary?.repositoryScope === "none") return undefined
    return summary?.workspace || activeRepo?.path || workspace || config?.workspace || undefined
  }, [live, sessions, sessionId, activeRepoId, activeRepo, workspace, config])

  // Sidebar identity: the user's git display name (name only — never the email),
  // read from whichever git directory the window is pointed at so a per-repo
  // override wins. "" everywhere it can't be read; Sidebar turns that into the
  // neutral "Chunky" fallback.
  const [gitUserName, setGitUserName] = useState("")
  useEffect(() => {
    let cancelled = false
    void gitIdentity({ cwd: gitCwd }).then((identity) => {
      if (!cancelled) setGitUserName(identity.name)
    })
    return () => {
      cancelled = true
    }
  }, [gitCwd])

  // Session-scoped rich data lives on TranscriptState (auto-resets on switch).
  const liveTodos = live ? transcript.todos : []
  const liveUsage = live ? transcript.usage : null
  const liveCompacted = live ? transcript.compacted : 0
  const liveQueue = live ? transcript.queue.entries : []
  // Live-only port snapshot: empty in demo/offline mode and on any server that
  // never emits `ports.changed`, which simply hides the header trigger.
  const livePorts = live ? transcript.ports : []





  /** Load sessions for a repo and attach last/newest/created session. */
  const openRepoThreads = useCallback(
    async (baseUrl: string, repoId: string | null) => {
      const list = await refreshSessions(baseUrl, repoId)
      if (repoId != null && repoId !== activeRepoIdRef.current) return

      const remembered = lastSessionByRepo.current[repoId ?? NO_REPO_SCOPE]
      const pick =
        (remembered && list.find((s) => s.sessionId === remembered)?.sessionId) ||
        list[0]?.sessionId

      if (pick) {
        void attachSession(baseUrl, pick)
        return
      }

      try {
        const created = await createSession(baseUrl, repoId, null, repoId === null ? "none" : undefined)
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
    let unsubscribeSetup: (() => void) | null = null
    ;(async () => {
      // Subscribe BEFORE getConfig: on a first run that call is what makes Bun
      // download and install the runtime, and its stages are what turn a
      // multi-minute blank wait into a status line.
      unsubscribeSetup = await subscribeSetupStage((stage) => {
        if (!cancelled) setSetupStage(stage)
      })
      if (cancelled) {
        unsubscribeSetup()
        return
      }

      const cfg = await loadConfig()
      // Setup is over the moment the connection resolves: stop listening (a
      // later background runtime upgrade must not repaint the boot banner) and
      // drop the line.
      unsubscribeSetup?.()
      unsubscribeSetup = null
      if (cancelled) return
      setSetupStage(null)
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

        setServerWarning(serverMismatchWarning(cfg.baseUrl, cfg.installedRuntime, info))
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
          repoId = remembered === NO_REPO_SCOPE
            ? null
            : (remembered && reg.repos.some((r) => r.id === remembered) ? remembered : null) ??
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
      unsubscribeSetup?.()
      stopStream()
      if (settleTimer.current != null) clearTimeout(settleTimer.current)
    }
  }, [openRepoThreads, stopStream])

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

  /**
   * Session summaries for the sidebar, the repo-tab badges and the completion
   * (unread + horn) rules.
   *
   * Server-PUSHED (ROUTES.sessionStream, ~250ms debounced) rather than polled,
   * so a session finishing in another repo is visible in a quarter second
   * instead of up to five. Current servers put `busy` (root OR delegate OR
   * detached spawn) on these rows and re-emit when a delegate starts/stops, so
   * the stream alone settles a session and costs no confirming poll. Rows from
   * an OLDER server carry only `running`: those inherit the last authoritative
   * `busy` (lib/sessionSummaries) and ask for ONE targeted poll to settle. A
   * slow safety poll covers what no transition can express, and a 5s poll takes
   * over completely if the stream is unavailable.
   */
  useEffect(() => {
    if (!config || appMode !== "live" || connectionState !== "connected") return
    const baseUrl = config.baseUrl
    let stopped = false
    const ac = new AbortController()
    let pollMs = FALLBACK_POLL_MS
    let pollTimer: ReturnType<typeof setTimeout> | null = null
    let confirmTimer: ReturnType<typeof setTimeout> | null = null
    let lastConfirmAt = 0

    /** Fold one repo's rows into the caches and report a qualifying completion.
     *  The SELECTED repo's transitions belong to the `sessions` effect below,
     *  which is the only place that knows about the attached session.
     *
     *  Only an AUTHORITATIVE list may shorten a repo: the stream is scoped by
     *  workspace path and debounced, so "absent from this batch" is not
     *  evidence a session is gone — and a row blinking out of the sidebar (or a
     *  cached transcript being evicted) is a far worse error than a stale row. */
    const applyRepoRows = (
      repo: Repo,
      rows: SessionSummary[],
      authoritative: boolean,
    ): RepoCompletion | null => {
      const previous = repoSessionCache.current.get(repo.id) ?? []
      const merged = authoritative
        ? mergeSummaryLists(previous, rows)
        : mergeSummaryLists(previous, unionSummaries(previous, rows))
      repoSessionCache.current.set(repo.id, merged)
      if (authoritative) {
        sessionCache.current.reconcileRepo(repo.id, new Set(merged.map((s) => s.sessionId)))
      }
      if (repo.id === activeRepoIdRef.current) return null
      const { completed, done } = trackCompletions(
        backgroundTracker.current,
        merged.map((s) => ({
          key: `${repo.id}:${s.sessionId}`,
          sessionId: s.sessionId,
          running: isSessionBusy(s),
        })),
        Date.now(),
        MIN_COMPLETION_NOTIFY_MS,
      )
      return completed ? { repoId: repo.id, done } : null
    }

    /** Republish every repo's rows for the far-left overview. Cheap: the cache
     *  is already up to date, and `sameRepoRows` drops the no-op commits the
     *  250ms delta cadence would otherwise cause. */
    const publishRepoRows = () => {
      if (stopped) return
      const next = new Map<string, SessionSummary[]>()
      for (const repo of repos) next.set(repo.id, repoSessionCache.current.get(repo.id) ?? [])
      setRepoRows((prev) => (sameRepoRows(prev, next) ? prev : next))
    }

    const flagCompletedRepos = (results: (RepoCompletion | null)[]) => {
      const completed = results.filter((r): r is RepoCompletion => r != null)
      if (completed.length === 0) return
      setUnreadRepoIds((prev) => {
        const next = new Set(prev)
        for (const r of completed) next.add(r.repoId)
        return next
      })
      // Per-SESSION unread as well, so the overview can show "these just
      // finished" instead of only which repos have news. The same set backs the
      // sidebar dots, so switching to the repo shows the very same rows marked.
      const done = completed.flatMap((r) => r.done)
      if (done.length > 0) {
        setUnreadDone((prev) => addUnreadSessions(prev, done, sessionIdRef.current))
      }
      // A batch may contain several completed sessions/repos, but gets one horn.
      playCompletionHorn()
    }

    /** Authoritative refresh: the only source of a settled `busy`. */
    const refreshAllRepos = async () => {
      const active = await refreshSessions(baseUrl).catch(() => null)
      if (stopped) return
      if (active) shellSummaries.current = absorbAuthoritative(shellSummaries.current, active)
      const otherRepos = repos.filter((repo) => repo.id !== activeRepoIdRef.current)
      const completed = await Promise.all(
        otherRepos.map(async (repo) => {
          try {
            const list = await listSessions(baseUrl, repo.id)
            if (stopped) return null
            shellSummaries.current = absorbAuthoritative(shellSummaries.current, list)
            return applyRepoRows(repo, list, true)
          } catch {
            // A stale/unavailable repo must not block the remaining polls.
            return null
          }
        }),
      )
      if (!stopped) {
        flagCompletedRepos(completed)
        publishRepoRows()
      }
    }

    /** One debounced authoritative poll, for rows whose `busy` the stream could
     *  not state (root run stopped, delegates unknown).
     *
     *  Rate-limited: a session whose root is idle while a delegate keeps
     *  working reports "can't say" on EVERY delta, and that must not turn into
     *  a poll every 250ms. */
    const confirmBusy = () => {
      if (confirmTimer != null || stopped) return
      const wait = Math.max(BUSY_CONFIRM_MS, BUSY_CONFIRM_GAP_MS - (Date.now() - lastConfirmAt))
      confirmTimer = setTimeout(() => {
        confirmTimer = null
        lastConfirmAt = Date.now()
        void refreshAllRepos()
      }, wait)
    }

    /** Publish the folded map: sidebar rows for the selected repo, cached rows
     *  (and completion transitions) for the rest. */
    const publishSummaries = (stale: string[]) => {
      if (stopped) return
      const completed: (RepoCompletion | null)[] = []
      if (activeRepoIdRef.current === null) {
        const rows = sessionsWithoutRepository(shellSummaries.current)
        repoSessionCache.current.set(null, rows)
        setSessions((prev) => (sameSummaryList(prev, rows) ? prev : rows))
      }
      for (const repo of repos) {
        const rows = sessionsInWorkspace(shellSummaries.current, repo.path)
        completed.push(applyRepoRows(repo, rows, false))
        if (repo.id === activeRepoIdRef.current) {
          const merged = repoSessionCache.current.get(repo.id) ?? rows
          setSessions((prev) => (sameSummaryList(prev, merged) ? prev : merged))
        }
      }
      flagCompletedRepos(completed)
      publishRepoRows()
      if (stale.length > 0) confirmBusy()
    }

    /** Proactive handover: a server that is draining after an update will stop
     *  serving shortly, so move to its replacement BEFORE the stream drops
     *  rather than after. Advisory — a failure just leaves the reconnect loop
     *  to notice the hard way. */
    const checkRetirement = () => {
      void fetchServerRetiring(baseUrl).then(async (retiring) => {
        if (!retiring || stopped || appMode !== "live") return
        await moveToResolvedServer()
      }).catch(() => {})
    }

    const schedulePoll = () => {
      if (stopped) return
      pollTimer = setTimeout(() => {
        void refreshAllRepos().finally(schedulePoll)
      }, pollMs)
    }

    void refreshAllRepos()
    schedulePoll()
    checkRetirement()
    const retirement = setInterval(checkRetirement, RETIREMENT_POLL_MS)

    void (async () => {
      for (;;) {
        try {
          await openSessionStream(
            baseUrl,
            {
              onOpen: () => {
                // The stream is the fast path now; polling drops back to a
                // safety net for what shell rows cannot express.
                pollMs = SAFETY_POLL_MS
              },
              onSnapshot: (rows) => {
                const { map, stale } = applySessionSnapshot(shellSummaries.current, rows)
                shellSummaries.current = map
                publishSummaries(stale)
              },
              onDelta: (delta: SessionDelta) => {
                const { map, stale } = applySessionDelta(shellSummaries.current, delta)
                shellSummaries.current = map
                publishSummaries(stale)
              },
            },
            ac.signal,
          )
        } catch (err) {
          if (isIntentionalAbort(err, ac.signal)) return
        }
        if (stopped || ac.signal.aborted) return
        // No stream (older server, or it dropped): poll like before until one
        // of the retries gets through.
        pollMs = FALLBACK_POLL_MS
        try {
          await sleep(SESSION_STREAM_RETRY_MS, ac.signal)
        } catch {
          return
        }
      }
    })()

    return () => {
      stopped = true
      ac.abort()
      clearInterval(retirement)
      if (pollTimer != null) clearTimeout(pollTimer)
      if (confirmTimer != null) clearTimeout(confirmTimer)
    }
  }, [config, appMode, connectionState, refreshSessions, repos, moveToResolvedServer])

  // Bun replaced the installed Chunky server and resolved a new one; reattach
  // to it. The superseded server is draining, so this is a handover, not a loss.
  useEffect(() => {
    if (appMode !== "live") return
    return subscribeServerChanged(() => {
      void moveToResolvedServer()
    })
  }, [appMode, moveToResolvedServer])

  // ---- Superseded servers that did not exit on their own ------------------

  /** Re-read the server list; drops the notice once nothing is left to act on. */
  const refreshOldServers = useCallback(async () => {
    const inspection = await inspectChunkyServers().catch(() => null)
    setOldServers(inspection && classifyServers(inspection).length > 0 ? inspection : null)
  }, [])

  // Bun announces this after an upgrade when old servers are still up.
  useEffect(() => {
    if (appMode !== "live") return
    return subscribeOldServers((inspection) => {
      if (classifyServers(inspection).length === 0) return
      // A fresh announcement is worth showing even after an earlier dismissal.
      setOldServersDismissed(false)
      setOldServers(inspection)
    })
  }, [appMode])

  // One quiet look shortly after launch, for servers left over from a previous
  // run. Silent unless it finds something actionable.
  useEffect(() => {
    if (appMode !== "live") return
    const timer = window.setTimeout(() => {
      void refreshOldServers()
    }, OLD_SERVER_SCAN_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [appMode, refreshOldServers])

  // A transition is meaningful only after this connected renderer observed the
  // running state. That avoids replay/initial-load notifications and dots.
  useEffect(() => {
    if (appMode !== "live" || connectionState !== "connected") {
      selectedTracker.current = createCompletionTracker()
      backgroundTracker.current = createCompletionTracker()
      return
    }
    const { completed, done } = trackCompletions(
      selectedTracker.current,
      sessions.map((s) => ({
        key: s.sessionId,
        sessionId: s.sessionId,
        // The attached session's live transcript is the fastest signal, OR-ed
        // with the server's own `busy` so delegate work it cannot see still
        // counts — EXCEPT while replay is in flight, when the transcript is
        // last-seen state and the summary is the only honest answer.
        // The completion rules themselves are unchanged: this only feeds the
        // same delegate-inclusive definition of "running" the other repos use.
        running:
          s.sessionId === sessionId && !catchingUp
            ? !isTreeIdle(transcript) || isSessionBusy(s)
            : isSessionBusy(s),
      })),
      Date.now(),
      MIN_COMPLETION_NOTIFY_MS,
    )
    // Rows that left the list keep no bookkeeping: a session returning later
    // must be observed running again before it can complete.
    const present = new Set(sessions.map((s) => s.sessionId))
    for (const key of [...selectedTracker.current.was.keys()]) {
      if (!present.has(key)) {
        selectedTracker.current.was.delete(key)
        selectedTracker.current.since.delete(key)
      }
    }
    if (completed) playCompletionHorn()
    const newlyDone = done.filter((id) => id !== sessionId)
    setUnreadDone((prev) => {
      let changed = false
      const out = new Set(prev)
      for (const id of newlyDone) if (!out.has(id)) { out.add(id); changed = true }
      return changed ? out : prev
    })
  }, [sessions, sessionId, transcript.status, appMode, connectionState, catchingUp])

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

  /** Re-read the attached session's complete authoritative config. */
  const refreshAgents = useCallback(async () => {
    if (appMode !== "live") {
      setAdvisorStatus(null)
      setSoloAdvisorStatus(null)
      setSidekickConfig(null)
      return
    }
    const sid = sessionId
    if (!sid) return
    const [agentConfig, soloAdvisor] = await Promise.all([
      getSessionAgentConfig(sid).catch(() => null),
      getSoloAdvisorStatus().catch(() => null),
    ])
    if (sid !== sessionIdRef.current) return
    setSoloAdvisorStatus(soloAdvisor)
    if (!agentConfig) return
    setSessionAgentConfig((prev) => ({ ...prev, [sid]: agentConfig }))
    setAdvisorStatus({
      config: agentConfig.advisor,
      active: agentConfig.advisor.enabled && !!agentConfig.advisor.model,
    })
    setSidekickConfig(agentConfig.sidekick)
    setSessionModelSel((prev) => {
      if (agentConfig.source !== "global") return { ...prev, [sid]: agentConfig.selection }
      if (!(sid in prev)) return prev
      const next = { ...prev }
      delete next[sid]
      return next
    })
  }, [appMode, sessionId])

  /** Saved definitions → slash aliases. Global `current` is intentionally ignored. */
  const refreshModes = useCallback(async () => {
    if (appMode !== "live") {
      setSlashModes([])
      setSavedModes([])
      setGlobalMode(null)
      return
    }
    try {
      const { modes, current } = await getModes()
      setSlashModes(modeCommands(modes, (m) => `Apply mode: ${prettyModel(m.model)}`))
      setSavedModes(modes)
      setGlobalMode(activeModeName(modes, current))
    } catch {
      /* keep the last known aliases; the menu is a convenience, not state */
    }
  }, [appMode])

  useEffect(() => {
    if (appMode !== "live") {
      setSlashModes([])
      setSavedModes([])
      setGlobalMode(null)
      setSessionAgentConfig({})
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

  /** Session events refresh only that keyed config. Global events refresh only
   * defaults/definitions; they must not repaint a pinned chat. */
  const handleModeApplied = useCallback(
    (name: string, spec: ModeSpec, eventSessionId?: string) => {
      if (eventSessionId) {
        void getSessionAgentConfig(eventSessionId).then((next) => {
          setSessionAgentConfig((prev) => ({ ...prev, [eventSessionId]: next }))
          if (eventSessionId !== sessionIdRef.current) return
          setSessionModelSel((prev) => ({ ...prev, [eventSessionId]: next.selection }))
          setAdvisorStatus({ config: next.advisor, active: next.advisor.enabled && !!next.advisor.model })
          setSidekickConfig(next.sidekick)
        }).catch(() => {})
      } else {
        void fetchModel(config?.baseUrl ?? "").then((next) => next && setModelSel(next))
        void refreshModes()
        // Global defaults affect only inheriting sessions, but the server is
        // the authority on whether this attached session inherits or is pinned.
        const sid = sessionIdRef.current
        if (sid) {
          void getSessionAgentConfig(sid).then((next) => {
            setSessionAgentConfig((prev) => ({ ...prev, [sid]: next }))
            setSessionModelSel((prev) => {
              if (next.source !== "global") return { ...prev, [sid]: next.selection }
              if (!(sid in prev)) return prev
              const copy = { ...prev }
              delete copy[sid]
              return copy
            })
            setAdvisorStatus({ config: next.advisor, active: next.advisor.enabled && !!next.advisor.model })
            setSidekickConfig(next.sidekick)
          }).catch(() => {})
        }
      }
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
    [config, refreshModes],
  )
  modeAppliedRef.current = handleModeApplied

  // ---- Actions ----
  const handleNewThread = useCallback(async () => {
    // A new thread is a transcript to type into; Home cannot show it.
    setMainView("chat")
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
      const created = await createSession(config.baseUrl, repoId, null, repoId === null ? "none" : undefined)
      if (repoId != null && repoId !== activeRepoIdRef.current) return
      // Attach right away; the sidebar list can catch up in the background.
      void attachSession(config.baseUrl, created.sessionId, { fresh: true })
      void refreshSessions(config.baseUrl, repoId).catch(() => {})
    } catch (err) {
      setConnError((err as Error).message)
    }
  }, [live, stopDemoStream, activeThread.projectId, config, refreshSessions, attachSession])

  /**
   * Settings → Providers → "Set it up with a chat": the user knows the name of
   * a provider but not its endpoint or how it authenticates, so hand the
   * problem to an agent instead of to a form. The Composer has no draft field,
   * so the brief has to be a real message — it is sent before attaching, which
   * means the run is already under way when the transcript opens.
   */
  const handleSetupProviderChat = useCallback(
    async (providerName: string, baseURL?: string) => {
      if (!config) return
      setSettingsOpen(false)
      setMainView("chat")
      const repoId = activeRepoIdRef.current
      try {
        const created = await createSession(config.baseUrl, repoId, null, repoId === null ? "none" : undefined)
        if (repoId != null && repoId !== activeRepoIdRef.current) return
        await sendMessage(config.baseUrl, created.sessionId, providerSetupBrief(providerName, baseURL))
        // Attach right away; the sidebar list can catch up in the background.
        void attachSession(config.baseUrl, created.sessionId, { fresh: true })
        void refreshSessions(config.baseUrl, repoId).catch(() => {})
      } catch (err) {
        setConnError((err as Error).message)
        // Rethrown so the card that started this can show it too, if it is
        // somehow still mounted.
        throw err
      }
    },
    [config, refreshSessions, attachSession],
  )

  /** Switch the visible repository.
   *
   *  `preferSessionId` is the session the caller wants opened once the tab has
   *  switched (a cross-repo jump from the far-left overview or the PR panel).
   *  It is threaded through rather than attached by the caller afterwards
   *  because this function ALREADY attaches a remembered/first session — a
   *  caller that attaches its own would make two attachments race, and the
   *  loser would still have replayed a whole transcript. */
  const handleSelectRepo = useCallback(
    async (id: string, preferSessionId?: string) => {
      if (!config || id === activeRepoIdRef.current) return
      setUnreadRepoIds((prev) => {
        if (!prev.has(id)) return prev
        const next = new Set(prev)
        next.delete(id)
        return next
      })
      // The repo becomes the selected one: its transitions move to the
      // sidebar's own tracker, so its background bookkeeping is dropped.
      forgetRepoTracking(backgroundTracker.current, id)
      setActiveRepoId(id)
      activeRepoIdRef.current = id
      rememberActiveRepo(id)
      // Drop current stream before loading the other repo's threads.
      stopStream()
      const cached = repoSessionCache.current.get(id)
      setSessions(cached ?? [])
      setSessionId(null)
      setTranscript(initialState)
      setTranscriptLoading(!cached)
      // Pick from cached rows now; fetch/reconcile happens in the background.
      const remembered = lastSessionByRepo.current[id]
      // An explicitly requested session wins over the remembered one, and is
      // honoured even when this client has not cached that row yet.
      const pick =
        preferSessionId ||
        (remembered && cached?.find((s) => s.sessionId === remembered)?.sessionId) ||
        cached?.[0]?.sessionId
      if (pick) {
        void attachSession(config.baseUrl, pick)
        void refreshSessions(config.baseUrl, id).catch(() => {})
      } else {
        void openRepoThreads(config.baseUrl, id)
      }
    },
    [config, openRepoThreads, attachSession, refreshSessions],
  )

  /** Switch to the first-class conversational scope with no repository/cwd. */
  const handleSelectNoRepo = useCallback(async (preferSessionId?: string) => {
    if (!config) return
    if (activeRepoIdRef.current === null) {
      if (preferSessionId && preferSessionId !== sessionIdRef.current) {
        void attachSession(config.baseUrl, preferSessionId)
      }
      return
    }
    setActiveRepoId(null)
    activeRepoIdRef.current = null
    rememberActiveRepo(NO_REPO_SCOPE)
    stopStream()
    const cached = repoSessionCache.current.get(null)
    setSessions(cached ?? [])
    setSessionId(null)
    setTranscript(initialState)
    setTranscriptLoading(!cached)
    const remembered = lastSessionByRepo.current[NO_REPO_SCOPE]
    const pick = preferSessionId ||
      (remembered && cached?.find((s) => s.sessionId === remembered)?.sessionId) ||
      cached?.[0]?.sessionId
    if (pick) {
      void attachSession(config.baseUrl, pick)
      void refreshSessions(config.baseUrl, null).catch(() => {})
    } else {
      void openRepoThreads(config.baseUrl, null)
    }
  }, [config, attachSession, refreshSessions, openRepoThreads, stopStream])

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
        stopStream()
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
          stopStream()
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
      // Picking a thread — from the sidebar, the palette or the voice agent —
      // is a request to look at a transcript, so Home steps aside.
      setMainView("chat")
      // Selecting a row is an explicit acknowledgement, including when the
      // already-open row was manually marked unread from its context menu.
      setUnreadDone((prev) => {
        if (!prev.has(id)) return prev
        const next = new Set(prev)
        next.delete(id)
        return next
      })
      if (!live) {
        stopDemoStream()
        setDemoThreads((prev) =>
          prev.map((thread) =>
            thread.id === id && thread.status.kind === "done" && thread.status.unread
              ? { ...thread, status: { ...thread.status, unread: false } }
              : thread,
          ),
        )
        setDemoActiveId(id)
        return
      }
      if (!config || id === sessionId) return
      void attachSession(config.baseUrl, id)
    },
    [live, stopDemoStream, config, sessionId, attachSession],
  )

  const handleThreadUnreadChange = useCallback(
    (id: string, unread: boolean) => {
      if (!live) {
        setDemoThreads((prev) =>
          prev.map((thread) =>
            thread.id === id && thread.status.kind === "done"
              ? { ...thread, status: { ...thread.status, unread } }
              : thread,
          ),
        )
        return
      }
      setUnreadDone((prev) => {
        const alreadyUnread = prev.has(id)
        if (alreadyUnread === unread) return prev
        const next = new Set(prev)
        if (unread) next.add(id)
        else next.delete(id)
        return next
      })
    },
    [live],
  )

  /** File a thread into history, or pull it back into the working list.
   *
   *  The pin is watermarked with the activity it was made against, so the next
   *  real turn on that thread retires it (see `reconcileShelfPins`). Settling
   *  is also an acknowledgement — it clears the revisit marker, the same way
   *  opening the thread would. */
  const handleThreadSettledChange = useCallback(
    (id: string, settled: boolean) => {
      if (!live) return
      const summary = sessions.find((s) => s.sessionId === id)
      // A running thread is handed straight back by the busy rule, so filing
      // one away would be a no-op the user could not explain. The row disables
      // the action; this is the guard behind it.
      if (settled && summary && isSessionBusy(summary)) return
      const next = new Map(shelfPins)
      next.set(id, { shelf: settled ? "settled" : "active", at: summary?.lastActivity ?? 0 })
      setShelfPins(next)
      saveSessionShelves(next)
      if (!settled) return
      setUnreadDone((prev) => {
        if (!prev.has(id)) return prev
        const cleared = new Set(prev)
        cleared.delete(id)
        return cleared
      })
    },
    [live, sessions, shelfPins],
  )

  /** Stick a thread to the top of the sidebar, or release it.
   *
   *  Deliberately independent of the shelf: pinning does not unsettle a thread,
   *  mark it read or keep it out of history — it only decides where the row is
   *  drawn. The timestamp is the pinned block's order, so a new pin lands at
   *  the bottom of the block and nothing above it moves. */
  const handleThreadPinnedChange = useCallback(
    (id: string, pinned: boolean) => {
      if (!live) return
      const next = setPin(pinnedSessions, id, pinned, Date.now())
      setPinnedSessions(next)
      savePinnedSessions(next)
    },
    [live, pinnedSessions],
  )

  // ---- PR reviews ---------------------------------------------------------

  /** Read the server's cached board, or force it to poll GitHub again. */
  const loadPrReviews = useCallback(async (force = false) => {
    setPrLoading(true)
    const result = force ? await refreshPrReviews() : await getPrReviews()
    setPrLoading(false)
    if (result.ok) {
      setPrState(result.state)
      setPrUnsupported(false)
      setPrError(null)
      return
    }
    setPrUnsupported(result.unsupported)
    setPrError(result.error)
    // An unsupported server has no board at all; a transient failure keeps the
    // last good one on screen rather than blanking the widget.
    if (result.unsupported) setPrState(null)
  }, [])

  /** Poll the board while connected. Paused when the window is hidden: the
   *  counts are ambient, and a backgrounded app should not keep hitting GitHub. */
  useEffect(() => {
    if (!live || connectionState !== "connected" || prUnsupported) return
    const tick = () => {
      if (typeof document !== "undefined" && document.hidden) return
      void loadPrReviews()
    }
    tick()
    const timer = setInterval(tick, 90_000)
    const onVisible = () => {
      if (typeof document !== "undefined" && !document.hidden) tick()
    }
    document.addEventListener("visibilitychange", onVisible)
    return () => {
      clearInterval(timer)
      document.removeEventListener("visibilitychange", onVisible)
    }
  }, [live, connectionState, prUnsupported, loadPrReviews])

  /** A different server may well have the routes this one lacks: moving to a
   *  replacement (or reconnecting) re-arms the poll rather than staying dark. */
  useEffect(() => {
    setPrUnsupported(false)
  }, [config?.baseUrl])

  /** Is the session linked to a PR card still working? The attached session
   *  adds its live transcript to the server's `busy`; everything else uses the
   *  polled summary alone. */
  const isPrSessionBusy = useCallback(
    (id: string) => {
      const summary = sessions.find((s) => s.sessionId === id)
      // Attached: the live tree OR the server's `busy` (see the `threads` memo).
      if (id === sessionId && !catchingUp) return !isTreeIdle(transcript) || isSessionBusy(summary)
      return isSessionBusy(summary)
    },
    [sessionId, transcript, sessions, catchingUp],
  )

  /** Jump to the session a PR action started, switching repo tab if needed. */
  const handleOpenPrSession = useCallback(
    async (id: string, repoId: string) => {
      setPrOpen(false)
      if (!config) return
      if (repoId && repoId !== activeRepoIdRef.current) {
        // Hand the target to the switch itself: attaching afterwards would race
        // the remembered-session attach it performs.
        await handleSelectRepo(repoId, id)
        return
      }
      if (id !== sessionIdRef.current) void attachSession(config.baseUrl, id)
    },
    [config, handleSelectRepo, attachSession],
  )

  /** Far-left overview rows, grouped per repository. Reads only state the
   *  publish loop already maintains — the overlay makes no requests. */
  const activityRepos = useMemo(
    () =>
      live
        ? buildRepoActivity(repos, repoRows, { unread: unreadDone, now: Date.now() })
        : [],
    [live, repos, repoRows, unreadDone],
  )

  const feedRepos = useMemo<FeedRepo[]>(
    () => repos.map((repo) => ({ id: repo.id, name: repo.name })),
    [repos],
  )

  // The goal sweep runs on its own interval and must read the LATEST rows
  // without restarting on every 250ms stream delta.
  const repoRowsRef = useRef(repoRows)
  useEffect(() => {
    repoRowsRef.current = repoRows
  }, [repoRows])

  /** Watch every repository's busy states so Home can say how long a run has
   *  been going. The completion tracker records the same instant, but only for
   *  UNSELECTED repos — this covers all of them, and costs no requests. */
  useEffect(() => {
    if (!live) return
    const entries: { sessionId: string; busy: boolean }[] = []
    for (const rows of repoRows.values()) {
      for (const session of rows) {
        entries.push({ sessionId: session.sessionId, busy: isSessionBusy(session) })
      }
    }
    if (entries.length === 0) return
    setBusySince((prev) => updateBusySince(prev, entries, Date.now()))
  }, [live, repoRows])

  /** A faster clock than the shelf's, but only while Home is on screen: its
   *  elapsed times are measured in seconds, and a stopped surface has no
   *  business running a timer. */
  useEffect(() => {
    if (mainView !== "home") return
    setHomeNow(Date.now())
    const timer = setInterval(() => setHomeNow(Date.now()), HOME_CLOCK_MS)
    return () => clearInterval(timer)
  }, [mainView])

  /** Needs You, v1: sessions whose GOAL is blocked.
   *
   *  The protocol has no tool-approval or ask-user state, so a blocked goal is
   *  the only thing that honestly means "the agent stopped and needs you". It
   *  is a per-session GET, so this only runs while Home is open, only for idle
   *  and recent sessions, and re-sweeps on a slow interval. Every request is
   *  independent: one failing session leaves the others intact and simply
   *  shortens the section. */
  useEffect(() => {
    if (!live || !config || mainView !== "home") return
    const baseUrl = config.baseUrl
    let stopped = false

    const sweep = async () => {
      const candidates = homeGoalCandidates(feedRepos, repoRowsRef.current, { now: Date.now() })
      if (candidates.length === 0) {
        if (!stopped) setHomeGoals((prev) => (prev.size === 0 ? prev : new Map()))
        return
      }
      setHomeGoalsLoading(true)
      const results = await Promise.all(
        candidates.map(async (candidate) => {
          try {
            return [candidate.sessionId, await getGoal(baseUrl, candidate.sessionId)] as const
          } catch {
            // A single unreachable session must not blank the section.
            return null
          }
        }),
      )
      if (stopped) return
      setHomeGoals(
        new Map(results.filter((entry): entry is NonNullable<typeof entry> => entry !== null)),
      )
      setHomeGoalsLoading(false)
    }

    void sweep()
    const timer = setInterval(() => void sweep(), HOME_GOAL_SWEEP_MS)
    return () => {
      stopped = true
      setHomeGoalsLoading(false)
      clearInterval(timer)
    }
  }, [live, config, mainView, feedRepos])

  /** The Home feed itself — pure shaping over state that already exists. */
  const homeFeed = useMemo(
    () =>
      buildHomeFeed(feedRepos, repoRows, {
        unread: unreadDone,
        goals: homeGoals,
        busySince,
        now: homeNow,
      }),
    [feedRepos, repoRows, unreadDone, homeGoals, busySince, homeNow],
  )

  /** Jump to any session in any repository from the overview.
   *
   *  Acknowledging the row is unconditional: the reader has now seen that it
   *  finished, whether or not the tab has to change. */
  const handleOpenActivitySession = useCallback(
    async (id: string, repoId: string) => {
      if (!config) return
      // Opening a row is leaving Home, whether the click came from the feed or
      // from the far-left overview.
      setMainView("chat")
      setUnreadDone((prev) => clearUnreadSession(prev, id))
      if (repoId && repoId !== activeRepoIdRef.current) {
        await handleSelectRepo(repoId, id)
        return
      }
      if (id !== sessionIdRef.current) void attachSession(config.baseUrl, id)
    },
    [config, handleSelectRepo, attachSession],
  )

  const prSummary = useMemo(() => summarize(prState, Date.now()), [prState])
  const prUnread = hasNewActivity(prState?.fetchedAt ?? null, prLastSeen)

  /** Opening the panel is what "seeing" the board means — clears the dot. */
  const handlePrOpenChange = useCallback(
    (open: boolean) => {
      setPrOpen(open)
      if (!open) return
      const fetchedAt = prState?.fetchedAt ?? Date.now()
      setPrLastSeen(fetchedAt)
      savePrLastSeen(fetchedAt)
    },
    [prState],
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
      // On screen NOW, before the round-trip. A queued send is deliberately not
      // optimistic: the server holds it without a `message.user` until the
      // drainer reaches it, and the composer's queue chips already show it.
      const optimistic = shouldAppendOptimistically(opts.delivery)
        ? createPendingSend({
            id: `pending-${++pendingSendSeq.current}`,
            text,
            imageCount: opts.images?.length ?? 0,
            items: mainItems(transcriptRef.current),
          })
        : null
      if (optimistic) setPendingSends((prev) => [...prev, optimistic])
      setSending(true)
      try {
        const blocked = await sendMessage(config.baseUrl, sessionId, text, opts)
        if (blocked?.blocked === "cache-cold") {
          // The turn did NOT run and nothing was billed, so no echo is ever
          // coming: drop the row rather than leave it pending forever. The
          // confirm bar owns the text now, and re-adds a row if it is sent.
          if (optimistic) setPendingSends((prev) => dropPendingSend(prev, optimistic.id))
          // Explicit confirm bar in the Composer (no silent force-resend).
          setCacheGuard({ text, images: opts.images ?? [], approxTokens: blocked.warning.approxTokens, reason: blocked.warning.reason, delivery: opts.delivery })
        }
        // Refresh session list so title/activity update soon.
        void refreshSessions(config.baseUrl, activeRepoIdRef.current).catch(() => {})
      } catch (err) {
        const message = err instanceof QueueFullError ? err.message : (err as Error).message
        setSendError(message)
        // The row stays put, marked failed: a message that never reached the
        // server must not silently vanish from the transcript.
        if (optimistic) setPendingSends((prev) => markPendingSendFailed(prev, optimistic.id, message))
      } finally {
        setSending(false)
      }
    },
    [live, stopDemoStream, demoActiveId, demoModel.name, config, sessionId, refreshSessions],
  )

  /** The composer's send path, shared with the quick-key chips. While the agent
   *  is running, plain ⏎ enqueues; ⌥⏎ interjects. */
  const submitComposerMessage = useCallback(
    (
      text: string,
      opts?: { delivery?: MessageDelivery; images?: { base64: string; mediaType: string }[] },
    ) => {
      // Sending is a request to watch the answer arrive: any full-page view
      // (Home, Usage) steps aside, same as picking a thread does.
      setMainView("chat")
      void handleSend(text, {
        ...opts,
        delivery: opts?.delivery ?? (streaming ? "queue" : "auto"),
      })
    },
    [handleSend, streaming],
  )

  const handleQuickKeysChange = useCallback((next: QuickKey[]) => {
    setQuickKeys(next)
    saveQuickKeys(next)
  }, [])

  // Settings edits the override; App owns the live value so the sidebar changes
  // under the open dialog. Blank clears it and the git name comes back.
  const handleDisplayNameChange = useCallback((next: string) => {
    const trimmed = next.trim()
    setNameOverride(trimmed)
    saveDisplayName(trimmed)
  }, [])

  /**
   * Cancel ONE delegate from its anchor card (server stop_delegate), leaving
   * the lead turn alone.
   *
   * Immediate, like every other card action here: the outcome (cancelled,
   * already finished, not found, ambiguous) comes back as the same bottom-right
   * notice the rest of the app uses. A server without the endpoint says so once
   * and then loses the button for the rest of this app's lifetime — nothing is
   * persisted, and a semantic 404 ("no such run") is a normal answer that must
   * NOT be mistaken for the endpoint being absent (see lib/api).
   */
  const handleStopRun = useCallback(
    async (_runId: string, target: StopDelegateRequest) => {
      if (!config || !sessionId) return
      const result = await stopDelegate(config.baseUrl, sessionId, target)
      if (result.status === "unsupported") {
        setStopDelegateUnsupportedOn(config.baseUrl)
        setNotice("This Chunky server can't stop delegates yet — update the server to use this.")
        return
      }
      setNotice(
        result.status === "ok" ? result.response.message : `Couldn't stop it: ${result.message}`,
      )
    },
    [config, sessionId],
  )

  /** This server has no delegate-status endpoint. Recorded once, per base URL,
   *  and silently: unlike Stop there is no control to explain away — the pills
   *  simply go back to the stream-only picture they had before. */
  const handleDelegatesUnsupported = useCallback((baseUrl: string) => {
    setDelegatesUnsupportedOn(baseUrl)
  }, [])

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
    // Usage graduated to a full page, so the old "stats" entry point lands
    // there instead of the modal — and, unlike the modal, it needs no session.
    // The scoreboard tab is still reached through /scoreboard and the palette.
    if (kind === "stats") {
      setMainView("usage")
      return
    }
    if (!live || !config || !sessionId) return
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
        const sid = sessionIdRef.current
        if (!sid) throw new Error("No attached session.")
        markSelfApplied(name)
        const applied = await applyMode(name, sid)
        await refreshAgents()
        const detail = applied?.model
          ? `: ${prettyModel(applied.model)}${applied.effort ? ` (${applied.effort})` : ""} · ${applied.provider}`
          : ""
        setNotice(`Mode "${applied?.applied || name}" applied${detail}.`)
      } catch (err) {
        setNotice(`Mode "${name}": ${(err as Error).message}`)
      }
    },
    [refreshAgents, markSelfApplied],
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
        const sid = sessionIdRef.current
        if (!sid) throw new Error("No attached session.")
        markSelfApplied(action.name)
        const applied = await applyMode(action.name, sid)
        await refreshAgents()
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
    [refreshAgents, markSelfApplied],
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
        case "/zoo":
          setMainView("zoo")
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
          // The full page, not the dialog: it spans days and sessions, so it
          // works before this thread has sent anything.
          setMainView("usage")
          return true
        case "/scoreboard": {
          if (!sessionId) {
            setNotice(`No session yet — send a message first, then ${head}.`)
            return true
          }
          // `/scoreboard session` scopes to this thread (TUI parity).
          const scope = /^session\b/i.test(rest) ? "session" : "all"
          await openStats("scoreboard", scope)
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
    // The confirmed re-send is a send like any other: it gets its optimistic row.
    const optimistic = shouldAppendOptimistically(pending.delivery)
      ? createPendingSend({
          id: `pending-${++pendingSendSeq.current}`,
          text: pending.text,
          imageCount: pending.images.length,
          items: mainItems(transcriptRef.current),
        })
      : null
    if (optimistic) setPendingSends((prev) => [...prev, optimistic])
    setSending(true)
    try {
      const blocked = await sendMessage(config.baseUrl, sessionId, pending.text, { force: true, delivery: pending.delivery, images: pending.images })
      if (blocked) {
        setSendError("Send blocked by cache guard even after confirmation.")
        if (optimistic) setPendingSends((prev) => dropPendingSend(prev, optimistic.id))
      }
    } catch (err) {
      const message = (err as Error).message
      setSendError(message)
      if (optimistic) setPendingSends((prev) => markPendingSendFailed(prev, optimistic.id, message))
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
      // A raw pick is a SOLO pick server-side. The global response says so; the
      // session-scoped one doesn't carry the flag, so assume the pin the server
      // just wrote and let the re-read below confirm it.
      if (sid) setSessionModelSel((prev) => ({ ...prev, [sid]: { ...next, solo: next.solo ?? true } }))
      else setModelSel({ ...next, solo: next.solo ?? true })
      // Picking a model by hand breaks the mode's pairing (the server drops its
      // own activeMode here too), so re-read what is now current: the selector
      // must fall back from the mode name to the model name, and the status rule
      // must drop the delegates solo suppressed.
      void refreshAgents()
    },
    [live, config, sessionId, refreshAgents],
  )

  const enterDemo = useCallback(() => {
    stopStream()
    setAppMode("demo")
    setConnectionState("offline")
  }, [stopStream])

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
      setServerWarning(serverMismatchWarning(baseUrl, resolved.installedRuntime, info))
      setWorkspace(info.workspace || "")
      setModelSel(sel)
      setModelRows(rows)
      setConnectionState("connected")

      if (reg) {
        setRepos(reg.repos)
        const remembered = activeRepoIdRef.current
        const repoId = remembered === null
          ? null
          : (reg.repos.some((r) => r.id === remembered) ? remembered : null) ??
            reg.activeId ?? reg.repos[0]?.id ?? null
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
    { id: "home", label: "Go Home", hint: "⌘0", group: "Session" },
    { id: "zoo", label: "Open The Zoo", group: "Workspace" },
    { id: "usage", label: "Usage", group: "Session" },
    { id: "scoreboard", label: "Scoreboard", group: "Session" },
    ...repos.map((repo) => ({ id: `repo:${repo.id}`, label: `Switch repo: ${repo.name}`, group: "Repositories" })),
    { id: "scope:chats", label: "Switch to Chats (no repository)", group: "Repositories" },
    ...sessions.map((session) => ({ id: `session:${session.sessionId}`, label: `Switch session: ${session.title || session.sessionId.slice(0, 8)}`, group: "Sessions" })),
    ...uiModels.map((model) => ({ id: `model:${model.id}`, label: `Switch model: ${model.name}`, group: "Models" })),
    ...["Rename session", "Goal mode", ...(activeRepoId ? ["Fork session", "Rewind to turn", "Ship it"] : [])].map((label) => ({ id: `action:${label}`, label, group: "Session" })),
    ...(activeRepoId ? [{ id: "terminal", label: "Toggle terminal", hint: "Ctrl+`", group: "Workspace" }] : []),
    { id: "theme", label: "Toggle theme", group: "Appearance" },
    { id: "browser", label: browserOpen ? "Close browser" : "Open browser", group: "Workspace" },
    { id: "settings", label: "Open Settings", hint: "⌘,", group: "Integration" },
    { id: "onboarding", label: "Run Onboarding", group: "Integration" },
  ], [repos, sessions, uiModels, browserOpen, activeRepoId])

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
      async (repoId?: string | null) => {
        if (!config) return []
        const scopeRepoId = repoId ?? activeRepoIdRef.current
        return listSessions(config.baseUrl, scopeRepoId, scopeRepoId === null ? "none" : undefined)
      },
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
      else if (a.id === "home") setMainView("home")
      else if (a.id === "zoo") setMainView("zoo")
      else if (a.id === "usage") setMainView("usage")
      else if (a.id === "scoreboard") void openStats("scoreboard", "all")
      else if (a.id === "terminal") setTerminalsOpen((value) => !value)
      else if (a.id === "theme") toggle()
      else if (a.id === "browser") { setFilesRepoId(null); setBrowserOpen((open) => !open) }
      else if (a.id === "settings") setSettingsOpen(true)
      else if (a.id === "onboarding") { if (live) setOnboardingOpen(true) }
      else if (a.id === "scope:chats") void handleSelectNoRepo()
      else if (a.id.startsWith("repo:")) dispatchAppAction({ type: "select-repo", repoId: a.id.slice(5) })
      else if (a.id.startsWith("session:")) dispatchAppAction({ type: "select-session", sessionId: a.id.slice(8) })
      else if (a.id.startsWith("model:")) { const model = uiModels.find((item) => item.id === a.id.slice(6)); if (model) void handleModelChange(model) }
      else if (a.id.startsWith("action:")) { const kind = a.id.slice(7); const map: Record<string, NonNullable<typeof dialog>> = { "Rename session": "rename", "Fork session": "fork", "Rewind to turn": "rewind", "Goal mode": "goal", "Ship it": "ship" }; void openDialog(map[kind]!) }
    },
    [dispatchAppAction, handleSelectNoRepo, toggle, uiModels, handleModelChange, openDialog, openStats, live],
  )

  // Chips and their hotkeys mirror the composer: no sending while a run streams,
  // and nothing to send to when we're not live on a session.
  const quickKeysDisabled =
    !live || streaming || connectionState !== "connected" || !sessionId || sending
  // Any modal surface that owns the keyboard while it is up.
  const overlayOpen =
    paletteOpen ||
    settingsOpen ||
    onboardingOpen ||
    sidekickPickerOpen ||
    quickKeyEditorOpen ||
    prOpen ||
    dialog !== null

  // Global shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey
      // Quick keys claim ⌘⇧<letter> first. Letters the shortcuts below answer to
      // are refused by the editor, so this can't shadow one of them.
      if (meta && e.shiftKey && !e.altKey && !overlayOpen) {
        const quick = quickKeyForHotkey(quickKeys, e.key)
        if (quick) {
          e.preventDefault()
          if (!quickKeysDisabled) submitComposerMessage(quick.prompt)
          return
        }
      }
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
      } else if (meta && !e.shiftKey && !e.altKey && e.key === "0" && !overlayOpen) {
        // ⌘0 toggles Home. Guarded by `overlayOpen` so a dialog or the palette
        // keeps the keyboard it owns.
        e.preventDefault()
        setMainView((view) => (view === "home" ? "chat" : "home"))
      } else if (e.ctrlKey && !e.metaKey && !e.altKey && (e.key === "`" || e.code === "Backquote")) {
        // Ctrl+` toggles the terminal drawer (Cmd+T is taken by thread folding).
        e.preventDefault()
        setTerminalsOpen((value) => !value)
      } else if (meta && e.key.toLowerCase() === "t") {
        e.preventDefault()
        setFoldThreads((value) => !value)
      } else if (e.key === "Escape" && streaming && live) {
        // Esc-to-stop is armed ONLY from the chat composer. An Esc meant for a
        // dialog, popover, search field, or plain "exit fullscreen" must never
        // kill the running thread. `defaultPrevented` covers surfaces (slash
        // menu, mention picker, cache guard) that already consumed the key.
        if (overlayOpen || e.defaultPrevented) return
        const target = e.target instanceof Element ? e.target : null
        if (!target?.closest("[data-chat-composer]")) return
        // Claim the key so AppKit doesn't also treat Esc as "exit fullscreen".
        e.preventDefault()
        e.stopPropagation()
        handleStop()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [
    toggle,
    handleNewThread,
    streaming,
    live,
    handleStop,
    quickKeys,
    quickKeysDisabled,
    overlayOpen,
    submitComposerMessage,
  ])

  // The theme switch lives in the top bar's overflow menu now (ChatTopBar),
  // which is handed `resolved` + `toggle` directly.

  // null unless Bun actually reported a setup stage (i.e. a first run / install).
  const setupStatusLine = describeSetupStage(setupStage)

  const statusBanner =
    connectionState === "booting" ? (
      <div className="flex items-center justify-center gap-2 border-border border-b bg-muted/40 px-4 py-1.5 text-[12px] text-muted-foreground">
        {/* First run installs a runtime before any server exists; Bun reports
            what it is doing so this is not a silent multi-minute wait. Warm
            launches report nothing and read exactly as they always have. */}
        <span className="truncate">{setupStatusLine ?? "Connecting to Chunky server…"}</span>
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
    ) : serverWarning && connectionState === "connected" ? (
      <div className="flex items-center justify-between gap-3 border-border border-b bg-amber-500/10 px-4 py-1.5 text-[12px] text-amber-700 dark:text-amber-300">
        <span className="flex min-w-0 items-center gap-2">
          <AlertCircle className="size-3.5 shrink-0" />
          <span className="truncate">{serverWarning}</span>
        </span>
        <button
          type="button"
          onClick={() => setServerWarning(null)}
          className="shrink-0 cursor-pointer font-medium underline-offset-2 hover:underline"
        >
          Dismiss
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
        {/* Far-left edge: the cross-repository overview. Fixed-position, so it
            sits outside the flex row and never shifts the layout. */}
        <ActivityOverlay
          enabled={live}
          repos={activityRepos}
          activeRepoId={activeRepoId}
          activeSessionId={sessionId}
          onOpenSession={(id, repoId) => void handleOpenActivitySession(id, repoId)}
        />
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
          // Home is a live-only surface: there is no cross-repo feed to show
          // without a server behind it.
          onOpenHome={live ? () => setMainView("home") : undefined}
          homeActive={mainView === "home"}
          onOpenZoo={() => setMainView("zoo")}
          zooActive={mainView === "zoo"}
          onOpenUsage={live ? () => setMainView("usage") : undefined}
          usageActive={mainView === "usage"}
          onOpenEvals={live ? () => setMainView("evals") : undefined}
          evalsActive={mainView === "evals"}
          onOpenSettings={() => setSettingsOpen(true)}
          onOpenPalette={() => setPaletteOpen(true)}
          onRenameThread={(id) => { if (live) { handleSelectThread(id); window.setTimeout(() => void openDialog("rename"), 0) } }}
          onThreadUnreadChange={handleThreadUnreadChange}
          unreadThreadIds={live ? unreadDone : undefined}
          settledThreadIds={live ? settledThreadIds : undefined}
          onThreadSettledChange={live ? handleThreadSettledChange : undefined}
          pinnedThreadIds={live ? pinnedSessions : undefined}
          onThreadPinnedChange={live ? handleThreadPinnedChange : undefined}
          displayName={pickDisplayName(nameOverride, gitUserName)}
          prWidget={
            live && !prUnsupported ? (
              <PrWidget
                summary={prSummary}
                configured={prState?.configured === true && !!prState?.org}
                unread={prUnread}
                org={prState?.org ?? null}
                onOpen={() => handlePrOpenChange(true)}
              />
            ) : null
          }
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
            repoStatus={live && activeRepoId ? <GitToolbar cwd={gitCwd} /> : null}
            headerRight={<>{incognitoSession && <span title="This session is off the record — nothing is written to disk." className="flex items-center gap-1 rounded-full border border-destructive/40 bg-destructive/10 px-2 py-1 font-medium text-[11px] text-destructive"><EyeOff className="size-3" />Incognito</span>}{goal && <button type="button" onClick={() => void openDialog("goal")} className="rounded-full border border-primary/30 bg-primary/10 px-2 py-1 text-[11px] font-medium text-primary">Goal · {goal.status}{goal.turns != null ? ` · ${goal.turns} turns` : ""}</button>}<SessionPortsPopover ports={livePorts} /><VoiceButton state={voice.state} active={voice.active} error={voice.error} disabled={!voiceEnabled} onToggle={voice.toggle} apiKeyPromptOpen={voice.apiKeyPromptOpen} onApiKeyPromptOpenChange={voice.setApiKeyPromptOpen} onSubmitApiKey={voice.submitApiKey} /></>}
            theme={resolved}
            onToggleTheme={toggle}
            onRename={() => void openDialog("rename")}
            onFork={activeRepoId ? () => void openDialog("fork") : undefined}
            onRewind={activeRepoId ? () => void openDialog("rewind") : undefined}
            onGoal={() => void openDialog("goal")}
            onShip={activeRepoId ? () => void openDialog("ship") : undefined}
            onStats={() => void openDialog("stats")}
            repos={live ? repos : undefined}
            activeRepoId={activeRepoId}
            unreadRepoIds={repoTabUnreadIds}
            workingRepoIds={repoTabWorkingIds}
            onSelectRepo={(id) => void handleSelectRepo(id)}
            onSelectNoRepo={() => void handleSelectNoRepo()}
            onAddRepo={handleAddRepo}
            onRemoveRepo={(id) => void handleRemoveRepo(id)}
            onOpenRepoFiles={openRepoFiles}
            // Cloning needs a reachable server (the agent does the work), so the
            // section disappears entirely in demo/offline mode.
            onCloneRepo={live && connectionState === "connected" ? handleCloneRepo : undefined}
            cloneStatus={cloneStatus}
            onCancelClone={handleCancelClone}
            onViewCloneThread={handleViewCloneThread}
            defaultCloneParent={cloneParentDefault}
            reposBusy={addingRepo}
            reposDisabled={!live || connectionState === "booting"}
            onToggleBrowser={() => { setFilesRepoId(null); setBrowserOpen((open) => !open) }}
            onToggleTerminal={activeRepoId ? () => setTerminalsOpen((value) => !value) : undefined}
            terminalOpen={terminalsOpen}
          />

          <section className="content-panel flex min-h-0 min-w-0 flex-1">
            {/* The chat column stays MOUNTED while Home is up: hiding it costs
                nothing and preserves the transcript's scroll/follow state, where
                unmounting would drop the reader back to the bottom. */}
            <div
              className={cn(
                "min-h-0 min-w-0 flex-1 flex-col",
                mainView === "chat" ? "flex" : "hidden",
              )}
              aria-hidden={mainView !== "chat"}
            >
              {statusBanner}
              {/* File paths in assistant prose resolve against the session's
                  own workspace (falling back to the open repo), so clicking
                  `src/a.ts` opens the right checkout. */}
              <FileLinkProvider cwd={gitCwd} enabled={activeRepoId !== null ? undefined : false}>
                <ChatView
                  thread={activeThread}
                  streamingId={liveStreamingId}
                  loading={live && transcriptLoading}
                  catchingUp={live && catchingUp}
                  transcript={live ? transcript : undefined}
                  modelName={uiModel.name}
                  foldAll={foldThreads}
                  compacted={liveCompacted}
                  {...(live &&
                  sessionId &&
                  stopDelegateAvailable(config?.baseUrl, stopDelegateUnsupportedOn)
                    ? { onStopRun: handleStopRun }
                    : {})}
                  {...(live &&
                  sessionId &&
                  config?.baseUrl &&
                  delegatesAvailable(config.baseUrl, delegatesUnsupportedOn)
                    ? {
                        delegateStatus: {
                          baseUrl: config.baseUrl,
                          sessionId,
                          onUnsupported: handleDelegatesUnsupported,
                        },
                      }
                    : {})}
                />
              </FileLinkProvider>
              {(transcript.background.tasks > 0 || transcript.background.monitors > 0) && <div className="px-5 pb-1 text-center text-[11px] text-muted-foreground">Background: {transcript.background.tasks} task{transcript.background.tasks === 1 ? "" : "s"} · {transcript.background.monitors} monitor{transcript.background.monitors === 1 ? "" : "s"}</div>}
              <TerminalDrawer
                open={terminalsOpen && activeRepoId !== null}
                onOpenChange={setTerminalsOpen}
                scopeKey={sessionId ?? (activeRepoId ? `repo:${activeRepoId}` : null)}
                cwd={gitCwd}
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
                <QuickKeys
                  disabled={quickKeysDisabled}
                  editorOpen={quickKeyEditorOpen}
                  keys={quickKeys}
                  onChange={handleQuickKeysChange}
                  onEditorOpenChange={setQuickKeyEditorOpen}
                  onRun={(key) => submitComposerMessage(key.prompt)}
                />
                {/* Detached delegates outlive the lead's turn: while the root
                    is idle and workers are still running, this is the only
                    thing in the chat column that says so. */}
                <ActiveWorkersStrip
                  transcript={live ? transcript : undefined}
                  streaming={streaming}
                  sessionId={sessionId}
                />
                <Composer
                model={uiModel}
                models={uiModels}
                modelEffort={effectiveModelSel?.effort ?? null}
                modelSpeed={effectiveModelSel?.speed ?? null}
                onModelChange={handleModelChange}
                onRefreshModels={live ? refreshModels : undefined}
                // While the agent is running, plain ⏎ enqueues; ⌥⏎ interjects.
                onSend={submitComposerMessage}
                onSearchFiles={live && config && activeRepoId ? (query) => searchFiles(config.baseUrl, query, activeRepoId) : undefined}
                commands={slashCommands}
                modes={modeOptions}
                modeSpecs={live ? savedModes : []}
                activeMode={activeMode}
                modePinned={modePinned}
                solo={solo}
                onSelectMode={live ? applyModeByName : undefined}
                onSaveMode={live ? handleSaveModeSpec : undefined}
                openModelPickerSignal={modelPickerSignal}
                streaming={streaming}
                onStop={handleStop}
                contextMeter={<ContextMeter usage={liveUsage} limit={contextLimit} />}
                status={<ComposerStatus chips={statusChips} selectorLabel={modeChipLabel(activeMode, { pinned: modePinned, solo }) ?? uiModel.name} />}
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
            {mainView === "usage" && (
              <UsageView
                baseUrl={live && config ? config.baseUrl : null}
                sessionId={live ? sessionId : null}
              />
            )}
            {mainView === "evals" && (
              <EvalsView
                baseUrl={live && config ? config.baseUrl : null}
                onOpenSession={
                  live
                    ? (id) => {
                        setMainView("chat")
                        handleSelectThread(id)
                      }
                    : undefined
                }
              />
            )}
            {mainView === "home" && (
              <HomeView
                feed={homeFeed}
                repos={feedRepos}
                now={homeNow}
                displayName={pickDisplayName(nameOverride, gitUserName)}
                goalsLoading={homeGoalsLoading}
                onOpenSession={(id, repoId) => void handleOpenActivitySession(id, repoId)}
              />
            )}
            {mainView === "zoo" && (
              <ZooWorkspace
                baseUrl={live && connectionState === "connected" ? config?.baseUrl ?? null : null}
                repoId={activeRepoId}
                repos={repos}
                onOpenChat={() => setMainView("chat")}
                onOpenSession={
                  live
                    ? (id) => {
                        setMainView("chat")
                        handleSelectThread(id)
                      }
                    : undefined
                }
              />
            )}
            {filesRepoId && repos.some((repo) => repo.id === filesRepoId) ? (
              <RepoFilesPane
                repo={repos.find((repo) => repo.id === filesRepoId)!}
                baseUrl={config?.baseUrl ?? ""}
                onClose={() => setFilesRepoId(null)}
              />
            ) : null}
            {/* Sticky: once opened, the browser pane stays mounted for good and
                closing it only hides it. Unmounting it would disconnect its
                `<electrobun-webview>`, and closing the process's only CEF
                browser quits the app — see note 5 in BrowserPane. It is a
                sibling of the files pane rather than an alternative to it, so
                the files pane can take the slot without unmounting it. */}
            {browserSlot.mounted ? (
              <BrowserPane
                visible={browserSlot.visible}
                onClose={() => setBrowserOpen(false)}
                baseUrl={live && connectionState === "connected" ? config?.baseUrl ?? null : null}
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
        {/* The agent asking for a provider API key (lib/apiKeyRequest.ts). At
            the root because the user is looking at the chat when it arrives. */}
        <ApiKeyRequestHost />
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
          identity={{
            override: nameOverride,
            gitName: gitUserName,
            onChange: handleDisplayNameChange,
          }}
          onModesChanged={() => {
            void refreshModels()
            void refreshModes()
            void refreshAgents()
          }}
          // Demo mode / no server has no session to open, so the option is
          // withheld rather than rendered dead.
          onSetupProviderChat={live && config ? handleSetupProviderChat : undefined}
          connection={{
            state: live ? connectionState : "offline",
            baseUrl: config?.baseUrl ?? "http://localhost:4620",
            workspace: activeRepo?.path || workspace || config?.workspace || "",
            sessionCount: sessions.length,
            mode: appMode,
          }}
        />
        <PrPanel
          open={prOpen}
          onOpenChange={handlePrOpenChange}
          state={prState}
          unsupported={prUnsupported}
          error={prError}
          loading={prLoading}
          onRefresh={() => loadPrReviews(true)}
          onReload={() => loadPrReviews()}
          isSessionBusy={isPrSessionBusy}
          onOpenSession={(id, repoId) => void handleOpenPrSession(id, repoId)}
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
        {oldServers && !oldServersDismissed && (
          <OldServersNotice
            inspection={oldServers}
            onRefresh={refreshOldServers}
            onDismiss={() => setOldServersDismissed(true)}
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
