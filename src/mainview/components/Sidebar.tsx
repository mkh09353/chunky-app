import {
  Archive,
  ArchiveRestore,
  ChevronDown,
  PenSquare,
  Search,
  Settings,
} from "lucide-react"
import { useMemo, useState } from "react"
import type { Project, Thread, ThreadStatus } from "~/lib/mock"
import { useArchivedSessions } from "~/lib/archivedSessions"
import { collapseList } from "~/lib/sessionList"
import { cn } from "~/lib/cn"
import { DRAG_REGION } from "~/lib/dragRegion"
import { Kbd } from "./ui/kbd"
import { ScrollArea } from "./ui/scroll-area"
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip"

/** The row's whole status, in six pixels.
 *
 *  A running session pulses; a finished one the reader hasn't looked at yet
 *  keeps a solid dot until they select it (the unread rule lives in App: set on
 *  running→idle while unselected, cleared on select — this only paints it).
 *  Everything settled and seen shows nothing at all, which is what lets a long
 *  list read as titles instead of badges.
 *
 *  The slot is always rendered so titles stay aligned down the column. */
function StatusDot({ status }: { status: ThreadStatus }) {
  const dot =
    status.kind === "working" ? (
      <span className="size-1.5 animate-pulse rounded-full bg-primary" aria-label="Working" />
    ) : status.kind === "done" && status.unread ? (
      <span className="size-1.5 rounded-full bg-primary" aria-label="Unread" />
    ) : null
  return <span className="flex size-1.5 shrink-0 items-center justify-center">{dot}</span>
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
  onToggleArchive,
  archived = false,
  showProject = false,
}: {
  thread: Thread
  project: Project | undefined
  active: boolean
  onSelect: () => void
  onRename?: () => void
  /** Local-only archive toggle; omitted → no archive affordance on the row. */
  onToggleArchive?: () => void
  archived?: boolean
  /** Only when the list can span repos: name the one this row belongs to. */
  showProject?: boolean
}) {
  return (
    <div className="group relative">
    <button
      type="button"
      onClick={onSelect}
      onDoubleClick={() => onRename?.()}
      className={cn(
        "relative flex w-full cursor-pointer flex-col gap-0.5 rounded-lg px-2.5 py-1.5 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/40",
        active ? "bg-sidebar-accent shadow-xs" : "hover:bg-sidebar-accent/50",
      )}
    >
      {active && (
        <span className="-translate-y-1/2 absolute top-1/2 left-0 h-6 w-[3px] rounded-r-full bg-primary" />
      )}
      {/* One line: what it is, and when it last moved. The repo it belongs to
          is the tab overhead, and "Done" is the absence of a dot. */}
      <div className="flex w-full items-center gap-2">
        <StatusDot status={thread.status} />
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-[13px] leading-tight",
            active ? "font-medium text-foreground" : "text-foreground/85",
          )}
        >
          {thread.title}
        </span>
        <span
          className={cn(
            "shrink-0 text-[10.5px] text-muted-foreground/55 tabular-nums transition-opacity",
            onToggleArchive && "group-hover:opacity-0",
          )}
        >
          {thread.updated}
        </span>
      </div>
      {showProject && (
        <span className="flex min-w-0 items-center gap-1.5 ps-[14px] text-[11px] text-muted-foreground/60">
          <RepoMark mark={project?.mark ?? "?"} />
          <span className="min-w-0 truncate">
            {project ? `${project.owner}/${project.name}` : "unknown"}
          </span>
        </span>
      )}
    </button>
    {onToggleArchive && (
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-label={archived ? `Unarchive ${thread.title}` : `Archive ${thread.title}`}
              onClick={(event) => {
                event.stopPropagation()
                onToggleArchive()
              }}
              // Takes the timestamp's place on hover, so the row never grows.
              className="-translate-y-1/2 pointer-events-none absolute top-[15px] right-1.5 inline-flex size-6 cursor-pointer items-center justify-center rounded-md text-muted-foreground opacity-0 outline-none transition-opacity hover:bg-accent hover:text-foreground focus-visible:pointer-events-auto focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring/40 group-hover:pointer-events-auto group-hover:opacity-100"
            />
          }
        >
          {archived ? <ArchiveRestore className="size-3.5" /> : <Archive className="size-3.5" />}
        </TooltipTrigger>
        <TooltipPopup>{archived ? "Unarchive" : "Archive (this device only)"}</TooltipPopup>
      </Tooltip>
    )}
    </div>
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
  showProjects = false,
}: {
  projects: Project[]
  threads: Thread[]
  activeProjectId: string
  activeThreadId: string
  /** True only where the list can span repos (demo). Live sessions are fetched
   *  per repo, so naming the repo on every row would just repeat the tab. */
  showProjects?: boolean
  onSelectThread: (id: string) => void
  onNewThread: () => void
  onOpenSettings: () => void
  onOpenPalette: () => void
  /** Optional live/demo connection badge in the footer. */
  connectionLabel?: string
  onRenameThread?: (id: string) => void
}) {
  const [query, setQuery] = useState("")
  const [archivedOpen, setArchivedOpen] = useState(false)
  const [settledExpanded, setSettledExpanded] = useState(false)
  const { archived: archivedIds, toggle: toggleArchived } = useArchivedSessions()
  const projectOf = useMemo(
    () => new Map(projects.map((p) => [p.id, p])),
    [projects],
  )

  // Archiving is a local view filter that composes with search: the archived
  // section shows only archived threads that also match the query.
  const { active, settled, archived } = useMemo(() => {
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
    const visible = list.filter((t) => !archivedIds.has(t.id))
    return {
      active: visible.filter((t) => t.status.kind !== "done"),
      settled: visible.filter((t) => t.status.kind === "done"),
      archived: list.filter((t) => archivedIds.has(t.id)),
    }
  }, [threads, query, projectOf, archivedIds])

  // Old settled threads are history, not a working list: show a screenful and
  // let the reader ask for the rest. Selection order stays the server's.
  const { visible: settledVisible, hidden: settledHidden } = useMemo(
    () => collapseList(settled, settledExpanded),
    [settled, settledExpanded],
  )

  return (
    <aside className="relative flex h-full w-72 shrink-0 flex-col overflow-hidden bg-transparent text-sidebar-foreground">
      {/* Starfield nebula behind the header */}
      <div className="sidebar-starfield pointer-events-none absolute inset-x-0 top-0 h-40" />

      {/* Brand strip over the macOS traffic lights — the left half of the
          window's drag region, present in every window size and state. */}
      <div
        className={cn(
          DRAG_REGION,
          "relative z-10 flex h-[52px] items-center gap-2.5 pr-3 pl-[78px]",
        )}
      >
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
            className="h-9 w-full rounded-lg border border-border bg-background/50 pr-12 pl-8 text-[13px] text-foreground outline-none transition-colors placeholder:text-muted-foreground/70 hover:border-ring/30 focus-visible:border-ring/50 focus-visible:ring-2 focus-visible:ring-ring/25"
          />
          <button
            type="button"
            onClick={onOpenPalette}
            aria-label="Open command palette"
            className="-translate-y-1/2 absolute top-1/2 right-2 cursor-pointer outline-none"
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
                className="flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-lg border border-border bg-background/50 text-muted-foreground outline-none transition-colors hover:border-ring/40 hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
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
              onToggleArchive={() => toggleArchived(t.id)}
              showProject={showProjects}
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
              {settledVisible.map((t) => (
                <ThreadRow
                  key={t.id}
                  thread={t}
                  project={projectOf.get(t.projectId)}
                  active={t.id === activeThreadId}
                  onSelect={() => onSelectThread(t.id)}
                  onRename={() => onRenameThread?.(t.id)}
                  onToggleArchive={() => toggleArchived(t.id)}
                  showProject={showProjects}
                />
              ))}
            </div>
            {(settledHidden > 0 || settledExpanded) && (
              <button
                type="button"
                onClick={() => setSettledExpanded((open) => !open)}
                className="mt-0.5 w-full cursor-pointer rounded-md px-2.5 py-1 text-left text-[11px] text-muted-foreground/70 outline-none transition-colors hover:bg-sidebar-accent/50 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
              >
                {settledExpanded ? "Show less" : `Show ${settledHidden} more`}
              </button>
            )}
          </>
        )}

        {active.length === 0 && settled.length === 0 && (
          <p className="px-3 py-8 text-center text-[12px] text-muted-foreground/60">
            {query.trim()
              ? `No threads match “${query}”.`
              : threads.length === 0
                ? "No sessions yet — start a new thread."
                : archived.length > 0
                  ? "All threads are archived."
                  : "No threads match."}
          </p>
        )}

        {archived.length > 0 && (
          <>
            <button
              type="button"
              onClick={() => setArchivedOpen((open) => !open)}
              aria-expanded={archivedOpen}
              className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2.5 pt-4 pb-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
            >
              <ChevronDown
                className={cn(
                  "size-3 text-muted-foreground/60 transition-transform",
                  !archivedOpen && "-rotate-90",
                )}
              />
              <span className="font-medium text-[10.5px] text-muted-foreground/60 uppercase tracking-[0.08em]">
                Archived
              </span>
              <span className="h-px flex-1 bg-border/60" />
              <span className="text-[10.5px] text-muted-foreground/40 tabular-nums">
                {archived.length}
              </span>
            </button>
            {archivedOpen && (
              <div className="flex flex-col gap-0.5">
                {archived.map((t) => (
                  <ThreadRow
                    key={t.id}
                    thread={t}
                    project={projectOf.get(t.projectId)}
                    active={t.id === activeThreadId}
                    onSelect={() => onSelectThread(t.id)}
                    onRename={() => onRenameThread?.(t.id)}
                    onToggleArchive={() => toggleArchived(t.id)}
                    archived
                  />
                ))}
              </div>
            )}
          </>
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
