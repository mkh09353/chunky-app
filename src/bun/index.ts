import { BrowserWindow, ApplicationMenu, BuildConfig, createRPC, Updater, Utils } from "electrobun/bun"
import { join } from "node:path"
import { homedir } from "node:os"
import { existsSync } from "node:fs"
import { stat as fsStat } from "node:fs/promises"
import { createAppBrowserResolver } from "./appBrowser"
import { createCookieSyncService } from "./cookieSync"
import {
  candidateRoots,
  destroyFinders,
  ensureFinders,
  parentRoot,
  searchDirectories,
} from "./dirSearch"
import { createDirectory } from "./fsOps"
import { openInEditor as runOpenInEditor, type EditorDeps } from "./openInEditor"
import { createTerminalManager } from "./terminal"
import * as git from "./git"
import {
  installedRuntimeIdentity,
  refreshChunkyConnection,
  releaseChunkyConnection,
  rememberChunkyWorkspace,
  resolveChunkyConnection,
  upgradeRuntimeAndReconnect,
} from "./connectionManager"
import { mergeDesktopState, readDesktopState, type DesktopState } from "./desktopState"
import { createZooManager } from "./zoo"
import { createZooService } from "./zooService"
import { ensureZooLedgerSkill } from "./zooLedgerSkill"
import { createWatchScheduler } from "./watchScheduler"
import { runXWatchSession } from "./xWatch"
import { createXWatchScheduler } from "./xWatchScheduler"
import { setSetupStageReporter, SETUP_STAGE_MESSAGE, type SetupStage } from "./setupStatus"
import { hasVoiceApiKey, mintVoiceToken, setVoiceApiKey } from "./voice"
import { inspectServers, retireServer, stopServer, type ServerInspection } from "./serverInspection"

const DEV_SERVER_URL = process.env.VITE_DEV_URL ?? "http://localhost:5173"

// Prefer the Vite HMR server in dev; fall back to the bundled view. Packaged
// (non-dev channel) builds must never probe: a random Vite server on :5173
// would hijack the window and break the /chunky-api proxy contract.
async function getMainViewUrl(): Promise<string> {
  try {
    const channel = await Updater.localInfo.channel().catch(() => "dev")
    if (channel !== "dev" && !process.env.VITE_DEV_URL) return "views://mainview/index.html"
    await fetch(DEV_SERVER_URL, { method: "HEAD" })
    console.log(`[chunky] HMR: ${DEV_SERVER_URL}`)
    return DEV_SERVER_URL
  } catch {
    return "views://mainview/index.html"
  }
}

const workspace = process.env.CHUNKY_WORKSPACE || process.cwd()

const extraRoots = [parentRoot(workspace)].filter((p): p is string => !!p)

let updateInProgress = false
// Version we already offered to install and the user declined; periodic checks
// stay quiet about it, but the explicit menu action always re-prompts.
let declinedUpdateVersion: string | null = null

/**
 * Keep the installed Chunky server (~/.chunky/app) current. Silent on success:
 * the replacement server takes over and the old one drains, so the only thing
 * the renderer has to do is reattach — which the message below tells it to do.
 *
 * Deliberately not a polling loop: this runs once at boot and whenever the
 * Electrobun updater check runs.
 */
async function checkRuntimeUpdate(): Promise<void> {
  const result = await upgradeRuntimeAndReconnect()
  if (!result.upgraded) return
  const baseUrl = result.connection?.baseUrl
  if (!baseUrl) return
  const send = rpc?.send as unknown as Record<string, (value: unknown) => void> | undefined
  send?.chunkyServerChanged?.({ baseUrl, version: result.version })
  void inspectServers().then((inspection) => {
    if (inspection.servers.some((server) => server.reachable && !server.retiring && !server.current)) send?.chunkyOldServers?.(inspection)
  })
}

