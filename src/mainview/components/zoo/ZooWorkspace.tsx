// The Zoo: the app's primary surface.
//
// Three zones — a slim nav rail, one main column, and a detail pane that opens
// on selection — over the product-factory board (Sources -> Insights -> Ideas ->
// Items). The Inbox is the point of the whole thing: a queue of decisions with
// their evidence attached. Chat is still one click away in the header, but it is
// no longer where the work starts.
//
// Data comes from hooks/useZooBoard.ts and every mutation goes through
// lib/zoo*.ts — this file makes no server calls of its own.

import { Factory, Inbox, LayoutGrid, LoaderCircle, MessagesSquare, Plug, RefreshCw } from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useZooBoard } from "~/hooks/useZooBoard"
import { cn } from "~/lib/cn"
import {
  ZOO_UNAVAILABLE,
  zooAssignArea,
  zooCreateArea,
  zooDeleteArea,
  zooUpdateArea,
  type ZooAreaKind,
  type ZooIdea,
  type ZooItem,
} from "~/lib/zoo"
import {
  inArea,
  loadSelectedArea,
  resolveSelection,
  saveSelectedArea,
  scopeBoard,
  type AreaSelection,
} from "~/lib/zooAreas"
import { startFactoryChat } from "~/lib/zooChat"
import { resolveRepoForArea } from "~/lib/zooDecisions"
import { runExtraction, type ExtractionPhase } from "~/lib/zooExtraction"
import { buildInbox, entryForIdea, entryForItem, inFlightItems, type InboxEntry } from "~/lib/zooInbox"
import { runSynthesis, runTriage } from "~/lib/zooSynthesis"
import { startJam, type JamTarget } from "~/lib/zooJam"
import { startResearchSession } from "~/lib/zooItemFlow"
import { AreaSwitcher, type AreaRepo, type CreateAreaResult } from "./AreaSwitcher"
import { Button } from "../ui/button"
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip"
import { BoardView } from "./BoardView"
import { DetailPane } from "./DetailPane"
import { InboxView } from "./InboxView"
import { EmptyState, Notice } from "./parts"
import { IDLE_RUNS, SourcesView, type RunKind, type RunState } from "./SourcesView"
import { SetupView } from "./SetupView"

type ZooView = "inbox" | "board" | "sources" | "setup"

const VIEWS: { id: ZooView; label: string; icon: typeof Inbox }[] = [
  { id: "inbox", label: "Inbox", icon: Inbox },
  { id: "board", label: "Board", icon: LayoutGrid },
  { id: "sources", label: "Sources", icon: Plug },
]

