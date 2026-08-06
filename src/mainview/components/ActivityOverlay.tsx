// The far-left "all repos" overview.
//
// A thin hover strip pinned to the window's left edge opens a panel showing, for
// every registered repository, what is working right now and what just finished.
// Clicking a row switches to that repository's tab and attaches the session.
//
// Deliberately NOT a Base UI popover: this is a fixed edge panel, not an
// anchored menu, and Base UI's popover would take a focus trap and a dismiss
// layer with it. An ambient overview that stole focus on hover would be hostile,
// so this stays a plain region — hover to open, pointer-leave (or Escape) to
// close — and every row is a real button so Tab still reaches it.
//
// Geometry: the strip starts below the macOS traffic lights (TRAFFIC_LIGHT_INSET)
// and carries NO_DRAG_REGION, because WKWebView ignores stylesheet app-region and
// Electrobun's shim reads markup only (see lib/dragRegion.ts). Without both, a
// hover near the lights would drag the window instead of opening the panel.
import { useEffect, useMemo, useState } from "react"
import { Loader2, PanelLeftOpen } from "lucide-react"
import { cn } from "~/lib/cn"
import { NO_DRAG_REGION } from "~/lib/dragRegion"
import { relativeTime, threadLabel } from "~/lib/format"
import { HoverIntent } from "~/lib/hoverIntent"
import { activityCounts, type ActivityRow, type RepoActivity } from "~/lib/repoActivity"

/** Clear of the traffic lights, which own the top-left corner of the window. */
const TRAFFIC_LIGHT_INSET = 52

/** Hover dwell before the panel opens — long enough that crossing the edge on
 *  the way somewhere else does not flash it open. */
const OPEN_DELAY_MS = 200

/** Grace after the pointer leaves, so the gap between strip and panel (and a
 *  brief overshoot past its edge) does not close it mid-reach. */
const CLOSE_DELAY_MS = 180

/** The same six pixels the sidebar uses: pulsing = working, solid = unread. */
function ActivityDot({ row }: { row: ActivityRow }) {
  const dot = row.busy ? (
    <span className="size-1.5 animate-pulse rounded-full bg-primary" aria-label="Working" />
  ) : row.unread ? (
    <span className="size-1.5 rounded-full bg-primary" aria-label="Just finished" />
  ) : null
  return <span className="flex size-1.5 shrink-0 items-center justify-center">{dot}</span>
}

function ActivityRowButton({
  row,
  onOpen,
}: {
  row: ActivityRow
  onOpen: () => void
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        NO_DRAG_REGION,
        "flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-1 text-left outline-none transition-colors hover:bg-sidebar-accent/60 focus-visible:ring-2 focus-visible:ring-ring/40",
      )}
    >
      <ActivityDot row={row} />
      <span
        className={cn(
          "min-w-0 flex-1 truncate text-[12.5px] leading-tight",
          row.busy || row.unread ? "font-medium text-foreground" : "text-muted-foreground",
        )}
      >
        {threadLabel(row.title)}
      </span>
      <span className="shrink-0 text-[10.5px] text-muted-foreground/60 tabular-nums">
        {relativeTime(row.lastActivity)}
      </span>
    </button>
  )
}

function GroupLabel({
  children,
  count,
  active = false,
}: {
  children: React.ReactNode
  count: number
  active?: boolean
}) {
  return (
    <div className="flex items-center gap-2 px-2 pt-1.5 pb-0.5">
      <span
        className={cn(
          "font-medium text-[10.5px] uppercase tracking-[0.08em]",
          active ? "text-primary/80" : "text-muted-foreground/70",
        )}
      >
        {children}
      </span>
      <span
        className={cn(
          "text-[10.5px] tabular-nums",
          active ? "text-primary/60" : "text-muted-foreground/50",
        )}
      >
        {count}
      </span>
      <span className="h-px flex-1 bg-border/60" />
    </div>
  )
}

export interface ActivityOverlayProps {
  repos: RepoActivity[]
  /** Currently attached session — never shown as unread, marked as current. */
  activeSessionId: string | null
  activeRepoId: string | null
  onOpenSession: (sessionId: string, repoId: string) => void
  /** Hidden entirely in demo/offline mode. */
  enabled?: boolean
}

