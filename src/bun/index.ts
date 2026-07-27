import { BrowserWindow, ApplicationMenu, createRPC, Utils } from "electrobun/bun"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import {
  destroyFinders,
  ensureFinders,
  parentRoot,
  searchDirectories,
} from "./dirSearch"
import { createTerminalManager } from "./terminal"

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

// Local Chunky harness URL. Dev default 4620 matches `bun run server`.
// CHUNKY_URL / CHUNKY_PORT override when set intentionally.
const baseUrl =
  process.env.CHUNKY_URL || `http://localhost:${process.env.CHUNKY_PORT || 4620}`
const workspace = process.env.CHUNKY_WORKSPACE || process.cwd()
const workspaceName = workspace.split(/[\\/]/).filter(Boolean).pop() || "workspace"

function serverToken(): string | undefined {
  try {
    const raw = readFileSync(
      process.env.CHUNKY_SETTINGS || join(homedir(), ".chunky", "state", "settings.json"),
      "utf8",
    )
    const tok = (JSON.parse(raw) as { serverToken?: unknown }).serverToken
    return typeof tok === "string" && tok ? tok : undefined
  } catch {
    return undefined
  }
}

// Served to the webview over getConfig RPC. Never log the token.
const config = {
  baseUrl,
  workspace,
  workspaceName,
  serverToken: serverToken(),
}

const extraRoots = [parentRoot(workspace)].filter((p): p is string => !!p)

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
    getConfig: async () => config,

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
        return picked?.trim() ?? ""
      } catch (err) {
        console.warn("[chunky] openFolderDialog failed:", err)
        return ""
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

    terminalOpen: async (params: unknown) => terminals.open(params),
    terminalWrite: async (params: unknown) => terminals.write(params),
    terminalResize: async (params: unknown) => terminals.resize(params),
    terminalClose: async (params: unknown) => terminals.close(params),
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

console.log(`[chunky] window ready · server ${baseUrl}`)