/** Check, download, and offer to restart for an Electrobun release update. */
async function checkForUpdates({ interactive = false } = {}): Promise<void> {
  // The bundled app and the Chunky server update independently; check both
  // whenever we check either.
  void checkRuntimeUpdate()
  if (updateInProgress) return

  try {
    // Development bundles deliberately have no update endpoint.
    if ((await Updater.localInfo.channel()) === "dev") {
      if (interactive) {
        await Utils.showMessageBox({
          type: "info",
          title: "Check for Updates",
          message: "Updates are unavailable in development builds.",
        })
      }
      return
    }

    updateInProgress = true
    const update = await Updater.checkForUpdate()
    if (!update.updateAvailable) {
      if (interactive) {
        await Utils.showMessageBox({
          type: "info",
          title: "Check for Updates",
          message: "Chunky is up to date.",
        })
      }
      if (update.error) console.warn("[chunky] update check failed:", update.error)
      return
    }

    await Updater.downloadUpdate()
    const downloaded = Updater.updateInfo()
    if (!downloaded?.updateReady) {
      console.warn("[chunky] update download did not complete:", downloaded?.error || "unknown error")
      return
    }

    const version = (downloaded as { version?: string }).version ?? (update as { version?: string }).version ?? "unknown"
    if (!interactive && declinedUpdateVersion === version) return

    const { response } = await Utils.showMessageBox({
      type: "question",
      title: "Update Ready",
      message: "A Chunky update has been downloaded.",
      detail: "Restart now to install it?",
      buttons: ["Restart and Install", "Later"],
      defaultId: 0,
      cancelId: 1,
    })
    if (response === 0) await Updater.applyUpdate()
    else declinedUpdateVersion = version
  } catch (error) {
    // Update failures must never interfere with using the app.
    console.warn("[chunky] update failed:", error)
  } finally {
    updateInProgress = false
  }
}

Updater.onStatusChange((entry) => {
  if (entry.status === "error" || entry.status === "patch-failed") {
    console.warn(`[chunky] updater ${entry.status}: ${entry.message}`)
  }
})

// Warm FFF indexes in the background so the first keystroke is fast.
void ensureFinders(extraRoots).catch((err) => {
  console.warn("[chunky] FFF warm-up failed:", err)
})

// macOS routes ⌘C/⌘V/⌘X/⌘A through the app menu's key-equivalents. Electrobun
// installs no default menu, so wire up the standard Edit roles or copy/paste
// are no-ops in the WebView.
ApplicationMenu.setApplicationMenu([
  {
    label: "Chunky",
    submenu: [
      { role: "about" },
      { label: "Check for Updates…", action: "check-for-updates" },
      { type: "separator" },
      { role: "hide", accelerator: "CommandOrControl+H" },
      { role: "hideOthers", accelerator: "CommandOrControl+Alt+H" },
      { role: "showAll" },
      { type: "separator" },
      { role: "quit", accelerator: "CommandOrControl+Q" },
    ],
  },
  {
    label: "Edit",
    submenu: [
      { role: "undo", accelerator: "CommandOrControl+Z" },
      { role: "redo", accelerator: "CommandOrControl+Shift+Z" },
      { type: "separator" },
      { role: "cut", accelerator: "CommandOrControl+X" },
      { role: "copy", accelerator: "CommandOrControl+C" },
      { role: "paste", accelerator: "CommandOrControl+V" },
      { role: "selectAll", accelerator: "CommandOrControl+A" },
    ],
  },
  {
    label: "Window",
    submenu: [
      { role: "minimize", accelerator: "CommandOrControl+M" },
      { role: "zoom" },
      { role: "close", accelerator: "CommandOrControl+W" },
      { type: "separator" },
      { role: "toggleFullScreen" },
    ],
  },
])

ApplicationMenu.on("application-menu-clicked", (event) => {
  const action = (event as { data?: { action?: unknown } }).data?.action
  if (action === "check-for-updates") void checkForUpdates({ interactive: true })
})

