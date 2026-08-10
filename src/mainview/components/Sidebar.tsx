import {
  Archive,
  ArchiveRestore,
  BarChart3,
  ChevronDown,
  GitBranch,
  History,
  House,
  Inbox,
  Mail,
  MailOpen,
  PawPrint,
  PenSquare,
  Search,
  Settings,
} from "lucide-react"
import {
  useCallback,
  useMemo,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react"
import type { Project, Thread, ThreadStatus } from "~/lib/mock"
import { useArchivedSessions } from "~/lib/archivedSessions"
import { avatarInitial, resolveDisplayName } from "~/lib/identity"
import { collapseList } from "~/lib/sessionList"
import { groupByWorktree } from "~/lib/sessionGroups"
import { cn } from "~/lib/cn"
import { DRAG_REGION, NO_DRAG_REGION } from "~/lib/dragRegion"
import { Kbd } from "./ui/kbd"
import { ScrollArea } from "./ui/scroll-area"
import { StatusGlyph, type StatusGlyphState } from "./ui/status-indicator"
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
} from "./ui/dropdown-menu"

/** The row's whole status, in one glyph.
 *
 *  A session with work in flight — its own turn OR any delegate (sidekick,
 *  spawned subagent, workflow leg) — spins; a finished one the reader hasn't
 *  looked at yet keeps a solid dot until they select it (the unread rule lives
 *  in App: set on running→idle while unselected or manually from this row's
 *  context menu, then acknowledged by clicking the row — this only paints it).
 *  Everything settled and seen shows nothing at all, which is what lets a long
 *  list read as titles instead of badges.
 *
 *  The slot is always rendered, at the same size in every state, so titles stay
 *  aligned down the column (see components/ui/status-indicator). */
function StatusDot({ status }: { status: ThreadStatus }) {
  const state: StatusGlyphState =
    status.kind === "working" ? "working" : status.kind === "done" && status.unread ? "unread" : "idle"
  return <StatusGlyph state={state} />
}

/** Header for one worktree/branch group in the working list.
 *
 *  Metrics deliberately match the "Settled" divider below (same 10.5px label,
 *  same hairline, same trailing count) so the list keeps one rhythm. Two
 *  differences are deliberate: a branch icon, because this names a checkout
 *  rather than a lifecycle section, and NO uppercasing — branch names are
 *  case-sensitive identifiers, and `CHUNKY/FIX-ABC` is not the branch the user
 *  has checked out. */
