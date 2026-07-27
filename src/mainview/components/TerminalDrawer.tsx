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
import { Terminal, type ITheme } from "@xterm/xterm"
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

const STORAGE_KEY = "chunky.terminals.v1"
const MIN_HEIGHT = 120
const DEFAULT_HEIGHT = 260
const MAX_HEIGHT_RATIO = 0.7
/** Side-by-side panes allowed inside one tab group. */
const MAX_TERMINALS_PER_GROUP = 4

const FONT_FAMILY = "JetBrains Mono, SF Mono, ui-monospace, Menlo, monospace"

/** Group = one tab entry; >1 id renders side-by-side in an equal-column grid. */
type TerminalGroup = { id: string; ids: string[] }

type Persisted = {
  open: boolean
  height: number
  groups: TerminalGroup[]
  activeId: string | null
  seq: number
}

const EMPTY: Persisted = {
  open: false,
  height: DEFAULT_HEIGHT,
  groups: [],
  activeId: null,
  seq: 1,
}

function maxHeight(): number {
  if (typeof window === "undefined") return DEFAULT_HEIGHT
  return Math.max(MIN_HEIGHT, Math.floor(window.innerHeight * MAX_HEIGHT_RATIO))
}

function clampHeight(value: number): number {
  const safe = Number.isFinite(value) ? value : DEFAULT_HEIGHT
  return Math.min(Math.max(Math.round(safe), MIN_HEIGHT), maxHeight())
}

function readPersisted(): Persisted {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return EMPTY
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== "object") return EMPTY
    const body = parsed as Partial<Persisted>
    const groups: TerminalGroup[] = []
    const seen = new Set<string>()
    if (Array.isArray(body.groups)) {
      for (const group of body.groups) {
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
    }
    const activeId =
      typeof body.activeId === "string" && seen.has(body.activeId) ? body.activeId : (groups[0]?.ids[0] ?? null)
    const seq = typeof body.seq === "number" && Number.isFinite(body.seq) ? Math.max(1, Math.floor(body.seq)) : seen.size + 1
    return {
      open: body.open === true,
      height: clampHeight(typeof body.height === "number" ? body.height : DEFAULT_HEIGHT),
      groups,
      activeId,
      seq,
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

function labelFor(id: string): string {
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
  cwd,
  resolvedTheme,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Working directory for newly spawned shells (active repo path). */
  cwd?: string
  resolvedTheme: "light" | "dark"
}) {
  const initial = useMemo(readPersisted, [])
  const [height, setHeight] = useState(() => clampHeight(initial.height))
  const [groups, setGroups] = useState<TerminalGroup[]>(() => initial.groups)
  const [activeId, setActiveId] = useState<string | null>(() => initial.activeId)
  const [exited, setExited] = useState<Record<string, boolean>>({})
  const [restarts, setRestarts] = useState<Record<string, number>>({})
  const seqRef = useRef(initial.seq)

  const available = terminalsAvailable()
  const theme = resolvedTheme === "dark" ? DARK_THEME : LIGHT_THEME

  const heightRef = useRef(height)
  heightRef.current = height
  const dragRef = useRef<{ pointerId: number; startY: number; startHeight: number } | null>(null)

  // Persist the whole drawer shape (open + height + tabs) on every change.
  useEffect(() => {
    writePersisted({ open, height, groups, activeId, seq: seqRef.current })
  }, [open, height, groups, activeId])

  const createTerminal = useCallback(
    (mode: "tab" | "split") => {
      const id = `term-${seqRef.current++}`
      setGroups((prev) => {
        if (mode === "split") {
          const target = prev.find((g) => g.ids.some((t) => t === activeId))
          if (target && target.ids.length < MAX_TERMINALS_PER_GROUP) {
            return prev.map((g) => (g.id === target.id ? { ...g, ids: [...g.ids, id] } : g))
          }
        }
        return [...prev, { id: `group-${id}`, ids: [id] }]
      })
      setActiveId(id)
    },
    [activeId],
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
      const removedIndex = groups.flatMap((g) => g.ids).indexOf(id)
      const nextGroups = groups
        .map((g) => ({ ...g, ids: g.ids.filter((t) => t !== id) }))
        .filter((g) => g.ids.length > 0)
      setGroups(nextGroups)
      if (activeId === id) {
        const remaining = nextGroups.flatMap((g) => g.ids)
        const fallbackIndex = Math.min(Math.max(removedIndex - 1, 0), Math.max(remaining.length - 1, 0))
        setActiveId(remaining.length === 0 ? null : (remaining[fallbackIndex] ?? null))
      }
    },
    [groups, activeId],
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

  // Opening an empty drawer spawns one shell. Guarded by a ref so React's
  // StrictMode double-effect (and later group changes) can't spawn duplicates —
  // closing the last tab leaves the empty state, it does not respawn.
  const wasOpenRef = useRef(false)
  const groupCountRef = useRef(groups.length)
  groupCountRef.current = groups.length
  useEffect(() => {
    if (!open) {
      wasOpenRef.current = false
      return
    }
    if (wasOpenRef.current) return
    wasOpenRef.current = true
    if (available && groupCountRef.current === 0) createTerminal("tab")
  }, [open, available, createTerminal])

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

  if (!open) return null

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
                return (
                  <div key={id} className="group/tab relative flex shrink-0 items-center">
                    <button
                      type="button"
                      role="tab"
                      aria-selected={active}
                      onClick={() => setActiveId(id)}
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
                      <span className="truncate">{labelFor(id)}</span>
                    </button>
                    <button
                      type="button"
                      aria-label={`Close ${labelFor(id)}`}
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