function clampLimit(raw: unknown): number {
  const n = typeof raw === "number" ? raw : Number(raw)
  if (!Number.isFinite(n)) return 12
  return Math.max(1, Math.min(Math.floor(n), 30))
}

function clampQuery(raw: unknown): string {
  if (typeof raw !== "string") return ""
  // Cap length so RPC cannot ship multi-MB strings into the native index.
  return raw.trim().slice(0, 200)
}

/** CDP endpoint of the browser pane. BuildConfig is injected so appBrowser.ts
 *  (and its tests) never has to load the electrobun FFI runtime. */
const resolveAppBrowserTarget = createAppBrowserResolver({
  availableRenderers: async () => (await BuildConfig.get()).availableRenderers ?? ["native"],
})
const cookieSync = createCookieSyncService({
  resolveTarget: () => resolveAppBrowserTarget(),
})

let rpc!: ReturnType<typeof createRPC>
const terminals = createTerminalManager((name, payload) => {
  const send = rpc.send as unknown as Record<string, (value: unknown) => void>
  send[name]?.(payload)
})
// SQLite is opened lazily inside the manager, so merely launching Chunky does
// not create product-factory state or touch the disk.
const zoo = createZooManager({
  xWatchRun: async (params) => {
    const connection = await resolveChunkyConnection()
    return runXWatchSession(params, { baseUrl: connection.baseUrl, token: connection.serverToken })
  },
})
// The token-guarded loopback service remains dormant until the renderer needs
// to announce it to the local Chunky server.
const zooService = createZooService({ manager: zoo })
const watchScheduler = createWatchScheduler({
  state: async () => {
    const state = await zoo.watchState({})
    return state.ok ? { hour: state.hour, lastCheckAt: state.lastCheckAt } : { hour: 8, lastCheckAt: null }
  },
  run: async () => {
    const state = await zoo.watchState({})
    if (!state.ok || state.watchCount === 0) return { ok: true as const, results: [], checkedAt: Date.now() }
    return zoo.checkRepoWatches({})
  },
  onError: (error) => console.warn("[zoo] competitor watch check failed:", error),
})
const xWatchScheduler = createXWatchScheduler({
  state: async () => {
    if (!zoo.hasStore()) return { intervalMinutes: 60, lastSuccessAt: Date.now() }
    const state = await zoo.xWatchState({})
    return state.ok ? { intervalMinutes: state.intervalMinutes, lastSuccessAt: state.lastSuccessAt } : { intervalMinutes: 60, lastSuccessAt: null }
  },
  run: async () => {
    if (!zoo.hasStore()) return { ok: true as const, results: [], checkedAt: Date.now(), succeeded: false }
    const state = await zoo.xWatchState({})
    if (!state.ok || state.watchCount === 0) return { ok: true as const, results: [], checkedAt: Date.now(), succeeded: false }
    return zoo.checkXWatches({})
  },
  onError: (error) => console.warn("[zoo] X-watch check failed:", error instanceof Error ? error.message : "unknown error"),
})

/**
 * How the editor hand-off reaches the OS. Kept next to the RPC handler (rather
 * than inside src/bun/openInEditor.ts) so that module stays free of Bun and
 * node globals and can be unit-tested on its own.
 */
const editorCliCache = new Map<string, string | null>()

/** GUI apps inherit a minimal PATH, so `code` often is not on it even when the
 *  user has installed the CLI. Check the usual install locations too. */
const CODE_CLI_FALLBACKS = [
  "/opt/homebrew/bin/code",
  "/usr/local/bin/code",
  "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code",
]

const editorDeps: EditorDeps = {
  home: () => homedir(),
  stat: async (path) => {
    try {
      const info = await fsStat(path)
      return { isDirectory: info.isDirectory() }
    } catch {
      return null
    }
  },
  which: (command) => {
    const cached = editorCliCache.get(command)
    if (cached !== undefined) return cached
    let found = Bun.which(command)
    if (!found && command === "code") {
      found = CODE_CLI_FALLBACKS.find((candidate) => existsSync(candidate)) ?? null
    }
    editorCliCache.set(command, found)
    return found
  },
  // Argument array only — there is no shell in this path, by construction.
  spawn: async (argv) => {
    const child = Bun.spawn(argv, { stdout: "ignore", stderr: "pipe" })
    const [exitCode, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
    ])
    return { exitCode, stderr }
  },
}

