import { CloudDownload, Eye, Folder, FolderOpen, Loader2, Plus, Search, X } from "lucide-react"
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react"
import type { Repo } from "~/lib/api"
import { cn } from "~/lib/cn"
import {
  nativeDirSearchAvailable,
  searchDirectories,
  type DirSearchHit,
} from "~/lib/dirSearch"
import { nativePickerAvailable, pickFolder } from "~/lib/pickFolder"
import { parseGitUrl } from "~/lib/cloneRepo"
import { scmClone } from "~/lib/git"
import { nativeRpcAvailable } from "~/lib/rpc"
import { Button } from "./ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu"

const SEARCH_DEBOUNCE_MS = 180

/** Live state of an in-flight clone, owned by App and rendered here. */
export interface CloneStatus {
  phase: "running" | "registering" | "error"
  url: string
  /** The bootstrap session, once it exists — enables "View thread". */
  sessionId: string | null
  /** Recent agent activity, oldest first. */
  lines: string[]
  error: string | null
  /** The agent's last message, shown with a failure so it isn't a dead end. */
  agentMessage?: string
}

export function RepoTabs({
  repos,
  activeId,
  unreadRepoIds,
  onSelect,
  onAdd,
  onRemove,
  busy = false,
  disabled = false,
  onClone,
  cloneStatus = null,
  onCancelClone,
  onViewCloneThread,
  defaultCloneParent = "",
}: {
  repos: Repo[]
  activeId: string | null
  unreadRepoIds?: Set<string>
  onSelect: (id: string) => void
  onAdd: (path: string) => Promise<void>
  onRemove: (id: string) => void | Promise<void>
  busy?: boolean
  disabled?: boolean
  /** Clone a git URL through an agent session. Omitted → the section is hidden
   *  (demo/offline), so the three local add paths keep working untouched. */
  onClone?: (url: string, parentDir: string) => Promise<void>
  cloneStatus?: CloneStatus | null
  onCancelClone?: () => void
  onViewCloneThread?: (sessionId: string) => void
  /** Pre-filled destination folder (first native root, else the repo's parent). */
  defaultCloneParent?: string
}) {
  const [adding, setAdding] = useState(false)
  const [path, setPath] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [picking, setPicking] = useState(false)

  // Native-only fuzzy directory discovery (hidden in web mode).
  const canNative = nativePickerAvailable()
  const canSearch = nativeDirSearchAvailable()
  const [query, setQuery] = useState("")
  const [hits, setHits] = useState<DirSearchHit[]>([])
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)
  const [activeHit, setActiveHit] = useState(-1)

  // Clone-from-URL form. `cloneDest` starts from the app-provided default and
  // is then the user's to change (folder picker or free text).
  const [cloneUrl, setCloneUrl] = useState("")
  const [cloneDest, setCloneDest] = useState(defaultCloneParent)
  const [cloneError, setCloneError] = useState<string | null>(null)
  const [cloneStarting, setCloneStarting] = useState(false)
  const [directCloning, setDirectCloning] = useState(false)
  const cloneUrlRef = useRef<HTMLInputElement>(null)
  const cloneLogRef = useRef<HTMLDivElement>(null)
  const cloning = cloneStatus?.phase === "running" || cloneStatus?.phase === "registering"
  const canClone = !!onClone
  const canDirectClone = nativeRpcAvailable()

  const rootRef = useRef<HTMLDivElement>(null)
  const pathInputRef = useRef<HTMLInputElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const searchSeq = useRef(0)
  const formId = useId()
  const listboxId = useId()

  // The default only seeds the field; never clobber what the user typed.
  useEffect(() => {
    setCloneDest((current) => (current ? current : defaultCloneParent))
  }, [defaultCloneParent])

  // Keep the newest agent activity in view (the log is short and scrolls).
  useEffect(() => {
    const el = cloneLogRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [cloneStatus?.lines])


  const closeAdd = useCallback(() => {
    setAdding(false)
    setPath("")
    setError(null)
    setCloneError(null)
    setQuery("")
    setHits([])
    setSearchError(null)
    setActiveHit(-1)
    setPicking(false)
  }, [])

  useEffect(() => {
    if (!adding) return
    // A running clone keeps the popover open: its progress lines are the point.
    const onDown = (e: MouseEvent) => {
      if (cloning) return
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) closeAdd()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !cloning) closeAdd()
    }
    document.addEventListener("mousedown", onDown)
    document.addEventListener("keydown", onKey)
    return () => {
      document.removeEventListener("mousedown", onDown)
      document.removeEventListener("keydown", onKey)
    }
  }, [adding, closeAdd, cloning])

  useEffect(() => {
    if (!adding) return
    // Prefer search field when native search is available; else path paste.
    const t = window.setTimeout(() => {
      if (canSearch) searchInputRef.current?.focus()
      else pathInputRef.current?.focus()
    }, 0)
    return () => window.clearTimeout(t)
  }, [adding, canSearch])

  // Debounced FFF directory search.
  useEffect(() => {
    if (!adding || !canSearch) return
    const q = query.trim()
    if (!q) {
      // Invalidate any in-flight search so a slow response cannot repopulate hits.
      searchSeq.current += 1
      setHits([])
      setSearching(false)
      setSearchError(null)
      setActiveHit(-1)
      return
    }
    const seq = ++searchSeq.current
    setSearching(true)
    const t = window.setTimeout(() => {
      void (async () => {
        const res = await searchDirectories(q, 12)
        if (seq !== searchSeq.current) return
        setHits(res.items)
        setSearchError(res.error ?? null)
        setActiveHit(res.items.length > 0 ? 0 : -1)
        setSearching(false)
      })()
    }, SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(t)
  }, [query, adding, canSearch])

  // Cmd+1..9 / Cmd+Shift+[ ] tab switch (parity with old app).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey || e.ctrlKey || e.altKey || disabled) return
      if (repos.length === 0) return
      if (e.shiftKey && (e.code === "BracketLeft" || e.code === "BracketRight")) {
        e.preventDefault()
        const idx = repos.findIndex((r) => r.id === activeId)
        const base = idx === -1 ? 0 : idx
        const delta = e.code === "BracketRight" ? 1 : -1
        const next = (base + delta + repos.length) % repos.length
        onSelect(repos[next]!.id)
        return
      }
      if (!e.shiftKey && e.key >= "1" && e.key <= "9") {
        const n = Number(e.key) - 1
        if (n < repos.length) {
          e.preventDefault()
          onSelect(repos[n]!.id)
        }
      }
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [repos, activeId, onSelect, disabled])

  const submitAdd = useCallback(
    async (override?: string) => {
      const trimmed = (override ?? path).trim()
      if (!trimmed) {
        setError("Enter an absolute folder path.")
        return
      }
      setSubmitting(true)
      setError(null)
      try {
        await onAdd(trimmed)
        closeAdd()
      } catch (err) {
        setError((err as Error).message || "Couldn't add that folder.")
      } finally {
        setSubmitting(false)
      }
    },
    [path, onAdd, closeAdd],
  )

  /** Hand the URL + destination to the agent-backed clone flow (App owns the
   *  session, streaming, and the addRepo that follows). */
  const submitClone = useCallback(async () => {
    if (!onClone || cloning || cloneStarting) return
    const parsed = parseGitUrl(cloneUrl)
    if (!parsed) {
      setCloneError("Enter a git URL, e.g. https://github.com/owner/repo")
      return
    }
    const dest = cloneDest.trim()
    if (!dest.startsWith("/")) {
      setCloneError("Choose an absolute destination folder.")
      return
    }
    setCloneError(null)
    setCloneStarting(true)
    try {
      await onClone(parsed.url, dest)
      closeAdd()
      setCloneUrl("")
    } catch (err) {
      // The detailed failure (plus the agent's last message) renders from
      // cloneStatus; keep the form filled in so retry is one click.
      setCloneError((err as Error).message || "The clone didn't finish.")
    } finally {
      setCloneStarting(false)
    }
  }, [onClone, cloning, cloneStarting, cloneUrl, cloneDest, closeAdd])

  /** Fallback when the agent session can't be started: clone natively, then
   *  register the result through the ordinary add path. */
  const cloneDirectly = useCallback(async () => {
    const parsed = parseGitUrl(cloneUrl)
    if (!parsed) {
      setCloneError("Enter a git URL, e.g. https://github.com/owner/repo")
      return
    }
    const dest = cloneDest.trim()
    if (!dest.startsWith("/")) {
      setCloneError("Choose an absolute destination folder.")
      return
    }
    setDirectCloning(true)
    setCloneError(null)
    try {
      const result = await scmClone({ url: parsed.url, parentDir: dest })
      if (!result.ok || !result.path) {
        setCloneError(result.output || "git clone failed.")
        return
      }
      await onAdd(result.path)
      closeAdd()
      setCloneUrl("")
    } catch (err) {
      setCloneError((err as Error).message || "Couldn't clone that repository.")
    } finally {
      setDirectCloning(false)
    }
  }, [cloneUrl, cloneDest, onAdd, closeAdd])

  const fillFromHit = useCallback((hit: DirSearchHit) => {
    setPath(hit.path)
    setError(null)
    pathInputRef.current?.focus()
  }, [])

  /** `target` picks which field the chosen folder fills: the repo to add, or
   *  the destination a clone lands in. Fill only — the user still confirms. */
  const onChooseFolder = useCallback(
    async (target: "path" | "clone" = "path") => {
      if (!canNative || picking || submitting) return
      setPicking(true)
      setError(null)
      try {
        const picked = await pickFolder()
        if (!picked) return
        if (target === "clone") {
          setCloneDest(picked)
          setCloneError(null)
          cloneUrlRef.current?.focus()
        } else {
          setPath(picked)
          pathInputRef.current?.focus()
        }
      } finally {
        setPicking(false)
      }
    },
    [canNative, picking, submitting],
  )

  const onSearchKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      if (hits.length === 0) return
      e.preventDefault()
      setActiveHit((i) => (i + 1) % hits.length)
      return
    }
    if (e.key === "ArrowUp") {
      if (hits.length === 0) return
      e.preventDefault()
      setActiveHit((i) => (i <= 0 ? hits.length - 1 : i - 1))
      return
    }
    if (e.key === "Enter") {
      if (activeHit >= 0 && hits[activeHit]) {
        e.preventDefault()
        fillFromHit(hits[activeHit]!)
        return
      }
    }
  }

  return (
    <div ref={rootRef} className="no-drag relative flex min-w-0 flex-1 items-center gap-1.5">
      <div
        role="tablist"
        aria-label="Repositories"
        className="flex min-w-0 items-center gap-0.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {repos.map((r) => {
          const active = r.id === activeId
          return (
            <div key={r.id} className="group/tab relative flex shrink-0 items-center">
              <button
                type="button"
                role="tab"
                aria-selected={active}
                title={r.path}
                disabled={disabled || busy}
                onClick={() => onSelect(r.id)}
                className={cn(
                  "inline-flex h-7 max-w-[11rem] cursor-pointer items-center gap-1.5 rounded-md px-2 font-medium text-[12px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/40",
                  repos.length > 1 && "pr-7",
                  active
                    ? "bg-background/80 text-foreground shadow-xs"
                    : "text-muted-foreground hover:bg-background/40 hover:text-foreground",
                  (disabled || busy) && "opacity-60",
                )}
              >
                <Folder className="size-3.5 shrink-0 opacity-80" />
                <span className="truncate">{r.name}</span>
                {unreadRepoIds?.has(r.id) && (
                  <span className="size-1.5 shrink-0 rounded-full bg-primary" aria-label="unread completion" />
                )}
              </button>
              {repos.length > 1 && (
                <DropdownMenu>
                  <DropdownMenuTrigger
                    disabled={disabled || busy}
                    render={
                      <button
                        type="button"
                        aria-label={`Repo actions for ${r.name}`}
                        className={cn(
                          "absolute top-1/2 right-0.5 flex size-5 -translate-y-1/2 cursor-pointer items-center justify-center rounded opacity-0 outline-none transition-opacity hover:bg-accent focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring/40 group-hover/tab:opacity-100",
                          active && "opacity-70",
                        )}
                      />
                    }
                  >
                    <X className="size-3" />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" side="bottom" className="min-w-48">
                    <DropdownMenuItem disabled className="text-[11px] text-muted-foreground">
                      {r.path}
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      variant="destructive"
                      onClick={() => void onRemove(r.id)}
                    >
                      Remove from list…
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </div>
          )
        })}
      </div>

      <div className="relative shrink-0">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          disabled={disabled || busy || submitting}
          aria-label={busy ? "Adding repository…" : "Add repository"}
          title="Add folder"
          onClick={() => setAdding((v) => !v)}
          className="size-7 text-muted-foreground"
        >
          {busy || submitting ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Plus className="size-3.5" />
          )}
        </Button>

        {adding && (
          <div
            role="dialog"
            aria-labelledby={formId}
            className="absolute top-[calc(100%+6px)] left-0 z-50 w-[22rem] rounded-xl border border-border bg-popover p-3 text-popover-foreground shadow-panel"
          >
            <div id={formId} className="mb-1.5 font-medium text-[12px] text-foreground">
              Add a repository
            </div>
            <p className="mb-2.5 text-[11px] text-muted-foreground">
              {canNative
                ? "Choose a folder, search nearby projects, or paste an absolute path. Nothing is copied or deleted."
                : "Paste an absolute path to a local folder. This only registers it with Chunky — nothing is copied or deleted."}
            </p>

            {canNative && (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={submitting || picking}
                onClick={() => void onChooseFolder("path")}
                className="mb-2.5 w-full justify-center gap-1.5"
              >
                {picking ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <FolderOpen className="size-3.5" />
                )}
                {picking ? "Waiting for folder…" : "Choose Folder…"}
              </Button>
            )}

            {canSearch && (
              <div className="mb-2.5">
                <label className="mb-1 block text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                  Find a project
                </label>
                <div className="relative">
                  <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
                  <input
                    ref={searchInputRef}
                    value={query}
                    spellCheck={false}
                    disabled={submitting}
                    placeholder="e.g. budg, chunky-site"
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={onSearchKeyDown}
                    aria-controls={listboxId}
                    aria-autocomplete="list"
                    aria-activedescendant={
                      activeHit >= 0 ? `${listboxId}-opt-${activeHit}` : undefined
                    }
                    className="h-9 w-full rounded-lg border border-border bg-background py-0 pr-2.5 pl-8 text-[12px] text-foreground outline-none transition-colors placeholder:text-muted-foreground/70 focus-visible:border-ring/50 focus-visible:ring-2 focus-visible:ring-ring/25"
                  />
                </div>

                {(query.trim() || searching || searchError) && (
                  <div
                    id={listboxId}
                    role="listbox"
                    aria-label="Matching folders"
                    className="mt-1.5 max-h-40 overflow-y-auto rounded-lg border border-border/80 bg-background/60"
                  >
                    {searching && hits.length === 0 && (
                      <div className="flex items-center gap-2 px-2.5 py-2 text-[11px] text-muted-foreground">
                        <Loader2 className="size-3 animate-spin" />
                        Searching…
                      </div>
                    )}
                    {!searching && searchError && (
                      <div className="px-2.5 py-2 text-[11px] text-destructive">
                        {searchError}
                      </div>
                    )}
                    {!searching && !searchError && query.trim() && hits.length === 0 && (
                      <div className="px-2.5 py-2 text-[11px] text-muted-foreground">
                        No folders matched. Try another name or paste a path below.
                      </div>
                    )}
                    {hits.map((hit, i) => {
                      const active = i === activeHit
                      return (
                        <button
                          key={hit.path}
                          id={`${listboxId}-opt-${i}`}
                          type="button"
                          role="option"
                          aria-selected={active}
                          disabled={submitting}
                          onMouseEnter={() => setActiveHit(i)}
                          onClick={() => fillFromHit(hit)}
                          onDoubleClick={() => void submitAdd(hit.path)}
                          className={cn(
                            "flex w-full cursor-pointer flex-col gap-0.5 px-2.5 py-1.5 text-left outline-none transition-colors",
                            active ? "bg-accent text-accent-foreground" : "hover:bg-accent/60",
                          )}
                        >
                          <span className="truncate text-[12px] font-medium">{hit.name}</span>
                          <span
                            className={cn(
                              "truncate font-mono text-[10px]",
                              active ? "text-accent-foreground/70" : "text-muted-foreground",
                            )}
                            title={hit.path}
                          >
                            {compactPath(hit.path)}
                          </span>
                        </button>
                      )
                    })}
                  </div>
                )}
              </div>
            )}

            <label className="mb-1 block text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              Absolute path
            </label>
            <input
              ref={pathInputRef}
              value={path}
              spellCheck={false}
              disabled={submitting}
              placeholder="/Users/you/code/my-app"
              onChange={(e) => setPath(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault()
                  void submitAdd()
                }
              }}
              className="h-9 w-full rounded-lg border border-border bg-background px-2.5 font-mono text-[12px] text-foreground outline-none transition-colors placeholder:text-muted-foreground/70 focus-visible:border-ring/50 focus-visible:ring-2 focus-visible:ring-ring/25"
            />
            {error && (
              <div className="mt-1.5 text-[11px] text-destructive">{error}</div>
            )}
            <div className="mt-2.5 flex justify-end gap-1.5">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={submitting}
                onClick={closeAdd}
              >
                Cancel
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={submitting}
                onClick={() => void submitAdd()}
              >
                {submitting ? "Adding…" : "Add"}
              </Button>
            </div>

            {canClone && (
              <div className="mt-3 border-border/70 border-t pt-2.5">
                <div className="mb-1 flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                  <CloudDownload className="size-3" />
                  Clone from a URL
                </div>
                <p className="mb-2 text-[11px] text-muted-foreground">
                  An agent clones it into the destination folder — you can watch it work — then
                  Chunky adds the result here.
                </p>

                <input
                  ref={cloneUrlRef}
                  value={cloneUrl}
                  spellCheck={false}
                  disabled={cloning || cloneStarting || directCloning}
                  placeholder="https://github.com/owner/repo"
                  aria-label="Repository URL"
                  onChange={(e) => {
                    setCloneUrl(e.target.value)
                    setCloneError(null)
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault()
                      void submitClone()
                    }
                  }}
                  className="h-9 w-full rounded-lg border border-border bg-background px-2.5 font-mono text-[12px] text-foreground outline-none transition-colors placeholder:text-muted-foreground/70 focus-visible:border-ring/50 focus-visible:ring-2 focus-visible:ring-ring/25"
                />

                <div className="mt-1.5 flex items-center gap-1.5">
                  <input
                    value={cloneDest}
                    spellCheck={false}
                    disabled={cloning || cloneStarting || directCloning}
                    placeholder="/Users/you/code"
                    aria-label="Destination folder"
                    onChange={(e) => {
                      setCloneDest(e.target.value)
                      setCloneError(null)
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault()
                        void submitClone()
                      }
                    }}
                    className="h-9 min-w-0 flex-1 rounded-lg border border-border bg-background px-2.5 font-mono text-[11px] text-foreground outline-none transition-colors placeholder:text-muted-foreground/70 focus-visible:border-ring/50 focus-visible:ring-2 focus-visible:ring-ring/25"
                  />
                  {canNative && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      title="Choose destination folder"
                      aria-label="Choose destination folder"
                      disabled={picking || cloning || cloneStarting || directCloning}
                      onClick={() => void onChooseFolder("clone")}
                    >
                      {picking ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : (
                        <FolderOpen className="size-3.5" />
                      )}
                    </Button>
                  )}
                </div>

                {cloneStatus && (
                  <div className="mt-2 rounded-lg border border-border bg-muted/40 px-2.5 py-1.5">
                    <div className="flex items-center gap-1.5 text-[11px] font-medium text-foreground">
                      {cloning ? (
                        <Loader2 className="size-3 animate-spin text-primary" />
                      ) : (
                        <X className="size-3 text-destructive" />
                      )}
                      {cloneStatus.phase === "registering"
                        ? "Registering the clone…"
                        : cloneStatus.phase === "error"
                          ? "The clone didn't finish"
                          : "Agent is cloning…"}
                    </div>
                    {cloneStatus.lines.length > 0 && (
                      <div
                        ref={cloneLogRef}
                        className="mt-1 max-h-24 overflow-y-auto font-mono text-[10.5px] leading-snug text-muted-foreground"
                      >
                        {cloneStatus.lines.map((line, i) => (
                          <div key={`${i}-${line}`} className="truncate" title={line}>
                            {line}
                          </div>
                        ))}
                      </div>
                    )}
                    {cloneStatus.agentMessage && cloneStatus.phase === "error" && (
                      <div className="mt-1.5 max-h-20 overflow-y-auto whitespace-pre-wrap text-[10.5px] text-muted-foreground">
                        {cloneStatus.agentMessage}
                      </div>
                    )}
                  </div>
                )}

                {cloneError && <div className="mt-1.5 text-[11px] text-destructive">{cloneError}</div>}

                <div className="mt-2 flex flex-wrap items-center justify-end gap-1.5">
                  {cloneStatus?.sessionId && onViewCloneThread && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="gap-1.5"
                      onClick={() => {
                        onViewCloneThread(cloneStatus.sessionId!)
                        setAdding(false)
                      }}
                    >
                      <Eye className="size-3.5" />
                      View thread
                    </Button>
                  )}
                  {cloning && onCancelClone && (
                    <Button type="button" variant="ghost" size="sm" onClick={onCancelClone}>
                      Stop
                    </Button>
                  )}
                  {!cloning && cloneStatus?.phase === "error" && canDirectClone && (
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      disabled={directCloning}
                      onClick={() => void cloneDirectly()}
                    >
                      {directCloning ? "Cloning…" : "Clone without an agent"}
                    </Button>
                  )}
                  <Button
                    type="button"
                    size="sm"
                    disabled={cloning || cloneStarting || directCloning || !cloneUrl.trim()}
                    onClick={() => void submitClone()}
                  >
                    {cloning ? "Cloning…" : cloneStatus?.phase === "error" ? "Try again" : "Clone & add"}
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

/** Compact home-relative display for long absolute paths. */
function compactPath(abs: string): string {
  // Avoid importing node:os in the browser bundle — string replace is enough.
  const home =
    typeof window !== "undefined"
      ? // best-effort: paths like /Users/name/...
        abs.match(/^(\/Users\/[^/]+)/)?.[1] ??
        abs.match(/^(\/home\/[^/]+)/)?.[1] ??
        ""
      : ""
  if (home && abs.startsWith(home)) return `~${abs.slice(home.length)}`
  return abs
}
