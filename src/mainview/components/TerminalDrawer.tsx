import { Columns2, Plus, RotateCcw, SquareTerminal, X } from "lucide-react"
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react"
import { FitAddon } from "@xterm/addon-fit"
import { WebglAddon } from "@xterm/addon-webgl"
import { Terminal, type IDisposable, type ITheme } from "@xterm/xterm"
import { cn } from "~/lib/cn"
import {
  onTerminalData,
  onTerminalExit,
  terminalClose,
  terminalOpen,
  terminalResize,
  terminalWrite,
  terminalsAvailable,
} from "~/lib/terminal"
import { Button } from "./ui/button"
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip"

const STORAGE_KEY = "chunky.terminals.v2"
const LEGACY_STORAGE_KEY = "chunky.terminals.v1"
const MIN_HEIGHT = 120
const DEFAULT_HEIGHT = 260
const MAX_HEIGHT_RATIO = 0.7
/** Side-by-side panes allowed inside one tab group. */
const MAX_TERMINALS_PER_GROUP = 4
/** Custom tab names are trimmed and capped to keep the tab strip readable. */
const MAX_NAME_LENGTH = 40
/** Drop the oldest persisted chat scopes so localStorage stays bounded. */
const MAX_SCOPES = 20

const FONT_FAMILY = "JetBrains Mono, SF Mono, ui-monospace, Menlo, monospace"

/** Group = one tab entry; >1 id renders side-by-side in an equal-column grid. */
type TerminalGroup = { id: string; ids: string[] }

/** Per-chat tab strip. `lastUsed` is Date.now() at last write, for LRU prune. */
type TerminalScope = {
  groups: TerminalGroup[]
  /** Custom tab names by terminal id; absent → the default "Terminal N" label. */
  names: Record<string, string>
  activeId: string | null
  seq: number
  lastUsed: number
}

type Persisted = {
  open: boolean
  height: number
  scopes: Record<string, TerminalScope>
}

const EMPTY_SCOPE: TerminalScope = {
  groups: [],
  names: {},
  activeId: null,
  seq: 1,
  lastUsed: 0,
}

const EMPTY: Persisted = {
  open: false,
  height: DEFAULT_HEIGHT,
  scopes: {},
}

function maxHeight(): number {
  if (typeof window === "undefined") return DEFAULT_HEIGHT
  return Math.max(MIN_HEIGHT, Math.floor(window.innerHeight * MAX_HEIGHT_RATIO))
}

function clampHeight(value: number): number {
  const safe = Number.isFinite(value) ? value : DEFAULT_HEIGHT
  return Math.min(Math.max(Math.round(safe), MIN_HEIGHT), maxHeight())
}

function parseGroups(raw: unknown): { groups: TerminalGroup[]; seen: Set<string> } {
  const groups: TerminalGroup[] = []
  const seen = new Set<string>()
  if (!Array.isArray(raw)) return { groups, seen }
  for (const group of raw) {
    if (!group || typeof group !== "object") continue
    const gid = (group as { id?: unknown }).id
    const ids = (group as { ids?: unknown }).ids
    if (typeof gid !== "string" || !Array.isArray(ids)) continue
    const clean = ids
      .filter((id): id is string => typeof id === "string" && id.length > 0 && !seen.has(id))
      .slice(0, MAX_TERMINALS_PER_GROUP)
    for (const id of clean) seen.add(id)
    if (clean.length > 0) groups.push({ id: gid, ids: clean })
  }
  return { groups, seen }
}

function parseNames(raw: unknown, seen: Set<string>): Record<string, string> {
  const names: Record<string, string> = {}
  if (!raw || typeof raw !== "object") return names
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!seen.has(id) || typeof value !== "string") continue
    const clean = value.trim().slice(0, MAX_NAME_LENGTH)
    if (clean) names[id] = clean
  }
  return names
}

