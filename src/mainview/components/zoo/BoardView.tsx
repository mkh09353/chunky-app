// The Board: the pipeline at a glance.
//
// Pipeline decisions still belong in the Inbox. The Board adds only the
// non-disposition Jam action; selecting anything opens it in the detail pane.

import { LayoutGrid, LoaderCircle, MessageSquareMore } from "lucide-react"
import type { MouseEvent, ReactNode } from "react"
import { cn } from "~/lib/cn"
import { NO_DRAG_REGION } from "~/lib/dragRegion"
import { relativeTime } from "~/lib/format"
import { ITEM_STAGES, type ZooArea, type ZooIdea, type ZooItem, type ZooItemStage } from "~/lib/zoo"
import { areaName } from "~/lib/zooAreas"
import { itemsByStage } from "~/lib/zooInbox"
import { AreaBadge } from "./AreaSwitcher"
import { Button } from "../ui/button"
import { Badge, EmptyState, IDEA_TYPE_LABEL, IDEA_TYPE_TONE, STAGE_LABEL, STAGE_TONE, ViewHeader } from "./parts"

function Column({
  title,
  count,
  children,
}: {
  title: string
  count: number
  children: ReactNode
}) {
  return (
    <section className="flex w-[15.5rem] min-w-0 shrink-0 flex-col gap-2">
      <h3 className="flex items-center gap-1.5 font-medium text-[11px] text-muted-foreground uppercase tracking-wide">
        {title}
        <span className="text-muted-foreground/70">{count}</span>
      </h3>
      <ul className="flex min-w-0 flex-col gap-1.5">{children}</ul>
    </section>
  )
}

function Card({
  title,
  meta,
  badge,
  area,
  selected,
  onSelect,
  onJam,
  jamBusy,
}: {
  title: string
  meta: string
  badge: ReactNode
  area?: string | null
  selected: boolean
  onSelect: () => void
  onJam?: (event: MouseEvent<HTMLButtonElement>) => void
  jamBusy?: boolean
}) {
  return (
    <li className="min-w-0">
      <article
        className={cn(
          "flex min-w-0 flex-col rounded-xl border bg-card/60",
          selected ? "border-primary/50 ring-1 ring-primary/20" : "border-border/70 hover:border-border",
        )}
      >
        <Button
          variant="ghost"
          onClick={onSelect}
          aria-pressed={selected}
          className={`${NO_DRAG_REGION} h-auto w-full min-w-0 flex-col items-start gap-1.5 whitespace-normal rounded-xl border-0 px-3 py-2 text-left shadow-none`}
        >
          <span className="min-w-0 break-words font-medium text-[12.5px] text-foreground leading-snug">
            {title}
          </span>
          <span className="flex min-w-0 flex-wrap items-center gap-1.5">
            {badge}
            {area && <AreaBadge name={area} />}
            <span className="truncate text-[11px] text-muted-foreground">{meta}</span>
          </span>
        </Button>
        {onJam && (
          <div className="flex min-w-0 flex-wrap items-center gap-1.5 border-border/60 border-t px-3 py-2">
            <Button className={NO_DRAG_REGION} size="sm" variant="outline" disabled={jamBusy} onClick={onJam}>
              {jamBusy ? <LoaderCircle className="animate-spin" /> : <MessageSquareMore />} Jam
            </Button>
          </div>
        )}
      </article>
    </li>
  )
}

/** Keep a card's direct action independent from its row-selection gesture. */
export function invokeBoardJam<T>(event: Pick<MouseEvent<HTMLButtonElement>, "preventDefault" | "stopPropagation">, target: T, onJam: (target: T) => void): void {
  event.preventDefault()
  event.stopPropagation()
  onJam(target)
}

export function BoardView({
  ideas,
  items,
  areas,
  showAreas,
  selectedId,
  onSelectIdea,
  onSelectItem,
  onStartIdeaJam,
  onStartItemJam,
  actionBusyId,
}: {
  ideas: readonly ZooIdea[]
  items: readonly ZooItem[]
  areas: ZooArea[]
  /** Badge each card with its area — only useful under "All areas". */
  showAreas: boolean
  selectedId: string | null
  onSelectIdea: (idea: ZooIdea) => void
  onSelectItem: (item: ZooItem) => void
  onStartIdeaJam?: (idea: ZooIdea) => void
  onStartItemJam?: (item: ZooItem) => void
  actionBusyId?: string | null
}) {
  const proposed = ideas.filter((idea) => idea.status === "proposed")
  const columns = itemsByStage(items, ITEM_STAGES as readonly ZooItemStage[])
  const empty = proposed.length === 0 && items.length === 0

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <ViewHeader
        title="Board"
        subtitle={`${items.length} item${items.length === 1 ? "" : "s"} · ${proposed.length} idea${proposed.length === 1 ? "" : "s"} awaiting a verdict`}
      />
      {empty ? (
        <EmptyState
          icon={<LayoutGrid className="size-5" />}
          title="Nothing on the board yet"
          body="Ideas land here once a run proposes them, and become items the moment you say go in the Inbox."
        />
      ) : (
        <div className="flex min-h-0 min-w-0 flex-1 gap-5 overflow-x-auto overflow-y-auto px-6 pb-8">
          <Column title="Proposed" count={proposed.length}>
            {proposed.map((idea) => (
              <Card
                key={idea.id}
                title={idea.title}
                meta={`${relativeTime(idea.createdAt)}${idea.jamSessions?.length ? ` · ${idea.jamSessions.length} jam${idea.jamSessions.length === 1 ? "" : "s"}` : ""}`}
                badge={<Badge className={IDEA_TYPE_TONE[idea.type]}>{IDEA_TYPE_LABEL[idea.type]}</Badge>}
                area={showAreas ? areaName(areas, idea.areaId) : null}
                selected={selectedId === `idea:${idea.id}`}
                onSelect={() => onSelectIdea(idea)}
                onJam={onStartIdeaJam ? (event) => invokeBoardJam(event, idea, onStartIdeaJam) : undefined}
                jamBusy={actionBusyId === `idea:${idea.id}`}
              />
            ))}
          </Column>
          {columns.map(({ stage, items: staged }) => (
            <Column key={stage} title={STAGE_LABEL[stage]} count={staged.length}>
              {staged.map((item) => (
                <Card
                  key={item.id}
                  title={item.title}
                  meta={`${relativeTime(item.updatedAt)} · ${item.sessionIds.length} research · ${item.jamSessions?.length ?? 0} jam`}
                  badge={<Badge className={STAGE_TONE[item.stage]}>{STAGE_LABEL[item.stage]}</Badge>}
                  area={showAreas ? areaName(areas, item.areaId) : null}
                  selected={selectedId === `item:${item.id}`}
                  onSelect={() => onSelectItem(item)}
                  onJam={onStartItemJam ? (event) => invokeBoardJam(event, item, onStartItemJam) : undefined}
                  jamBusy={actionBusyId === `item:${item.id}`}
                />
              ))}
            </Column>
          ))}
        </div>
      )}
    </div>
  )
}