function GroupDivider({
  label,
  linked,
  count,
  first = false,
}: { label: string; linked: boolean; count: number; first?: boolean }) {
  return (
    // The first header sits directly under the search field, which already
    // supplies the gap — a second full stride there just pushes the list down.
    <div className={cn("flex items-center gap-2 px-2.5 pb-1.5", first ? "pt-0.5" : "pt-4")}>
      <GitBranch
        className={cn("size-3 shrink-0", linked ? "text-primary/70" : "text-muted-foreground/50")}
        aria-hidden="true"
      />
      <span
        title={linked ? `${label} (linked worktree)` : label}
        className={cn(
          "min-w-0 max-w-[60%] truncate font-medium font-mono text-[10.5px] tracking-tight",
          linked ? "text-primary/80" : "text-muted-foreground/70",
        )}
      >
        {label}
      </span>
      <span className="h-px flex-1 bg-border/60" />
      <span className="text-[10.5px] text-muted-foreground/40 tabular-nums">{count}</span>
    </div>
  )
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
  onUnreadChange,
  unreadMarked,
  onToggleArchive,
  archived = false,
  onSettledChange,
  settled = false,
  showProject = false,
}: {
  thread: Thread
  project: Project | undefined
  active: boolean
  onSelect: () => void
  onRename?: () => void
  onUnreadChange?: (unread: boolean) => void
  /** Source-of-truth marker, including an active settled thread presented as idle. */
  unreadMarked?: boolean
  /** Local-only archive toggle; omitted → no archive affordance on the row. */
  onToggleArchive?: () => void
  archived?: boolean
  /** Shelf toggle (settle / move back to the working list); omitted → no action. */
  onSettledChange?: (settled: boolean) => void
  /** This row is on the history shelf: it renders slimmer and recedes. */
  settled?: boolean
  /** Only when the list can span repos: name the one this row belongs to. */
  showProject?: boolean
}) {
  const unread = unreadMarked ?? (thread.status.kind === "done" && thread.status.unread === true)
  // A running thread has no shelf actions and no read state to set: it is busy,
  // and the lifecycle rules would hand it straight back anyway.
  const canMarkUnread = thread.status.kind !== "working"
  const canChangeShelf = thread.status.kind !== "working"
  const dotStatus: ThreadStatus = unread ? { kind: "done", unread: true } : thread.status
  const [menuPoint, setMenuPoint] = useState<{ x: number; y: number } | null>(null)
  const menuX = menuPoint?.x ?? 0
  const menuY = menuPoint?.y ?? 0
  const menuAnchor = useMemo(
    () => ({
      getBoundingClientRect: () => DOMRect.fromRect({ x: menuX, y: menuY, width: 0, height: 0 }),
    }),
    [menuX, menuY],
  )
  const showUnreadItem = !!onUnreadChange && canMarkUnread
  const showShelfItem = !!onSettledChange && canChangeShelf
  const hasMenu = showUnreadItem || showShelfItem
  const openMenu = useCallback(
    (event: ReactMouseEvent) => {
      if (!hasMenu) return
      event.preventDefault()
      event.stopPropagation()
      setMenuPoint({ x: event.clientX, y: event.clientY })
    },
    [hasMenu],
  )

  return (
    <div className="group relative" onContextMenu={openMenu}>
      <button
        type="button"
        onClick={onSelect}
        onDoubleClick={() => onRename?.()}
        className={cn(
          "relative flex w-full cursor-pointer flex-col gap-0.5 rounded-lg px-2.5 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/40",
          // History is read at a glance, so it gives back a little height and
          // contrast. The working list stays at full presentation.
          settled ? "py-1" : "py-1.5",
          active ? "bg-sidebar-accent shadow-xs" : "hover:bg-sidebar-accent/50",
        )}
      >
        {active && (
          <span className="-translate-y-1/2 absolute top-1/2 left-0 h-6 w-[3px] rounded-r-full bg-primary" />
        )}
        {/* One line: what it is, and when it last moved. The repo it belongs to
            is the tab overhead, and "Done" is the absence of a dot. */}
        <div className="flex w-full items-center gap-2">
          <StatusDot status={dotStatus} />
          <span
            className={cn(
              "min-w-0 flex-1 truncate leading-tight",
              settled ? "text-[12.5px]" : "text-[13px]",
              active
                ? "font-medium text-foreground"
                : settled
                  ? "text-foreground/65"
                  : "text-foreground/85",
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
          <span className="flex min-w-0 items-center gap-1.5 ps-5 text-[11px] text-muted-foreground/60">
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
                className={cn(
                  "-translate-y-1/2 pointer-events-none absolute right-1.5 inline-flex size-6 cursor-pointer items-center justify-center rounded-md text-muted-foreground opacity-0 outline-none transition-opacity hover:bg-accent hover:text-foreground focus-visible:pointer-events-auto focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring/40 group-hover:pointer-events-auto group-hover:opacity-100",
                  settled ? "top-[13px]" : "top-[15px]",
                )}
              />
            }
          >
            {archived ? <ArchiveRestore className="size-3.5" /> : <Archive className="size-3.5" />}
          </TooltipTrigger>
          <TooltipPopup>{archived ? "Unarchive" : "Archive (this device only)"}</TooltipPopup>
        </Tooltip>
      )}
      {menuPoint && hasMenu && (
        <DropdownMenu
          open
          modal={false}
          onOpenChange={(open) => {
            if (!open) setMenuPoint(null)
          }}
        >
          <DropdownMenuContent
            anchor={menuAnchor}
            side="bottom"
            align="start"
            sideOffset={2}
            className="min-w-44"
          >
            {showUnreadItem && (
              <DropdownMenuItem
                onClick={() => {
                  onUnreadChange?.(!unread)
                  setMenuPoint(null)
                }}
              >
                {unread ? <MailOpen /> : <Mail />}
                {unread ? "Mark as read" : "Mark as unread"}
              </DropdownMenuItem>
            )}
            {showShelfItem && (
              <DropdownMenuItem
                onClick={() => {
                  onSettledChange?.(!settled)
                  setMenuPoint(null)
                }}
              >
                {settled ? <Inbox /> : <History />}
                {settled ? "Move to active" : "Settle thread"}
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
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
  onOpenHome,
  homeActive = false,
  onOpenZoo,
  zooActive = false,
  onOpenUsage,
  usageActive = false,
  onOpenSettings,
  onOpenPalette,
  connectionLabel,
  displayName,
  onRenameThread,
  onThreadUnreadChange,
  unreadThreadIds,
  settledThreadIds,
  onThreadSettledChange,
  prWidget,
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
  /** Swap the main panel for the cross-repository Home feed. Omitted → the
   *  button is not offered (demo/offline shells that have no feed to show). */
  onOpenHome?: () => void
  /** Home currently owns the main panel: the button reads as engaged, and the
   *  thread list below is still this repo's — nothing in it is selected. */
  homeActive?: boolean
  /** Open the canonical full-page product-factory workspace. */
  onOpenZoo?: () => void
  /** The Zoo currently owns the main panel. */
  zooActive?: boolean
  /** Swap the main panel for the full-page Usage view. Same live-only rule as
   *  Home: without a server there is no spend history to show. */
  onOpenUsage?: () => void
  /** Usage currently owns the main panel (mirrors `homeActive`). */
  usageActive?: boolean
  onOpenSettings: () => void
  onOpenPalette: () => void
  /** Optional live/demo connection badge in the footer. */
  connectionLabel?: string
  /** The user's git display name, resolved by App. Absent/empty → "Chunky".
   *  This row never fetches it itself. */
  displayName?: string
  onRenameThread?: (id: string) => void
  /** Manual revisit marker. Right-click/two-finger-click any non-running row. */
  onThreadUnreadChange?: (id: string, unread: boolean) => void
  /** Canonical markers can outlive the row's presentation status (active settled/idle). */
  unreadThreadIds?: Set<string>
  /** Threads on the history shelf, decided by the lifecycle classifier rather
   *  than by presentation status. Absent (demo) → fall back to "done". */
  settledThreadIds?: Set<string>
  /** File a thread into history, or pull it back into the working list. */
  onThreadSettledChange?: (id: string, settled: boolean) => void
  /** Pinned above the footer, outside the scroll area (the PR reviews widget). */
  prWidget?: ReactNode
}) {
  const [query, setQuery] = useState("")
  const [archivedOpen, setArchivedOpen] = useState(false)
  const [settledExpanded, setSettledExpanded] = useState(false)
  const { archived: archivedIds, toggle: toggleArchived } = useArchivedSessions()
  const projectOf = useMemo(
    () => new Map(projects.map((p) => [p.id, p])),
    [projects],
  )

  // Two different things, deliberately kept apart: SETTLED recedes into the
  // history shelf but is still listed, ARCHIVED disappears from the sidebar
  // until its section is opened. Archiving is a local view filter that composes
  // with search: the archived section shows only archived threads that also
  // match the query.
  //
  // Shelf membership comes from the lifecycle classifier (App), never from the
  // row's presentation status — a finished-but-unread run is presented as done
  // and still belongs in the working list. Demo mode has no classifier, so it
  // keeps the old status-shaped split.
  const isSettled = useCallback(
    (t: Thread) =>
      settledThreadIds ? settledThreadIds.has(t.id) : t.status.kind === "done",
    [settledThreadIds],
  )

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
      active: visible.filter((t) => !isSettled(t)),
      settled: visible.filter((t) => isSettled(t)),
      archived: list.filter((t) => archivedIds.has(t.id)),
    }
  }, [threads, query, projectOf, archivedIds, isSettled])

  // Old settled threads are history, not a working list: show a screenful and
  // let the reader ask for the rest. Selection order stays the server's.
  const { visible: settledVisible, hidden: settledHidden } = useMemo(
    () => collapseList(settled, settledExpanded),
    [settled, settledExpanded],
  )

  // Second grouping level, and ONLY when the repo has earned it: null means the
  // working list renders exactly as it did before worktrees existed (see
  // lib/sessionGroups). Deliberately computed from `active`, i.e. AFTER the
  // search filter, so narrowing into one branch drops the headers again.
  // History and Archive stay flat: they are read at a glance, and a second axis
  // there is noise.
  const activeGroups = useMemo(() => groupByWorktree(active), [active])

  // One definition of a working-list row, shared by the flat and grouped paths
  // so the two can never drift apart.
  const renderThread = useCallback(
    (t: Thread) => (
      <ThreadRow
        key={t.id}
        thread={t}
        project={projectOf.get(t.projectId)}
        active={t.id === activeThreadId}
        onSelect={() => onSelectThread(t.id)}
        onRename={() => onRenameThread?.(t.id)}
        onUnreadChange={onThreadUnreadChange ? (unread) => onThreadUnreadChange(t.id, unread) : undefined}
        unreadMarked={unreadThreadIds?.has(t.id)}
        onToggleArchive={() => toggleArchived(t.id)}
        onSettledChange={
          onThreadSettledChange ? (next) => onThreadSettledChange(t.id, next) : undefined
        }
        showProject={showProjects}
      />
    ),
    [
      projectOf,
      activeThreadId,
      onSelectThread,
      onRenameThread,
      onThreadUnreadChange,
      unreadThreadIds,
      toggleArchived,
      onThreadSettledChange,
      showProjects,
    ],
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
        <div className="ml-auto flex items-center gap-0.5">
          {onOpenHome && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    onClick={onOpenHome}
                    aria-pressed={homeActive}
                    aria-label="Home"
                    className={cn(
                      NO_DRAG_REGION,
                      "flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/40",
                      homeActive
                        ? "bg-primary/10 text-primary"
                        : "text-muted-foreground hover:bg-accent hover:text-foreground",
                    )}
                  />
                }
              >
                <House className="size-4" />
              </TooltipTrigger>
              <TooltipPopup>Home · ⌘0</TooltipPopup>
            </Tooltip>
          )}
          {onOpenZoo && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    onClick={onOpenZoo}
                    aria-pressed={zooActive}
                    aria-label="The Zoo"
                    className={cn(
                      NO_DRAG_REGION,
                      "flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/40",
                      zooActive
                        ? "bg-primary/10 text-primary"
                        : "text-muted-foreground hover:bg-accent hover:text-foreground",
                    )}
                  />
                }
              >
                <PawPrint className="size-4" />
              </TooltipTrigger>
              <TooltipPopup>The Zoo</TooltipPopup>
            </Tooltip>
          )}
          {onOpenUsage && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    onClick={onOpenUsage}
                    aria-pressed={usageActive}
                    aria-label="Usage"
                    className={cn(
                      NO_DRAG_REGION,
                      "flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/40",
                      usageActive
                        ? "bg-primary/10 text-primary"
                        : "text-muted-foreground hover:bg-accent hover:text-foreground",
                    )}
                  />
                }
              >
                <BarChart3 className="size-4" />
              </TooltipTrigger>
              <TooltipPopup>Usage</TooltipPopup>
            </Tooltip>
          )}
        </div>
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
        {activeGroups ? (
          activeGroups.map((group, index) => (
            <div key={group.key}>
              <GroupDivider
                label={group.label}
                linked={group.linked}
                count={group.rows.length}
                first={index === 0}
              />
              <div className="flex flex-col gap-0.5">{group.rows.map(renderThread)}</div>
            </div>
          ))
        ) : (
          <div className="flex flex-col gap-0.5">{active.map(renderThread)}</div>
        )}

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
                  onUnreadChange={onThreadUnreadChange ? (unread) => onThreadUnreadChange(t.id, unread) : undefined}
                  unreadMarked={unreadThreadIds?.has(t.id)}
                  onToggleArchive={() => toggleArchived(t.id)}
                  onSettledChange={
                    onThreadSettledChange ? (next) => onThreadSettledChange(t.id, next) : undefined
                  }
                  settled
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
                    onUnreadChange={onThreadUnreadChange ? (unread) => onThreadUnreadChange(t.id, unread) : undefined}
                    unreadMarked={unreadThreadIds?.has(t.id)}
                    onToggleArchive={() => toggleArchived(t.id)}
                    onSettledChange={
                      onThreadSettledChange ? (next) => onThreadSettledChange(t.id, next) : undefined
                    }
                    settled={isSettled(t)}
                    archived
                  />
                ))}
              </div>
            )}
          </>
        )}
      </ScrollArea>

      {prWidget}

      {/* Footer */}
      <div className="relative z-10 flex items-center gap-2 border-border/70 border-t px-3 py-2.5">
        <div className="flex size-8 items-center justify-center rounded-full bg-gradient-to-br from-primary to-[oklch(0.6_0.2_320)] font-semibold text-[13px] text-white">
          {avatarInitial(displayName)}
        </div>
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate font-medium text-[13px]">
            {resolveDisplayName(displayName)}
          </span>
          {/* Only a real status line here — with no connection to report the row
              is just the name, never an invented plan or tier. */}
          {connectionLabel && (
            <span className="truncate text-[11px] text-muted-foreground">
              <span
                className={cn(
                  connectionLabel === "Live" && "text-success",
                  (connectionLabel === "Offline" || connectionLabel === "Demo") &&
                    "text-amber-600 dark:text-amber-400",
                )}
              >
                {connectionLabel}
              </span>
            </span>
          )}
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
