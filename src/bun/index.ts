import { BrowserWindow, ApplicationMenu, createRPC, Updater, Utils } from "electrobun/bun"
import { join } from "node:path"
import { homedir } from "node:os"
import {
  candidateRoots,
  destroyFinders,
  ensureFinders,
  parentRoot,
  searchDirectories,
} from "./dirSearch"
import { createTerminalManager } from "./terminal"
import * as git from "./git"
import { releaseChunkyConnection, rememberChunkyWorkspace, resolveChunkyConnection } from "./connectionManager"

const DEV_SERVER_URL = process.env.VITE_DEV_URL ?? "http://localhost:5173"

// Prefer the Vite HMR server in dev; fall back to the bundled view.
async function getMainViewUrl(): Promise<string> {
  try {
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

/** Check, download, and offer to restart for an Electrobun release update. */
async function checkForUpdates({ interactive = false } = {}): Promise<void> {
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

let rpc!: ReturnType<typeof createRPC>
const terminals = createTerminalManager((name, payload) => {
  const send = rpc.send as unknown as Record<string, (value: unknown) => void>
  send[name]?.(payload)
})

rpc = createRPC({
  maxRequestTime: 180_000,
  requestHandler: {
    // Served to the webview over RPC. Connection resolution and the bearer
    // token stay in Bun; production renderer assets never contain credentials.
    getConfig: async () => {
      const config = await resolveChunkyConnection()
      return {
        ...config,
        workspaceName: (config.workspace || workspace).split(/[\\/]/).filter(Boolean).pop() || "workspace",
      }
    },

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

    terminalOpen: async (params: unknown) => terminals.open(params),
    terminalWrite: async (params: unknown) => terminals.write(params),
    terminalResize: async (params: unknown) => terminals.resize(params),
    terminalClose: async (params: unknown) => terminals.close(params),

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

// Tear down native FFF handles when the process is leaving.
const cleanup = () => {
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
setTimeout(() => void checkForUpdates(), 4_000)