export function ActivityOverlay({
  repos,
  activeSessionId,
  activeRepoId,
  onOpenSession,
  enabled = true,
}: ActivityOverlayProps) {
  const [open, setOpen] = useState(false)
  // Dwell-to-open / grace-to-close lives in lib/hoverIntent (and is tested
  // there): re-entering either surface cancels a pending close, so crossing the
  // seam between strip and panel cannot flicker it shut.
  const intent = useMemo(
    () =>
      new HoverIntent({
        openDelayMs: OPEN_DELAY_MS,
        closeDelayMs: CLOSE_DELAY_MS,
        onChange: setOpen,
      }),
    [],
  )
  useEffect(() => () => intent.dispose(), [intent])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") intent.close()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [open, intent])

  if (!enabled) return null

  const counts = activityCounts(repos)

  return (
    <>
      {/* The edge affordance. A real button so keyboard users can Tab to it and
          open the same panel with focus; hovering is just the fast path. */}
      <button
        type="button"
        aria-label="All repositories activity"
        aria-expanded={open}
        onMouseEnter={() => intent.enter()}
        onMouseLeave={() => intent.leave()}
        onFocus={() => intent.hold()}
        onClick={() => intent.toggle()}
        className={cn(
          NO_DRAG_REGION,
          "group fixed left-0 z-50 flex w-2 cursor-pointer items-center justify-center outline-none hover:w-2.5 focus-visible:w-2.5 focus-visible:ring-2 focus-visible:ring-ring/40",
        )}
        style={{ top: TRAFFIC_LIGHT_INSET, bottom: 0 }}
      >
        {/* A hairline that only shows it is live: a pulsing tick when something
            is working, a solid one when something finished unseen. */}
        {(counts.working > 0 || counts.unread > 0) && (
          <span
            className={cn(
              "h-10 w-[3px] rounded-r-full bg-primary/70",
              counts.working > 0 && "animate-pulse",
            )}
          />
        )}
      </button>

      {open && (
        <div
          onMouseEnter={() => intent.hold()}
          onMouseLeave={() => intent.leave()}
          className={cn(
            NO_DRAG_REGION,
            "fixed left-1.5 z-50 flex w-72 flex-col overflow-hidden rounded-xl border border-border bg-popover/95 shadow-lg backdrop-blur-md",
          )}
          style={{ top: TRAFFIC_LIGHT_INSET, maxHeight: `calc(100vh - ${TRAFFIC_LIGHT_INSET + 16}px)` }}
        >
          <div className="flex items-center gap-2 border-border/60 border-b px-3 py-2">
            <PanelLeftOpen className="size-3.5 text-muted-foreground/70" />
            <span className="font-medium text-[11px] text-muted-foreground uppercase tracking-[0.08em]">
              All repositories
            </span>
            <span className="flex-1" />
            {counts.working > 0 && (
              <span className="flex items-center gap-1 text-[10.5px] text-muted-foreground/70 tabular-nums">
                <Loader2 className="size-3 animate-spin" />
                {counts.working}
              </span>
            )}
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
            {repos.length === 0 ? (
              <p className="px-3 py-8 text-center text-[12px] text-muted-foreground/60">
                Nothing running, nothing new.
              </p>
            ) : (
              repos.map((repo) => (
                <div
                  key={repo.repoId}
                  className="mt-1 border-border/60 border-t pt-2 pb-1 first:mt-0 first:border-t-0 first:pt-1"
                >
                  <div className="flex items-center gap-1.5 px-2 pb-0.5">
                    <span
                      className={cn(
                        "truncate font-mono font-semibold text-[12px]",
                        repo.repoId === activeRepoId ? "text-foreground" : "text-foreground/75",
                      )}
                    >
                      {repo.repoName}
                    </span>
                  </div>

                  {repo.inProgress.length > 0 && (
                    <>
                      <GroupLabel active count={repo.inProgress.length}>
                        In progress
                      </GroupLabel>
                      {repo.inProgress.map((r) => (
                        <ActivityRowButton
                          key={r.sessionId}
                          row={{ ...r, unread: r.sessionId === activeSessionId ? false : r.unread }}
                          onOpen={() => {
                            intent.close()
                            onOpenSession(r.sessionId, repo.repoId)
                          }}
                        />
                      ))}
                    </>
                  )}

                  {repo.settled.length > 0 && (
                    <>
                      <GroupLabel count={repo.settled.length + repo.settledHidden}>
                        Recently settled
                      </GroupLabel>
                      {repo.settled.map((r) => (
                        <ActivityRowButton
                          key={r.sessionId}
                          row={{ ...r, unread: r.sessionId === activeSessionId ? false : r.unread }}
                          onOpen={() => {
                            intent.close()
                            onOpenSession(r.sessionId, repo.repoId)
                          }}
                        />
                      ))}
                      {repo.settledHidden > 0 && (
                        <p className="px-2 py-0.5 text-[10.5px] text-muted-foreground/50">
                          +{repo.settledHidden} older
                        </p>
                      )}
                    </>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </>
  )
}