rpc = createRPC({
  maxRequestTime: 180_000,
  requestHandler: {
    // Served to the webview over RPC. Connection resolution and the bearer
    // token stay in Bun; production renderer assets never contain credentials.
    getConfig: async () => {
      const config = await resolveChunkyConnection()
      return {
        ...config,
        installedRuntime: installedRuntimeIdentity() ?? null,
        workspaceName: (config.workspace || workspace).split(/[\\/]/).filter(Boolean).pop() || "workspace",
      }
    },

    /**
     * Re-resolve the Chunky server. The renderer calls this when its stream
     * cannot come back (refused connections, or the server announced that it is
     * retiring after an update): discovery runs again, so the app moves onto the
     * replacement server — starting one if necessary — instead of retrying a
     * dead port.
     */
    chunkyReconnect: async () => {
      const config = await refreshChunkyConnection()
      return {
        ...config,
        installedRuntime: installedRuntimeIdentity() ?? null,
        workspaceName: (config.workspace || workspace).split(/[\\/]/).filter(Boolean).pop() || "workspace",
      }
    },
    chunkyInspectServers: async () => inspectServers(),
    chunkyRetireServer: async (params: unknown) => retireServer({}, (params as { id?: unknown })?.id as string),
    chunkyStopServer: async (params: unknown) => stopServer({}, (params as { id?: unknown })?.id as string),

    // Voice credentials stay in Bun. The renderer receives only a short-lived
    // xAI realtime client secret, never the configured provider API key.
    voiceGetToken: async () => mintVoiceToken(),
    voiceSetApiKey: async (params: unknown) => {
      const key = params && typeof params === "object" ? (params as { apiKey?: unknown }).apiKey : params
      return setVoiceApiKey(key)
    },
    voiceHasApiKey: async () => ({ ok: true, hasApiKey: hasVoiceApiKey() }),

    /**
     * Durable renderer UI state (~/.chunky/state/desktop.json): which repo tab
     * is open and which thread each tab reopens. It lives here, not in the
     * webview's localStorage, because that storage is inside the app container
     * and does not survive a reinstall. Bun validates and bounds the payload.
     */
    desktopStateGet: async () => {
      const {
        activeRepoId = null,
        lastSessionByRepo = {},
        quickKeys = [],
        displayName = "",
        sessionShelves = {},
      } = readDesktopState()
      return { ok: true, activeRepoId, lastSessionByRepo, quickKeys, displayName, sessionShelves }
    },
    desktopStateSet: async (params: unknown) => {
      const raw = (params ?? {}) as Record<string, unknown>
      const patch: DesktopState = {}
      // Only forward keys the renderer actually sent, so a partial update never
      // erases the other one. `null` clears the remembered tab.
      if ("activeRepoId" in raw) {
        patch.activeRepoId = typeof raw.activeRepoId === "string" ? raw.activeRepoId : null
      }
      if ("lastSessionByRepo" in raw) {
        patch.lastSessionByRepo = (raw.lastSessionByRepo ?? {}) as Record<string, string>
      }
      if ("quickKeys" in raw) {
        patch.quickKeys = (raw.quickKeys ?? []) as DesktopState["quickKeys"]
      }
      // "" is a real instruction here (clear the override), so a non-string is
      // normalised to it rather than dropped.
      if ("displayName" in raw) {
        patch.displayName = typeof raw.displayName === "string" ? raw.displayName : ""
      }
      if ("sessionShelves" in raw) {
        patch.sessionShelves = (raw.sessionShelves ?? {}) as DesktopState["sessionShelves"]
      }
      const {
        activeRepoId = null,
        lastSessionByRepo = {},
        quickKeys = [],
        displayName = "",
        sessionShelves = {},
      } = mergeDesktopState(patch)
      return { ok: true, activeRepoId, lastSessionByRepo, quickKeys, displayName, sessionShelves }
    },

    /**
     * What the browser pane is, as a remotely drivable target: which renderer
     * this build can give it and — for CEF — the loopback CDP port Electrobun
     * put it on. The webview announces this to the Chunky server; see
     * src/bun/appBrowser.ts for why the port has to be discovered.
     * Input: { paneUrl?: string } — the pane's current page, used to prove the
     *   CDP listener we found is ours and not some other Chromium.
     * Output: AppBrowserAnnounce { cdpPort, renderer, debuggable }
     */
    appBrowserTarget: async (params: unknown) => {
      const paneUrl =
        params && typeof params === "object" ? (params as { paneUrl?: unknown }).paneUrl : params
      const target = await resolveAppBrowserTarget(typeof paneUrl === "string" ? paneUrl : undefined)
      if (target.debuggable) cookieSync.onPaneDebuggable()
      return target
    },
    cookieSyncGetSettings: async () => cookieSync.getState(),
    cookieSyncSetSettings: async (params: unknown) => cookieSync.setSettings(params),
    cookieSyncRunNow: async () => cookieSync.runNow(),
    cookieSyncListProfiles: async () => cookieSync.listProfiles(),
    /** Target for the local product-factory service. The renderer immediately
     * announces this ephemeral credential to the authenticated Chunky server. */
    appZooTarget: async () => ({ ok: true, ...await zooService.target() }),

    /** OS directory picker. Returns absolute path or "" on cancel. */
    openFolderDialog: async () => {
      try {
        const starting =
          (workspace && workspace !== "/") ? workspace : join(homedir(), "Downloads")
        const paths = await Utils.openFileDialog({
          startingFolder: starting,
          canChooseFiles: false,
          canChooseDirectory: true,
          allowsMultipleSelection: false,
        })
        const picked = paths.find((p) => typeof p === "string" && p.trim())
        const path = picked?.trim() ?? ""
        rememberChunkyWorkspace(path)
        return path
      } catch (err) {
        console.warn("[chunky] openFolderDialog failed:", err)
        return ""
      }
    },

    /**
     * Open a link in the user's default browser — the WebView cannot open
     * windows of its own. Only http(s) is ever handed to the OS, and the URL
     * travels as an argv entry (never through a shell).
     * Input: { url: string } | string
     * Output: { ok: boolean, error?: string }
     */
    openExternal: async (params: unknown) => {
      const raw =
        params && typeof params === "object" ? (params as { url?: unknown }).url : params
      const value = typeof raw === "string" ? raw.trim() : ""
      if (!value || value.includes("\0") || value.length > 4096) {
        return { ok: false, error: "Invalid URL" }
      }
      let parsed: URL
      try {
        parsed = new URL(value)
      } catch {
        return { ok: false, error: "Invalid URL" }
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return { ok: false, error: `Refused scheme: ${parsed.protocol}` }
      }
      try {
        const child = Bun.spawn(["open", parsed.href], { stdout: "ignore", stderr: "pipe" })
        const [exitCode, stderr] = await Promise.all([
          child.exited,
          new Response(child.stderr).text(),
        ])
        if (exitCode !== 0) {
          const error = stderr.trim() || `open exited with ${exitCode}`
          console.warn("[chunky] openExternal failed:", error)
          return { ok: false, error }
        }
        return { ok: true }
      } catch (err) {
        const error = err instanceof Error ? err.message : "Failed to open URL"
        console.warn("[chunky] openExternal failed:", error)
        return { ok: false, error }
      }
    },

    /**
     * Open a file the assistant mentioned in the user's editor. The renderer
     * detects the path (src/mainview/lib/fileLinks.ts) and sends it here with
     * the session's repo as `cwd`; Bun resolves it, checks that it exists and
     * launches an argv array — a renderer string never reaches a shell.
     * Input: { path: string, line?: number, column?: number, cwd?: string }
     * Output: { ok: boolean, path?: string, error?: string }
     */
    openInEditor: async (params: unknown) => {
      const body = (params && typeof params === "object" ? params : {}) as {
        path?: unknown
        line?: unknown
        column?: unknown
        cwd?: unknown
      }
      const target = {
        path: typeof body.path === "string" ? body.path : "",
        ...(typeof body.line === "number" ? { line: body.line } : {}),
        ...(typeof body.column === "number" ? { column: body.column } : {}),
        ...(typeof body.cwd === "string" && body.cwd ? { cwd: body.cwd } : {}),
      }
      const result = await runOpenInEditor(target, editorDeps)
      if (!result.ok) console.warn("[chunky] openInEditor refused:", result.error)
      return result
    },

    /**
     * Fuzzy directory search under bounded roots (Downloads/Projects/…).
     * Input: { query: string, limit?: number }
     * Output: { items: { name, path }[], error?: string }
     */
    searchDirectories: async (params: unknown) => {
      try {
        const body =
          params && typeof params === "object"
            ? (params as { query?: unknown; limit?: unknown })
            : {}
        const query = clampQuery(body.query)
        if (!query) return { items: [] as { name: string; path: string }[] }
        const limit = clampLimit(body.limit)
        const items = await searchDirectories(query, limit, extraRoots)
        return { items }
      } catch (err) {
        const message = err instanceof Error ? err.message : "Directory search failed"
        console.warn("[chunky] searchDirectories:", message)
        return { items: [] as { name: string; path: string }[], error: message }
      }
    },

    /**
     * Bounded, existing directories a clone can land in (~/code, ~/Projects, …
     * plus the launch workspace's parent). Used to pre-fill the clone
     * destination; the webview has no filesystem of its own.
     * Output: { roots: string[] }
     */
    cloneRoots: async () => ({ roots: candidateRoots(extraRoots) }),

    /**
     * Create a new empty folder for "Add repository → New folder". The webview
     * has no filesystem; this is a plain node:fs mkdir (no shell), and it
     * refuses to reuse anything that already exists at the target.
     * Input: { parentDir: string (absolute, existing), name: string }
     * Output: { ok, path, error?, existed? }
     */
    createDirectory: async (params: unknown) =>
      createDirectory((params ?? {}) as { parentDir?: unknown; name?: unknown }),

    zooStatus: async (params: unknown) => zoo.status(params),
    zooEnsureLedgerSkill: async (_params: unknown) => ensureZooLedgerSkill(),
    zooListSetupSessions: async (params: unknown) => zoo.listSetupSessions(params),
    zooRecordSetupSession: async (params: unknown) => zoo.recordSetupSession(params),
    zooListCredentials: async (params: unknown) => zoo.listCredentials(params),
    zooSetCredential: async (params: unknown) => zoo.setCredential(params),
    zooDeleteCredential: async (params: unknown) => zoo.deleteCredential(params),
    zooRecordJamSession: async (params: unknown) => zoo.recordJamSession(params),
    zooListAreas: async (params: unknown) => zoo.listAreas(params),
    zooCreateArea: async (params: unknown) => zoo.createArea(params),
    zooUpdateArea: async (params: unknown) => zoo.updateArea(params),
    zooDeleteArea: async (params: unknown) => zoo.deleteArea(params),
    zooAssignArea: async (params: unknown) => zoo.assignArea(params),
    zooListRepoWatches: async (params: unknown) => zoo.listRepoWatches(params),
    zooAddRepoWatch: async (params: unknown) => {
      const result = await zoo.addRepoWatch(params)
      if (result.ok) void watchScheduler.start().catch(() => {})
      return result
    },
    zooRemoveRepoWatch: async (params: unknown) => zoo.removeRepoWatch(params),
    zooSetWatchSchedule: async (params: unknown) => {
      const result = await zoo.setWatchSchedule(params)
      if (result.ok) await watchScheduler.reschedule()
      return result
    },
    zooCheckRepoWatches: async (params: unknown) => {
      const body = params && typeof params === "object" && !Array.isArray(params) ? (params as Record<string, unknown>) : {}
      if (typeof body.watchId === "string") return zoo.checkRepoWatches(body)
      const outcome = await watchScheduler.checkNow()
      return outcome.ran ? outcome.result : { ok: false as const, error: "A competitor-watch check is already running." }
    },
    zooMarkWatchExtracted: async (params: unknown) => zoo.markWatchExtracted(params),
    zooWatchState: async (params: unknown) => zoo.watchState(params),
    zooListXWatches: async (params: unknown) => zoo.listXWatches(params),
    zooAddXWatch: async (params: unknown) => {
      const result = await zoo.addXWatch(params)
      if (result.ok) void xWatchScheduler.start().catch(() => {})
      return result
    },
    zooRemoveXWatch: async (params: unknown) => zoo.removeXWatch(params),
    zooSetXWatchSchedule: async (params: unknown) => {
      const result = await zoo.setXWatchSchedule(params)
      if (result.ok) await xWatchScheduler.reschedule()
      return result
    },
    zooCheckXWatches: async (params: unknown) => {
      const body = params && typeof params === "object" && !Array.isArray(params) ? params as Record<string, unknown> : {}
      if (typeof body.watchId === "string") return zoo.checkXWatches(body)
      const outcome = await xWatchScheduler.checkNow()
      return outcome.ran ? outcome.result : { ok: false as const, error: "An X-watch check is already running." }
    },
    zooMarkXWatchExtracted: async (params: unknown) => zoo.markXWatchExtracted(params),
    zooXWatchState: async (params: unknown) => zoo.xWatchState(params),
    zooConnectLinear: async (params: unknown) => zoo.connectLinear(params),
    zooConnectTranscripts: async (params: unknown) => zoo.connectTranscripts(params),
    zooStartBackfill: async (params: unknown) => zoo.startBackfill(params),
    zooListArtifacts: async (params: unknown) => zoo.listArtifacts(params),
    zooGetArtifact: async (params: unknown) => zoo.getArtifact(params),
    zooExportForExtraction: async (params: unknown) => zoo.exportForExtraction(params),
    zooRecordInsights: async (params: unknown) => zoo.recordInsights(params),
    zooFailPass: async (params: unknown) => zoo.failPass(params),
    zooListInsights: async (params: unknown) => zoo.listInsights(params),
    zooExportInsightsForSynthesis: async (params: unknown) => zoo.exportInsightsForSynthesis(params),
    zooRecordIdeas: async (params: unknown) => zoo.recordIdeas(params),
    zooListIdeas: async (params: unknown) => zoo.listIdeas(params),
    zooSetIdeaStatus: async (params: unknown) => zoo.setIdeaStatus(params),
    zooCreateItem: async (params: unknown) => zoo.createItem(params),
    zooUpdateItem: async (params: unknown) => zoo.updateItem(params),
    zooListItems: async (params: unknown) => zoo.listItems(params),

    terminalOpen: async (params: unknown) => terminals.open(params),
    terminalWrite: async (params: unknown) => terminals.write(params),
    terminalResize: async (params: unknown) => terminals.resize(params),
    terminalClose: async (params: unknown) => terminals.close(params),

    gitIdentity: async (params: unknown) => git.gitIdentity(params ?? {}),
    gitStatus: async (params: unknown) => git.gitStatus(params ?? {}),
    gitBranches: async (params: unknown) => git.gitBranches(params ?? {}),
    gitStage: async (params: unknown) => git.gitStage(params ?? {}),
    gitUnstage: async (params: unknown) => git.gitUnstage(params ?? {}),
    gitCommit: async (params: unknown) => git.gitCommit(params ?? {}),
    gitSwitch: async (params: unknown) => git.gitSwitch(params ?? {}),
    gitPull: async (params: unknown) => git.gitPull(params ?? {}),
    gitPush: async (params: unknown) => git.gitPush(params ?? {}),
    scmInfo: async (params: unknown) => git.scmInfo(params ?? {}),
    scmCreatePr: async (params: unknown) => git.scmCreatePr(params ?? {}),
    scmListPrs: async (params: unknown) => git.scmListPrs(params ?? {}),
    scmCheckoutPr: async (params: unknown) => git.scmCheckoutPr(params ?? {}),
    scmClone: async (params: unknown) => git.scmClone(params ?? {}),
    scmPublish: async (params: unknown) => git.scmPublish(params ?? {}),
  },
})