function parseScope(raw: unknown): TerminalScope | null {
  if (!raw || typeof raw !== "object") return null
  const body = raw as Partial<TerminalScope>
  const { groups, seen } = parseGroups(body.groups)
  const names = parseNames(body.names, seen)
  const activeId =
    typeof body.activeId === "string" && seen.has(body.activeId) ? body.activeId : (groups[0]?.ids[0] ?? null)
  const seq =
    typeof body.seq === "number" && Number.isFinite(body.seq) ? Math.max(1, Math.floor(body.seq)) : seen.size + 1
  const lastUsed =
    typeof body.lastUsed === "number" && Number.isFinite(body.lastUsed) ? Math.max(0, Math.floor(body.lastUsed)) : 0
  return { groups, names, activeId, seq, lastUsed }
}

function pruneScopes(scopes: Record<string, TerminalScope>, keep?: string): Record<string, TerminalScope> {
  const keys = Object.keys(scopes)
  if (keys.length <= MAX_SCOPES) return scopes
  const ranked = keys.sort((a, b) => {
    const diff = (scopes[b]?.lastUsed ?? 0) - (scopes[a]?.lastUsed ?? 0)
    if (diff !== 0) return diff
    return a < b ? -1 : a > b ? 1 : 0
  })
  const next: Record<string, TerminalScope> = {}
  for (const key of ranked.slice(0, MAX_SCOPES)) {
    const scope = scopes[key]
    if (scope) next[key] = scope
  }
  // The live chat must survive even if it was the coldest of 21+.
  if (keep && scopes[keep] && !next[keep]) {
    const evict = ranked.slice(0, MAX_SCOPES).find((key) => key !== keep)
    if (evict) delete next[evict]
    next[keep] = scopes[keep]
  }
  return next
}

function dropLegacyStorage(): void {
  try {
    localStorage.removeItem(LEGACY_STORAGE_KEY)
  } catch {
    /* storage disabled */
  }
}

function readPersisted(): Persisted {
  try {
    dropLegacyStorage()
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return EMPTY
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== "object") return EMPTY
    const body = parsed as Partial<Persisted>
    const scopes: Record<string, TerminalScope> = {}
    if (body.scopes && typeof body.scopes === "object") {
      for (const [key, value] of Object.entries(body.scopes as Record<string, unknown>)) {
        if (!key) continue
        const scope = parseScope(value)
        if (scope) scopes[key] = scope
      }
    }
    return {
      open: body.open === true,
      height: clampHeight(typeof body.height === "number" ? body.height : DEFAULT_HEIGHT),
      scopes: pruneScopes(scopes),
    }
  } catch {
    return EMPTY
  }
}

function writePersisted(state: Persisted): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch {
    /* quota / storage disabled */
  }
}

/** Initial drawer visibility for App state (persisted across launches). */
export function loadTerminalsOpen(): boolean {
  return readPersisted().open
}

/* ── xterm theme ─────────────────────────────────────────────────────────────
   Hand-converted from the oklch tokens in index.css (card/foreground/primary)
   and the tok-* code palette — xterm can't parse oklch(), so these are the
   sRGB equivalents. */
const DARK_THEME: ITheme = {
  background: "#17161e",
  foreground: "#f4f3f6",
  cursor: "#936af8",
  cursorAccent: "#17161e",
  selectionBackground: "rgba(147, 106, 248, 0.32)",
  black: "#2e2d34",
  red: "#f4514f",
  green: "#37c080",
  yellow: "#f0a732",
  blue: "#60c2ff",
  magenta: "#c099ff",
  cyan: "#4fcdcd",
  white: "#d2d0d7",
  brightBlack: "#55545d",
  brightRed: "#ff8179",
  brightGreen: "#73dea4",
  brightYellow: "#ffc76d",
  brightBlue: "#8ccaff",
  brightMagenta: "#d6b9ff",
  brightCyan: "#85e4e3",
  brightWhite: "#f5f4f7",
}

const LIGHT_THEME: ITheme = {
  background: "#ffffff",
  foreground: "#25222d",
  cursor: "#7546d6",
  cursorAccent: "#ffffff",
  selectionBackground: "rgba(117, 70, 214, 0.22)",
  black: "#3e3b47",
  red: "#df202e",
  green: "#0fa05c",
  yellow: "#dc8900",
  blue: "#0064b9",
  magenta: "#773ac1",
  cyan: "#008585",
  white: "#a5a4a9",
  brightBlack: "#726f7c",
  brightRed: "#f05653",
  brightGreen: "#47b777",
  brightYellow: "#f0a646",
  brightBlue: "#4c9deb",
  brightMagenta: "#9260da",
  brightCyan: "#2ca2a2",
  brightWhite: "#efeef1",
}

