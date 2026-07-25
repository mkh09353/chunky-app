import { Check, GitBranch, Loader2, PenSquare, Search, Settings } from "lucide-react"
import { useMemo, useState } from "react"
import type { Project, Thread, ThreadStatus } from "~/lib/mock"
import { cn } from "~/lib/cn"
import { Kbd } from "./ui/kbd"
import { ScrollArea } from "./ui/scroll-area"
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip"

function StatusPill({ status }: { status: ThreadStatus }) {
  if (status.kind === "done") {
    return (
      <span className="flex items-center gap-1 font-medium text-[10.5px] text-success">
        <Check className="size-3" />
        Done
      </span>
    )
  }
  if (status.kind === "working") {
    return (
      <span className="flex items-center gap-1 font-medium text-[10.5px] text-primary">
        <Loader2 className="size-3 animate-spin" />
        Working {status.label}
      </span>
    )
  }
  return <span className="text-[10.5px] text-muted-foreground/60 tabular-nums">{status.ago}</span>
}

function RepoMark({ mark }: { mark: string }) {
  return (
    <span className="flex size-3.5 shrink-0 items-center justify-center rounded bg-gradient-to-br from-primary to-[oklch(0.58_0.2_320)] font-bold text-[8px] text-white">
      {mark}
    </span>
  )
}

function ThreadRow({
  thread,
  project,
  active,
  onSelect,
  onRename,
}: {
  thread: Thread
  project: Project | undefined
  active: boolean
  onSelect: () => void
  onRename?: () => void
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      onDoubleClick={() => onRename?.()}
      className={cn(
        "group relative flex w-full cursor-pointer flex-col gap-1 rounded-lg px-2.5 py-2 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/40",
        active ? "bg-sidebar-accent shadow-xs" : "hover:bg-sidebar-accent/50",
      )}
    >
      {active && (
        <span className="-translate-y-1/2 absolute top-1/2 left-0 h-6 w-[3px] rounded-r-full bg-primary" />
      )}
      <div className="flex items-center gap-1.5">
        <RepoMark mark={project?.mark ?? "?"} />
        <span className="min-w-0 truncate text-[11px] text-muted-foreground/80">
          {project ? `${project.owner}/${project.name}` : "unknown"}
        </span>
        <span className="ml-auto flex shrink-0 items-center">
          <StatusPill status={thread.status} />
        </span>
      </div>
      <span
        className={cn(
          "truncate text-[13px] leading-tight",
          active ? "font-medium text-foreground" : "text-foreground/85",
        )}
      >
        {thread.title}
      </span>
      <div className="flex items-center gap-2 text-[11px] text-muted-foreground/55">
        <span className="flex min-w-0 items-center gap-1">
          <GitBranch className="size-3 shrink-0" />
          <span className="truncate">{thread.branch}</span>
        </span>
        {thread.number != null && (
          <span className="shrink-0 tabular-nums">#{thread.number}</span>
        )}
      </div>
    </button>
  )
}