// Initializing the Zoo is also what creates the four first-run watch sources.
// Existing stores are migrated in place and never seeded. The scheduler owns
// catch-up and all later re-arming; GitHub remains entirely in this Bun process.
void watchScheduler.start().catch((error) => console.warn("[zoo] competitor watch scheduler:", error))
void xWatchScheduler.start().catch((error) => console.warn("[zoo] X-watch scheduler:", error instanceof Error ? error.message : "unknown error"))
cookieSync.start()

// First-run setup can take minutes (release download → bun install → server
// start). Push each stage to the webview over the existing fire-and-forget
// message channel so the connecting screen can say what is happening. Stages
// carry no credentials, and every failure here is swallowed: progress must
// never be able to break the install or the connection it describes.
setSetupStageReporter((stage: SetupStage) => {
  try {
    const send = rpc?.send as unknown as Record<string, (value: unknown) => void> | undefined
    send?.[SETUP_STAGE_MESSAGE]?.(stage)
  } catch {
    /* the webview may not be attached yet, or may be gone */
  }
})

const url = await getMainViewUrl()

const win = new BrowserWindow({
  title: "Chunky",
  url,
  rpc,
  renderer: "native",
  // Codex-style chrome: no separate OS titlebar; the WebView extends to the top
  // and the native traffic lights float inset over our top bar.
  titleBarStyle: "hiddenInset",
  trafficLightOffset: { x: 12, y: 18 },
  frame: { width: 1280, height: 850, x: 100, y: 60 },
  minWidth: 840,
  minHeight: 560,
})