export function ZooWorkspace({
  baseUrl,
  repoId,
  repos = [],
  onOpenSession,
  onOpenChat,
}: {
  /** Live Chunky server, or null when there is none — runs stay disabled. */
  baseUrl?: string | null
  /** Selected repository; promotion and triage bind their sessions to it. */
  repoId?: string | null
  /** The server's registered repositories, offered when editing an area. */
  repos?: readonly AreaRepo[]
  /** Show a session in the (secondary) chat surface. */
  onOpenSession?: (sessionId: string) => void
  onOpenChat: () => void
}) {
  const board = useZooBoard()
  const [view, setView] = useState<ZooView>("inbox")
  // Which product is in view. Disposable renderer preference, like the theme.
  const [selectedArea, setSelectedArea] = useState<AreaSelection>(loadSelectedArea)
  const [areaBusy, setAreaBusy] = useState(false)
  const [areaError, setAreaError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [setAside, setSetAside] = useState<string[]>([])
  const [talking, setTalking] = useState(false)
  const [headerError, setHeaderError] = useState<string | null>(null)
  const [setupRepoId, setSetupRepoId] = useState<string | null>(null)
  const [setupRepoError, setSetupRepoError] = useState<string | null>(null)
  const [cardActionBusy, setCardActionBusy] = useState<string | null>(null)

  const [runs, setRuns] = useState<Record<RunKind, RunState>>(IDLE_RUNS)
  const [elapsed, setElapsed] = useState(0)
  const runningRef = useRef<Set<RunKind>>(new Set())

  const { areas, ideas, items, insights, refresh } = board

  // A stored area that has since been deleted must not hide the whole board.
  useEffect(() => {
    setSelectedArea((current) => resolveSelection(current, areas))
  }, [areas])
  useEffect(() => {
    saveSelectedArea(selectedArea)
  }, [selectedArea])

  const area = useMemo(
    () => areas.find((row) => row.id === selectedArea) ?? null,
    [areas, selectedArea],
  )
  const fullBoard = useMemo(
    () => ({ sources: board.status?.sources ?? [], insights, ideas, items }),
    [board.status, insights, ideas, items],
  )
  /** Board narrowed to the selected area (unassigned rows stay visible). */
  const scoped = useMemo(() => scopeBoard(fullBoard, selectedArea), [fullBoard, selectedArea])

  const entries = useMemo(
    () => buildInbox({ ideas, items, insights, dismissed: setAside, areaId: selectedArea }),
    [ideas, items, insights, setAside, selectedArea],
  )
  const inFlight = useMemo(() => inFlightItems(items, selectedArea), [items, selectedArea])
  const watchesInView = useMemo(
    () => board.watches.filter((watch) => inArea(watch, selectedArea)),
    [board.watches, selectedArea],
  )
  const xWatchesInView = useMemo(() => board.xWatches.filter((watch) => inArea(watch, selectedArea)), [board.xWatches, selectedArea])

  /** Every selectable thing, queued or not, in the shape the detail pane wants. */
  const catalog = useMemo(() => {
    const map = new Map<string, InboxEntry>()
    for (const entry of entries) map.set(entry.id, entry)
    for (const item of scoped.items) {
      if (!map.has(`item:${item.id}`)) map.set(`item:${item.id}`, entryForItem(item, ideas, insights))
    }
    for (const idea of scoped.ideas) {
      if (!map.has(`idea:${idea.id}`)) map.set(`idea:${idea.id}`, entryForIdea(idea, insights))
    }
    return map
  }, [entries, ideas, insights, scoped.ideas, scoped.items])

  const selected = selectedId ? catalog.get(selectedId) ?? null : null

  // A decision removes its card; don't leave the pane pointing at a ghost.
  useEffect(() => {
    if (selectedId && !catalog.has(selectedId)) setSelectedId(null)
  }, [catalog, selectedId])

  /** Every area mutation shares one busy/error/refresh path. */
  const areaAction = useCallback(
    async (run: () => Promise<{ ok: boolean; error?: string }>) => {
      setAreaBusy(true)
      setAreaError(null)
      const result = await run()
      setAreaBusy(false)
      if (!result.ok && result.error) setAreaError(result.error)
      await refresh()
      return result.ok
    },
    [refresh],
  )

  const createArea = (name: string, repoPaths: string[]) =>
    void areaAction(async () => {
      const result = await zooCreateArea(name, repoPaths)
      // Land in the area you just made — that is what creating one is for.
      if (result.ok) setSelectedArea(result.area.id)
      return result
    })

  /**
   * Create an area for a caller that needs its id back — the assignment menu
   * moves the row it is editing into the area it just made. The error is
   * returned rather than raised into the header so the caller's own dialog can
   * show it and stay open.
   */
  const createAreaFor = useCallback(
    async (name: string, repoPaths: string[]): Promise<CreateAreaResult> => {
      setAreaBusy(true)
      setAreaError(null)
      const result = await zooCreateArea(name, repoPaths)
      setAreaBusy(false)
      await refresh()
      return result.ok ? { ok: true, areaId: result.area.id } : { ok: false, error: result.error }
    },
    [refresh],
  )

  const renameArea = (areaId: string, name: string, repoPaths: string[]) =>
    void areaAction(() => zooUpdateArea(areaId, { name, repoPaths }))

  const deleteArea = (areaId: string) =>
    void areaAction(async () => {
      const result = await zooDeleteArea(areaId)
      // Deleting an area only unassigns its rows; fall back to seeing them all.
      if (result.ok) setSelectedArea(null)
      return result
    })

  const assignArea = (kind: ZooAreaKind, id: string, areaId: string | null) =>
    void areaAction(() => zooAssignArea(kind, id, areaId))

  const anyRunning = Object.values(runs).some((run) => run.kind === "running")
  useEffect(() => {
    if (!anyRunning) return
    const startedAt = Math.min(
      ...Object.values(runs)
        .filter((run): run is Extract<RunState, { kind: "running" }> => run.kind === "running")
        .map((run) => run.startedAt),
    )
    setElapsed(Date.now() - startedAt)
    const timer = setInterval(() => setElapsed(Date.now() - startedAt), 1000)
    return () => clearInterval(timer)
  }, [anyRunning, runs])

  const setRun = (kind: RunKind, state: RunState) => setRuns((prev) => ({ ...prev, [kind]: state }))

  const startRun = useCallback(
    async (kind: RunKind) => {
      if (runningRef.current.has(kind)) return
      runningRef.current.add(kind)
      setRun(kind, { kind: "running", phase: "exporting", startedAt: Date.now() })
      const onPhase = (phase: ExtractionPhase) =>
        setRuns((prev) => {
          const current = prev[kind]
          return current.kind === "running" ? { ...prev, [kind]: { ...current, phase } } : prev
        })

      let state: RunState
      if (kind === "extraction") {
        const result = await runExtraction({ baseUrl, onPhase, areaId: selectedArea })
        state = result.ok
          ? {
              kind: "done",
              note: `Extraction complete — ${result.insightCount} insight${result.insightCount === 1 ? "" : "s"} recorded.`,
            }
          : { kind: "error", error: result.error }
      } else if (kind === "synthesis") {
        const result = await runSynthesis({ baseUrl, onPhase, areaId: selectedArea })
        state = result.ok
          ? {
              kind: "done",
              note: `Synthesis complete — ${result.ideaCount} idea${result.ideaCount === 1 ? "" : "s"} proposed${result.dropped ? `, ${result.dropped} entry ignored` : ""}.`,
            }
          : { kind: "error", error: result.error }
      } else {
        // An area that names a repo triages ITS codebase, not the selected one.
        const bound = await resolveRepoForArea(baseUrl, area, repoId)
        const result = await runTriage(bound ?? "", { baseUrl, onPhase, areaId: selectedArea })
        state = result.ok
          ? {
              kind: "done",
              note: `Triage complete — ${result.ideaCount} idea${result.ideaCount === 1 ? "" : "s"} proposed${result.dropped ? `, ${result.dropped} entry ignored` : ""}.`,
            }
          : { kind: "error", error: result.error }
      }
      runningRef.current.delete(kind)
      setRun(kind, state)
      await refresh()
    },
    [area, baseUrl, refresh, repoId, selectedArea],
  )

  const talkToFactory = async () => {
    if (talking) return
    setTalking(true)
    setHeaderError(null)
    const result = await startFactoryChat(baseUrl, repoId, { area })
    setTalking(false)
    if (!result.ok) {
      setHeaderError(result.error)
      return
    }
    onOpenSession?.(result.sessionId)
  }

  const openSetup = async () => {
    setSetupRepoError(null)
    const bound = await resolveRepoForArea(baseUrl, area, repoId)
    setSetupRepoId(bound)
    if (!bound) setSetupRepoError("Select a repository or configure this area's repository before starting setup.")
    setSelectedId(null)
    setView("setup")
  }

  const targetArea = (entry: InboxEntry) => entry.areaId ? areas.find((candidate) => candidate.id === entry.areaId) ?? null : null
  const startCardJam = async (entry: InboxEntry) => {
    if (cardActionBusy) return
    const idea = entry.idea ?? (entry.item ? ideas.find((candidate) => candidate.id === entry.item!.ideaId) : undefined)
    if (!idea) { setHeaderError("This card's originating idea is unavailable."); return }
    setCardActionBusy(entry.id); setHeaderError(null)
    const target: JamTarget = entry.item ? { kind: "item", item: entry.item, idea } : { kind: "idea", idea }
    const result = await startJam(baseUrl, repoId, targetArea(entry), target, insights)
    setCardActionBusy(null)
    if (!result.ok) { setHeaderError(result.error); return }
    if (result.warning) setHeaderError(result.warning)
    await refresh(); onOpenSession?.(result.sessionId)
  }
  const startCardResearch = async (entry: InboxEntry) => {
    if (cardActionBusy || !entry.item) return
    const idea = entry.idea ?? ideas.find((candidate) => candidate.id === entry.item!.ideaId)
    if (!idea) { setHeaderError("This item's originating idea is unavailable."); return }
    setCardActionBusy(entry.id); setHeaderError(null)
    const bound = await resolveRepoForArea(baseUrl, targetArea(entry), repoId)
    if (!bound) { setCardActionBusy(null); setHeaderError("Select a repository or configure this card's area repository before starting research."); return }
    const result = await startResearchSession(entry.item, idea, bound, { baseUrl })
    setCardActionBusy(null)
    if (!result.ok) { setHeaderError(result.error); if (result.sessionId) onOpenSession?.(result.sessionId); return }
    await refresh(); if (result.sessionId) onOpenSession?.(result.sessionId)
  }

  const openSession = onOpenSession
    ? (sessionId: string) => onOpenSession(sessionId)
    : undefined

  const counts = board.status
  const subtitle = counts
    ? `${counts.artifactCount} artifact${counts.artifactCount === 1 ? "" : "s"} · ${counts.insightCount} insight${counts.insightCount === 1 ? "" : "s"} · ${counts.ideaCount} idea${counts.ideaCount === 1 ? "" : "s"} · ${counts.itemCount} item${counts.itemCount === 1 ? "" : "s"}`
    : "The product factory"

  const main = !board.available ? (
    <EmptyState
      icon={<Factory className="size-5" />}
      title={ZOO_UNAVAILABLE}
      body="Sources, evidence and the decision log live in the desktop app's local store. The web development build has no access to it — the workspace still runs, it just has nothing to show."
      action={
        <Button variant="outline" size="sm" onClick={onOpenChat}>
          <MessagesSquare />
          Open chat instead
        </Button>
      }
    />
  ) : view === "inbox" ? (
    <InboxView
      entries={entries}
      inFlight={inFlight}
      selectedId={selectedId}
      onSelect={setSelectedId}
      context={{ repoId, baseUrl, area }}
      areas={areas}
      showAreas={selectedArea === null}
      onRefresh={refresh}
      onSetAside={(id) => {
        setSetAside((prev) => (prev.includes(id) ? prev : [...prev, id]))
        setSelectedId((current) => (current === id ? null : current))
      }}
      onSynthesize={baseUrl ? () => void startRun("synthesis") : undefined}
      synthesizing={runs.synthesis.kind === "running"}
      {...(openSession ? { onOpenSession: openSession } : {})}
      loading={board.loading}
      onStartJam={(entry) => void startCardJam(entry)}
      onStartResearch={(entry) => void startCardResearch(entry)}
      actionBusyId={cardActionBusy}
    />
  ) : view === "board" ? (
    <BoardView
      ideas={scoped.ideas}
      items={scoped.items}
      areas={areas}
      showAreas={selectedArea === null}
      selectedId={selectedId}
      onSelectIdea={(idea: ZooIdea) => setSelectedId(`idea:${idea.id}`)}
      onSelectItem={(item: ZooItem) => setSelectedId(`item:${item.id}`)}
      onStartIdeaJam={(idea) => void startCardJam(entryForIdea(idea, insights))}
      onStartItemJam={(item) => void startCardJam(entryForItem(item, ideas, insights))}
      actionBusyId={cardActionBusy}
    />
  ) : view === "sources" ? (
    <SourcesView
      status={board.status}
      sources={scoped.sources}
      areaId={selectedArea}
      areaName={area?.name ?? null}
      runs={runs}
      elapsed={elapsed}
      onRun={(kind) => void startRun(kind)}
      onRefresh={refresh}
      baseUrl={baseUrl}
      canTriage={!!repoId || !!area?.repoPaths?.length}
      insightCount={scoped.insights.length}
      watches={watchesInView}
      areas={areas}
      watchHour={board.watchHour}
      watchLastRunAt={board.watchLastRunAt}
      xWatches={xWatchesInView}
      xWatchIntervalMinutes={board.xWatchIntervalMinutes}
      xWatchLastSuccessAt={board.xWatchLastSuccessAt}
      onAssignArea={(sourceId, next) => assignArea("source", sourceId, next)}
      repos={repos}
      onCreateArea={createAreaFor}
      onOpenSetup={() => void openSetup()}
    />
  ) : (
    <SetupView
      baseUrl={baseUrl}
      repoId={setupRepoId}
      repositoryMessage={setupRepoError}
      onBack={() => setView("sources")}
      {...(openSession ? { onOpenSession: openSession } : {})}
    />
  )

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header
        className="flex h-[52px] min-w-0 shrink-0 items-center gap-3 border-border/70 border-b px-4"
      >
        <div className="min-w-0">
          <p className="truncate font-semibold text-[13.5px] text-foreground tracking-tight">The Zoo</p>
          <p className="truncate text-[11px] text-muted-foreground">{subtitle}</p>
        </div>
        <div className="flex min-w-0 shrink items-center">
          <AreaSwitcher
            areas={areas}
            selected={selectedArea}
            onSelect={setSelectedArea}
            board={fullBoard}
            onCreate={createArea}
            onRename={renameArea}
            onDelete={deleteArea}
            busy={areaBusy}
            error={areaError}
            repos={repos}
            disabled={!board.available}
          />
        </div>
        <div aria-hidden className="h-full min-w-6 flex-1" />
        <div className="flex shrink-0 items-center gap-1.5">
          <Button
            size="sm"
            variant="outline"
            disabled={talking || !baseUrl || !onOpenSession}
            title={baseUrl ? undefined : "Needs a connected Chunky server"}
            onClick={() => void talkToFactory()}
          >
            {talking ? <LoaderCircle className="animate-spin" /> : <MessagesSquare />}
            Talk to the Factory
          </Button>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Refresh the board"
                  disabled={!board.available}
                  onClick={() => void refresh()}
                />
              }
            >
              <RefreshCw />
            </TooltipTrigger>
            <TooltipPopup>Refresh the board</TooltipPopup>
          </Tooltip>
          <Button size="sm" variant="ghost" onClick={onOpenChat}>
            Chat
          </Button>
        </div>
      </header>

      {headerError && (
        <div className="shrink-0 px-4 pt-2">
          <Notice text={headerError} />
        </div>
      )}
      {areaError && (
        <div className="shrink-0 px-4 pt-2">
          <Notice text={areaError} />
        </div>
      )}
      {board.error && (
        <div className="shrink-0 px-4 pt-2">
          <Notice text={board.error} />
        </div>
      )}

      <div className="@container/zoo-body flex min-h-0 min-w-0 flex-1">
        <nav
          aria-label="Zoo views"
          className="flex w-[4.75rem] shrink-0 flex-col items-stretch gap-1 border-border/70 border-r px-2 py-3"
        >
          {VIEWS.map(({ id, label, icon: Icon }) => {
            const active = view === id
            const badge = id === "inbox" && entries.length > 0 ? entries.length : null
            return (
              <button
                key={id}
                type="button"
                onClick={() => setView(id)}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "relative flex cursor-pointer flex-col items-center gap-1 rounded-xl px-1 py-2 text-[10.5px] transition-colors",
                  active
                    ? "bg-primary/10 font-medium text-primary"
                    : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                )}
              >
                <Icon className="size-4" />
                {label}
                {badge !== null && (
                  <span className="absolute top-1.5 right-2 rounded-full bg-primary px-1.5 text-[9.5px] font-medium text-primary-foreground leading-4">
                    {badge}
                  </span>
                )}
              </button>
            )
          })}
        </nav>

        <main className={cn("min-h-0 min-w-0 flex-1 flex-col", selected ? "flex @max-[46rem]/zoo-body:hidden" : "flex")}>{main}</main>

        {selected && (
          <DetailPane
            entry={selected}
            areas={areas}
            onAssignArea={assignArea}
            repos={repos}
            onCreateArea={createAreaFor}
            areaBusy={areaBusy}
            onClose={() => setSelectedId(null)}
            {...(openSession ? { onOpenSession: openSession } : {})}
            onStartJam={(entry) => void startCardJam(entry)}
            onStartResearch={(entry) => void startCardResearch(entry)}
            actionBusy={cardActionBusy === selected.id}
          />
        )}
      </div>
    </div>
  )
}