export function Sidebar({
  projects,
  threads,
  activeThreadId,
  onSelectThread,
  onNewThread,
  onOpenSettings,
  onOpenPalette,
  connectionLabel,
  onRenameThread,
}: {
  projects: Project[]
  threads: Thread[]
  activeProjectId: string
  activeThreadId: string
  onSelectThread: (id: string) => void
  onNewThread: () => void
  onOpenSettings: () => void
  onOpenPalette: () => void
  /** Optional live/demo connection badge in the footer. */
  connectionLabel?: string
  onRenameThread?: (id: string) => void
}) {
  const [query, setQuery] = useState("")
  const projectOf = useMemo(
    () => new Map(projects.map((p) => [p.id, p])),
    [projects],
  )

  const { active, settled } = useMemo(() => {
    const q = query.trim().toLowerCase()
    const match = (t: Thread) => {
      if (!q) return true
      const p = projectOf.get(t.projectId)
      return (
        t.title.toLowerCase().includes(q) ||
        t.branch.toLowerCase().includes(q) ||
        (p ? `${p.owner}/${p.name}`.toLowerCase().includes(q) : false)
      )
    }
    const list = threads.filter(match)
    return {
      active: list.filter((t) => t.status.kind !== "done"),
      settled: list.filter((t) => t.status.kind === "done"),
    }
  }, [threads, query, projectOf])

  return (
    <aside className="relative flex h-full w-72 shrink-0 flex-col overflow-hidden bg-transparent text-sidebar-foreground">
      {/* Starfield nebula behind the header */}
      <div className="sidebar-starfield pointer-events-none absolute inset-x-0 top-0 h-40" />

      {/* Brand / drag region */}
      <div className="app-drag relative z-10 flex h-[52px] items-center gap-2.5 pr-3 pl-[78px]">
        <div className="flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-[10px] border border-primary/20 bg-primary/10 shadow-xs shadow-primary/20">
          <img
            src="/chunky-mark.svg"
            alt=""
            aria-hidden="true"
            draggable={false}
            className="size-[30px] select-none object-contain drop-shadow-[0_2px_5px_color-mix(in_oklch,var(--primary)_28%,transparent)]"
          />
        </div>
        <span className="font-semibold text-[15px] tracking-tight">Chunky</span>
        <span className="rounded-full bg-primary/15 px-1.5 py-0.5 font-medium text-[10px] text-primary">
          beta
        </span>
      </div>

      {/* Search + compose */}
      <div className="relative z-10 flex items-center gap-2 px-3 pt-1 pb-3">
        <div className="relative flex-1">
          <Search className="-translate-y-1/2 pointer-events-none absolute top-1/2 left-2.5 size-3.5 text-muted-foreground" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search"
            className="no-drag h-9 w-full rounded-lg border border-border bg-background/50 pr-12 pl-8 text-[13px] text-foreground outline-none transition-colors placeholder:text-muted-foreground/70 hover:border-ring/30 focus-visible:border-ring/50 focus-visible:ring-2 focus-visible:ring-ring/25"
          />
          <button
            type="button"
            onClick={onOpenPalette}
            aria-label="Open command palette"
            className="no-drag -translate-y-1/2 absolute top-1/2 right-2 cursor-pointer outline-none"
          >
            <Kbd className="bg-transparent transition-colors hover:border-ring/40 hover:text-foreground">⌘K</Kbd>
          </button>
        </div>
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                onClick={onNewThread}
                className="no-drag flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-lg border border-border bg-background/50 text-muted-foreground outline-none transition-colors hover:border-ring/40 hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
              />
            }
          >
            <PenSquare className="size-4" />
          </TooltipTrigger>
          <TooltipPopup>New thread · ⌘N</TooltipPopup>
        </Tooltip>
      </div>

      <ScrollArea className="flex-1" viewportClassName="px-2 pb-3">
        <div className="flex flex-col gap-0.5">
          {active.map((t) => (
            <ThreadRow
              key={t.id}
              thread={t}
              project={projectOf.get(t.projectId)}
              active={t.id === activeThreadId}
              onSelect={() => onSelectThread(t.id)}
              onRename={() => onRenameThread?.(t.id)}
            />
          ))}
        </div>

        {settled.length > 0 && (
          <>
            <div className="flex items-center gap-2 px-2.5 pt-4 pb-1.5">
              <span className="font-medium text-[10.5px] text-muted-foreground/60 uppercase tracking-[0.08em]">
                Settled
              </span>
              <span className="h-px flex-1 bg-border/60" />
              <span className="text-[10.5px] text-muted-foreground/40 tabular-nums">
                {settled.length}
              </span>
            </div>
            <div className="flex flex-col gap-0.5">
              {settled.map((t) => (
                <ThreadRow
                  key={t.id}
                  thread={t}
                  project={projectOf.get(t.projectId)}
                  active={t.id === activeThreadId}
                  onSelect={() => onSelectThread(t.id)}
                  onRename={() => onRenameThread?.(t.id)}
                />
              ))}
            </div>
          </>
        )}

        {active.length === 0 && settled.length === 0 && (
          <p className="px-3 py-8 text-center text-[12px] text-muted-foreground/60">
            {query.trim()
              ? `No threads match “${query}”.`
              : threads.length === 0
                ? "No sessions yet — start a new thread."
                : "No threads match."}
          </p>
        )}
      </ScrollArea>

      {/* Footer */}
      <div className="relative z-10 flex items-center gap-2 border-border/70 border-t px-3 py-2.5">
        <div className="flex size-8 items-center justify-center rounded-full bg-gradient-to-br from-primary to-[oklch(0.6_0.2_320)] font-semibold text-[13px] text-white">
          M
        </div>
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate font-medium text-[13px]">Max Headley</span>
          <span className="truncate text-[11px] text-muted-foreground">
            {connectionLabel ? (
              <span
                className={cn(
                  connectionLabel === "Live" && "text-success",
                  (connectionLabel === "Offline" || connectionLabel === "Demo") &&
                    "text-amber-600 dark:text-amber-400",
                )}
              >
                {connectionLabel}
              </span>
            ) : (
              "Pro plan"
            )}
          </span>
        </div>
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                onClick={onOpenSettings}
                className="inline-flex size-7 cursor-pointer items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
              />
            }
          >
            <Settings className="size-4" />
          </TooltipTrigger>
          <TooltipPopup>Settings</TooltipPopup>
        </Tooltip>
      </div>
    </aside>
  )
}