// AppKit resets the standard window buttons to their default position when a
// window leaves fullscreen, ignoring our custom offset until the next layout
// pass. Reapply the offset on every resize (exiting fullscreen fires one) so
// the traffic lights never sit over the brand strip's Chunky mark.
win.on("resize", () => {
  try {
    if (!win.isFullScreen()) win.setWindowButtonPosition(12, 18)
  } catch {
    // Best-effort cosmetic fix; never let it interfere with resizing.
  }
})

// Tear down native FFF handles when the process is leaving.
const cleanup = () => {
  watchScheduler.stop()
  xWatchScheduler.stop()
  zoo.close()
  terminals.destroy()
  destroyFinders()
  void releaseChunkyConnection()
}
process.on("exit", cleanup)
process.on("SIGINT", () => {
  cleanup()
  process.exit(0)
})
process.on("SIGTERM", () => {
  cleanup()
  process.exit(0)
})
// Best-effort: if the window is closed and this is the last one, Electrobun
// typically exits; keep the hook for explicit destroy if the API surfaces it.
void win

console.log("[chunky] window ready")

// Do not delay window startup or surface a dialog unless an update exists.
// checkForUpdates also refreshes the installed Chunky server runtime. Check
// shortly after boot, then periodically so long-running apps still hear about
// new releases and get prompted to update.
const UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000
setTimeout(() => void checkForUpdates(), 4_000)
setInterval(() => void checkForUpdates(), UPDATE_CHECK_INTERVAL_MS)