function defaultLabelFor(id: string): string {
  const n = id.match(/(\d+)$/)?.[1]
  return n ? `Terminal ${n}` : id
}

/* ── One xterm instance ──────────────────────────────────────────────────── */

function TerminalPane({
  id,
  cwd,
  focused,
  theme,
  restartKey,
  exited,
  onExited,
  onActivate,
  onRestart,
}: {
  id: string
  cwd?: string
  focused: boolean
  theme: ITheme
  restartKey: number
  exited: boolean
  onExited: (exitCode: number | null) => void
  onActivate: () => void
  onRestart: () => void
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const lastSizeRef = useRef<{ cols: number; rows: number }>({ cols: 0, rows: 0 })
  const rafRef = useRef<number | null>(null)
  const cwdRef = useRef<string | undefined>(cwd)
  const themeRef = useRef<ITheme>(theme)
  const onExitedRef = useRef(onExited)

  // Keep latest values available to the (deliberately non-reactive) mount effect.
  useEffect(() => {
    cwdRef.current = cwd
    onExitedRef.current = onExited
  })

  useEffect(() => {
    themeRef.current = theme
    const term = termRef.current
    if (term) term.options.theme = theme
  }, [theme])

  const fit = useCallback(() => {
    const term = termRef.current
    const fitAddon = fitRef.current
    const host = hostRef.current
    if (!term || !fitAddon || !host) return
    // Hidden (inactive tab) panes measure 0 — skip until they are shown again.
    if (host.clientWidth < 16 || host.clientHeight < 16) return
    try {
      fitAddon.fit()
    } catch {
      return
    }
    const { cols, rows } = term
    if (cols < 1 || rows < 1) return
    if (cols === lastSizeRef.current.cols && rows === lastSizeRef.current.rows) return
    lastSizeRef.current = { cols, rows }
    void terminalResize(id, cols, rows)
  }, [id])

  // Create / recreate the terminal. `restartKey` bumps re-spawn the process.
  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 12,
      fontFamily: FONT_FAMILY,
      scrollback: 5000,
      lineHeight: 1.2,
      theme: themeRef.current,
      allowTransparency: true,
    })
    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    term.open(host)
    termRef.current = term
    fitRef.current = fitAddon
    lastSizeRef.current = { cols: 0, rows: 0 }

    /* GPU renderer. Every failure mode falls back to xterm's DOM renderer:
       activation throws when the webview has no WebGL2 context, and disposing
       the addon after a lost context restores the DOM renderer in place — so a
       dead GL context can never leave a blank pane. */
    let webgl: WebglAddon | null = null
    let contextLoss: IDisposable | null = null
    const dropWebgl = () => {
      contextLoss?.dispose()
      contextLoss = null
      const addon = webgl
      webgl = null
      try {
        addon?.dispose()
      } catch {
        /* already torn down with the context */
      }
    }
    try {
      const addon = new WebglAddon()
      term.loadAddon(addon)
      webgl = addon
      contextLoss = addon.onContextLoss(() => dropWebgl())
    } catch {
      dropWebgl()
    }

    let disposed = false
    let opened = false
    const pending: string[] = []

    const offData = onTerminalData((payload) => {
      if (payload.id !== id || disposed) return
      // Data can beat the open() response — buffer until the snapshot is written.
      if (!opened) {
        pending.push(payload.data)
        return
      }
      term.write(payload.data)
    })

    const offExit = onTerminalExit((payload) => {
      if (payload.id !== id || disposed) return
      const code = payload.exitCode
      term.write(`\r\n\x1b[2m[process exited${code == null ? "" : ` · code ${code}`}]\x1b[0m\r\n`)
      onExitedRef.current(code)
    })

    const dataSub = term.onData((data) => {
      void terminalWrite(id, data)
    })

    try {
      fitAddon.fit()
    } catch {
      /* not laid out yet — the ResizeObserver will fit shortly */
    }

    void (async () => {
      const result = await terminalOpen({
        id,
        cwd: cwdRef.current,
        cols: Math.max(term.cols, 1),
        rows: Math.max(term.rows, 1),
      })
      if (disposed) return
      if (result.ok) {
        if (result.snapshot) term.write(result.snapshot)
      } else {
        term.write(`\x1b[31m${result.error}\x1b[0m\r\n`)
      }
      opened = true
      for (const chunk of pending) term.write(chunk)
      pending.length = 0
      lastSizeRef.current = { cols: term.cols, rows: term.rows }
    })()

    const observer = new ResizeObserver(() => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null
        fit()
      })
    })
    observer.observe(host)

    return () => {
      disposed = true
      observer.disconnect()
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
      offData()
      offExit()
      dataSub.dispose()
      dropWebgl()
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
  }, [id, restartKey, fit])

  useEffect(() => {
    if (!focused) return
    const t = window.setTimeout(() => termRef.current?.focus(), 0)
    return () => window.clearTimeout(t)
  }, [focused, restartKey])

  return (
    <div
      className="relative min-h-0 min-w-0 overflow-hidden rounded-lg bg-card"
      onMouseDown={onActivate}
    >
      <div ref={hostRef} className="size-full [&_.xterm]:h-full [&_.xterm-viewport]:!bg-transparent" />
      {exited && (
        <div className="absolute inset-x-0 bottom-0 flex items-center justify-between gap-2 border-border/70 border-t bg-card/95 px-2 py-1.5 backdrop-blur-sm">
          <span className="truncate text-[11px] text-muted-foreground">Process exited</span>
          <Button variant="outline" size="sm" className="h-6 gap-1.5 px-2 text-[11px]" onClick={onRestart}>
            <RotateCcw className="size-3" />
            Restart
          </Button>
        </div>
      )}
    </div>
  )
}

/* ── Drawer ──────────────────────────────────────────────────────────────── */

export function TerminalDrawer({
  open,
  onOpenChange,
  scopeKey,
  cwd,
  resolvedTheme,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Chat/session identity. Null hides the drawer; each key has its own tabs. */
  scopeKey: string | null
  /** Working directory for newly spawned shells (session workspace, else repo). */
  cwd?: string
  resolvedTheme: "light" | "dark"
}) {
  const initial = useMemo(readPersisted, [])
  const [height, setHeight] = useState(() => clampHeight(initial.height))
  const [scopes, setScopes] = useState<Record<string, TerminalScope>>(() => initial.scopes)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState("")
  const cancelRenameRef = useRef(false)
  const [exited, setExited] = useState<Record<string, boolean>>({})
  const [restarts, setRestarts] = useState<Record<string, number>>({})

  const layout = scopeKey ? (scopes[scopeKey] ?? EMPTY_SCOPE) : EMPTY_SCOPE
  const groups = layout.groups
  const names = layout.names
  const activeId = layout.activeId

  const available = terminalsAvailable()
  const theme = resolvedTheme === "dark" ? DARK_THEME : LIGHT_THEME

  const heightRef = useRef(height)
  heightRef.current = height
  const dragRef = useRef<{ pointerId: number; startY: number; startHeight: number } | null>(null)

  const patchScope = useCallback(
    (recipe: (current: TerminalScope) => TerminalScope) => {
      if (!scopeKey) return
      setScopes((prev) => {
        const current = prev[scopeKey] ?? EMPTY_SCOPE
        const next = recipe(current)
        return next === current ? prev : { ...prev, [scopeKey]: next }
      })
    },
    [scopeKey],
  )

  // Persist global chrome + every known scope. lastUsed is stamped on the live
  // chat; other scopes keep the timestamp already on disk so a later write
  // cannot pretend they were never opened.
  useEffect(() => {
    const disk = readPersisted()
    const now = Date.now()
    const next: Record<string, TerminalScope> = {}
    for (const [key, value] of Object.entries(scopes)) {
      next[key] = {
        ...value,
        lastUsed: key === scopeKey ? now : (disk.scopes[key]?.lastUsed ?? value.lastUsed),
      }
    }
    const pruned = pruneScopes(next, scopeKey ?? undefined)
    writePersisted({ open, height, scopes: pruned })
    if (Object.keys(pruned).length !== Object.keys(scopes).length) {
      setScopes(pruned)
    }
  }, [open, height, scopes, scopeKey])

  const labelOf = useCallback((id: string) => names[id] ?? defaultLabelFor(id), [names])

  const startRename = useCallback(
    (id: string) => {
      cancelRenameRef.current = false
      setDraft(names[id] ?? defaultLabelFor(id))
      setEditingId(id)
    },
    [names],
  )

  /** Commit the inline edit. Empty (or unchanged-from-default) clears the custom name. */
  const commitRename = useCallback(
    (id: string) => {
      const value = draft.trim().slice(0, MAX_NAME_LENGTH)
      patchScope((current) => {
        const nextNames = { ...current.names }
        if (!value || value === defaultLabelFor(id)) delete nextNames[id]
        else nextNames[id] = value
        return { ...current, names: nextNames }
      })
      // The edit session is over: swallow any blur the unmounting input emits so
      // it cannot re-commit an already-cleared draft.
      cancelRenameRef.current = true
      setEditingId(null)
      setDraft("")
    },
    [draft, patchScope],
  )

  const cancelRename = useCallback(() => {
    // Tell the blur handler this teardown was an explicit cancel, not a commit.
    cancelRenameRef.current = true
    setEditingId(null)
    setDraft("")
  }, [])

  const createTerminal = useCallback(
    (mode: "tab" | "split") => {
      if (!scopeKey) return
      patchScope((current) => {
        const id = `${scopeKey}:term-${current.seq}`
        const seq = current.seq + 1
        if (mode === "split") {
          const target = current.groups.find((g) => g.ids.some((t) => t === current.activeId))
          if (target && target.ids.length < MAX_TERMINALS_PER_GROUP) {
            return {
              ...current,
              seq,
              activeId: id,
              groups: current.groups.map((g) => (g.id === target.id ? { ...g, ids: [...g.ids, id] } : g)),
            }
          }
        }
        return {
          ...current,
          seq,
          activeId: id,
          groups: [...current.groups, { id: `group-${id}`, ids: [id] }],
        }
      })
    },
    [scopeKey, patchScope],
  )

  const closeTerminal = useCallback(
    (id: string) => {
      void terminalClose(id)
      setExited((prev) => {
        if (!(id in prev)) return prev
        const next = { ...prev }
        delete next[id]
        return next
      })
      setRestarts((prev) => {
        if (!(id in prev)) return prev
        const next = { ...prev }
        delete next[id]
        return next
      })
      setEditingId((current) => (current === id ? null : current))
      patchScope((current) => {
        const removedIndex = current.groups.flatMap((g) => g.ids).indexOf(id)
        const nextGroups = current.groups
          .map((g) => ({ ...g, ids: g.ids.filter((t) => t !== id) }))
          .filter((g) => g.ids.length > 0)
        const nextNames = { ...current.names }
        delete nextNames[id]
        let nextActive = current.activeId
        if (current.activeId === id) {
          const remaining = nextGroups.flatMap((g) => g.ids)
          const fallbackIndex = Math.min(Math.max(removedIndex - 1, 0), Math.max(remaining.length - 1, 0))
          nextActive = remaining.length === 0 ? null : (remaining[fallbackIndex] ?? null)
        }
        return { ...current, groups: nextGroups, names: nextNames, activeId: nextActive }
      })
    },
    [patchScope],
  )

  const setActiveId = useCallback(
    (id: string) => {
      patchScope((current) => (current.activeId === id ? current : { ...current, activeId: id }))
    },
    [patchScope],
  )

  const restartTerminal = useCallback((id: string) => {
    setExited((prev) => {
      if (!prev[id]) return prev
      const next = { ...prev }
      delete next[id]
      return next
    })
    setRestarts((prev) => ({ ...prev, [id]: (prev[id] ?? 0) + 1 }))
  }, [])

  const markExited = useCallback((id: string) => {
    setExited((prev) => (prev[id] ? prev : { ...prev, [id]: true }))
  }, [])

  // Opening an empty drawer (or landing on a chat with no tabs) spawns one
  // shell. Delayed so a one-frame repo-switch fallback (`repo:${id}` while
  // sessionId is still null) cannot create an abandoned PTY. The timer is
  // cancelled if the scope changes or the drawer closes before it fires.
  // Primed only after a successful spawn so StrictMode's double-effect cannot
  // start two timers, and closing the last tab leaves the empty state.
  const primedRef = useRef<{ scope: string | null; open: boolean }>({ scope: null, open: false })
  const groupCountRef = useRef(groups.length)
  groupCountRef.current = groups.length
  useEffect(() => {
    setEditingId(null)
    setDraft("")
  }, [scopeKey])
  useEffect(() => {
    if (!open || !scopeKey) {
      primedRef.current = { scope: scopeKey, open: false }
      return
    }
    const primed = primedRef.current
    if (primed.open && primed.scope === scopeKey) return
    if (!available || groupCountRef.current > 0) {
      primedRef.current = { scope: scopeKey, open: true }
      return
    }
    const timer = window.setTimeout(() => {
      primedRef.current = { scope: scopeKey, open: true }
      if (groupCountRef.current === 0) createTerminal("tab")
    }, 250)
    return () => window.clearTimeout(timer)
  }, [open, available, createTerminal, scopeKey])

  const activeGroup = useMemo(
    () => groups.find((g) => g.ids.some((t) => t === activeId)) ?? groups[0] ?? null,
    [groups, activeId],
  )
  const canSplit = !!activeGroup && activeGroup.ids.length < MAX_TERMINALS_PER_GROUP

  const onResizePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    dragRef.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startHeight: heightRef.current,
    }
  }, [])

  const onResizePointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    event.preventDefault()
    setHeight(clampHeight(drag.startHeight + (drag.startY - event.clientY)))
  }, [])

  const onResizePointerEnd = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    dragRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }, [])

  // Keep the drawer inside the viewport when the window shrinks.
  useEffect(() => {
    if (!open) return
    const onWindowResize = () => setHeight((h) => clampHeight(h))
    window.addEventListener("resize", onWindowResize)
    return () => window.removeEventListener("resize", onWindowResize)
  }, [open])

  if (!open || !scopeKey) return null

  return (
    <div
      className="relative flex shrink-0 flex-col border-border border-t bg-card/60"
      style={{ height }}
    >
      <div
        role="separator"
        aria-label="Resize terminal drawer"
        aria-orientation="horizontal"
        className="-top-1 absolute inset-x-0 z-20 h-2 cursor-row-resize"
        onPointerDown={onResizePointerDown}
        onPointerMove={onResizePointerMove}
        onPointerUp={onResizePointerEnd}
        onPointerCancel={onResizePointerEnd}
      />

      <div className="no-drag flex h-8 shrink-0 items-center gap-1 border-border/70 border-b px-1.5">
        <SquareTerminal className="mr-0.5 size-3.5 shrink-0 text-muted-foreground" />
        <div
          role="tablist"
          aria-label="Terminals"
          className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {groups.map((group) => (
            <div
              key={group.id}
              className={cn(
                "flex shrink-0 items-center gap-0.5",
                group.ids.length > 1 && "rounded-md border border-border/70 px-0.5",
              )}
            >
              {group.ids.map((id) => {
                const active = id === activeId
                const label = labelOf(id)
                if (editingId === id) {
                  return (
                    <input
                      key={id}
                      autoFocus
                      value={draft}
                      maxLength={MAX_NAME_LENGTH}
                      aria-label={`Rename ${defaultLabelFor(id)}`}
                      onChange={(event) => setDraft(event.target.value)}
                      onFocus={(event) => event.currentTarget.select()}
                      onBlur={() => {
                        if (cancelRenameRef.current) {
                          cancelRenameRef.current = false
                          return
                        }
                        commitRename(id)
                      }}
                      onKeyDown={(event) => {
                        // Keep Ctrl+` / ⌘K / Escape-to-stop from firing while typing.
                        event.stopPropagation()
                        if (event.key === "Enter") {
                          event.preventDefault()
                          commitRename(id)
                        } else if (event.key === "Escape") {
                          event.preventDefault()
                          cancelRename()
                        }
                      }}
                      className="h-6 w-32 shrink-0 rounded-md border border-input bg-background/80 px-2 font-medium text-[11.5px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                    />
                  )
                }
                return (
                  <div key={id} className="group/tab relative flex shrink-0 items-center">
                    <button
                      type="button"
                      role="tab"
                      aria-selected={active}
                      title={`${label} — double-click to rename`}
                      onClick={() => setActiveId(id)}
                      onDoubleClick={() => startRename(id)}
                      className={cn(
                        "inline-flex h-6 max-w-[10rem] cursor-pointer items-center gap-1.5 rounded-md pr-6 pl-2 font-medium text-[11.5px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/40",
                        active
                          ? "bg-background/80 text-foreground shadow-xs"
                          : "text-muted-foreground hover:bg-background/40 hover:text-foreground",
                      )}
                    >
                      {exited[id] && (
                        <span
                          title="Process exited"
                          className="size-1.5 shrink-0 rounded-full bg-muted-foreground/60"
                        />
                      )}
                      <span className="truncate select-none">{label}</span>
                    </button>
                    <button
                      type="button"
                      aria-label={`Close ${label}`}
                      onClick={() => closeTerminal(id)}
                      className={cn(
                        "-translate-y-1/2 absolute top-1/2 right-0.5 flex size-4 cursor-pointer items-center justify-center rounded opacity-0 outline-none transition-opacity hover:bg-accent focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring/40 group-hover/tab:opacity-100",
                        active && "opacity-70",
                      )}
                    >
                      <X className="size-2.5" />
                    </button>
                  </div>
                )
              })}
            </div>
          ))}
        </div>

        <div className="flex shrink-0 items-center gap-0.5">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label="New terminal"
                  disabled={!available}
                  onClick={() => createTerminal("tab")}
                />
              }
            >
              <Plus />
            </TooltipTrigger>
            <TooltipPopup>New terminal</TooltipPopup>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Split terminal"
                  disabled={!available || !canSplit}
                  onClick={() => createTerminal("split")}
                />
              }
            >
              <Columns2 />
            </TooltipTrigger>
            <TooltipPopup>
              {canSplit ? "Split terminal" : `Max ${MAX_TERMINALS_PER_GROUP} panes per tab`}
            </TooltipPopup>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Hide terminal drawer"
                  onClick={() => onOpenChange(false)}
                />
              }
            >
              <X />
            </TooltipTrigger>
            <TooltipPopup>Hide terminal (Ctrl+`)</TooltipPopup>
          </Tooltip>
        </div>
      </div>

      <div className="relative min-h-0 flex-1">
        {!available ? (
          <div className="flex h-full flex-col items-center justify-center gap-1 px-6 text-center">
            <SquareTerminal className="size-5 text-muted-foreground/70" />
            <p className="font-medium text-[12.5px]">Terminal requires the desktop app</p>
            <p className="text-[11.5px] text-muted-foreground">
              Shells run in the Chunky desktop process — they're unavailable in the browser preview.
            </p>
          </div>
        ) : groups.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
            <p className="text-[12.5px] text-muted-foreground">No terminals open.</p>
            <Button variant="outline" size="sm" className="gap-1.5" onClick={() => createTerminal("tab")}>
              <Plus className="size-3.5" />
              New terminal
            </Button>
          </div>
        ) : (
          groups.map((group) => {
            const isActiveGroup = group.id === activeGroup?.id
            return (
              // Inactive groups stay mounted (hidden) so their xterm state and
              // scrollback survive tab switches.
              <div
                key={group.id}
                className={cn("absolute inset-0 grid gap-1 p-1", !isActiveGroup && "hidden")}
                style={{ gridTemplateColumns: `repeat(${group.ids.length}, minmax(0, 1fr))` }}
              >
                {group.ids.map((id) => (
                  <TerminalPane
                    key={id}
                    id={id}
                    cwd={cwd}
                    focused={isActiveGroup && id === activeId}
                    theme={theme}
                    restartKey={restarts[id] ?? 0}
                    exited={exited[id] === true}
                    onExited={() => markExited(id)}
                    onActivate={() => setActiveId(id)}
                    onRestart={() => restartTerminal(id)}
                  />
                ))}
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}
