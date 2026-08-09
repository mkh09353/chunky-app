// The area switcher: which product the workspace is looking at.
//
// One zoo, many areas — so this is a scope control, not a board picker. "All
// areas" is a first-class choice (and the default), every area is a radio row,
// and new areas are created from the same menu. Base UI's Menu owns the
// keyboard and focus behaviour; this only supplies rows and styling.

import { Check, Layers, Pencil, Plus, Trash2 } from "lucide-react"
import { useEffect, useState, type FormEvent } from "react"
import { cn } from "~/lib/cn"
import type { ZooArea } from "~/lib/zoo"
import { areaCounts, type AreaSelection, type Board } from "~/lib/zooAreas"
import { Button } from "../ui/button"
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu"
import { Input } from "../ui/input"
import { Notice } from "./parts"

export const ALL_AREAS_LABEL = "All areas"

/** One path per line; blank lines are ignored. */
export function parseRepoPaths(value: string): string[] {
  return value
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter(Boolean)
}

function AreaDialog({
  open,
  onOpenChange,
  area,
  onSubmit,
  busy,
  error,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Present when editing; absent when creating. */
  area: ZooArea | null
  onSubmit: (name: string, repoPaths: string[]) => void
  busy: boolean
  error: string | null
}) {
  const [name, setName] = useState("")
  const [paths, setPaths] = useState("")

  useEffect(() => {
    if (!open) return
    setName(area?.name ?? "")
    setPaths((area?.repoPaths ?? []).join("\n"))
  }, [open, area])

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!name.trim() || busy) return
    onSubmit(name.trim(), parseRepoPaths(paths))
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup>
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>{area ? "Rename area" : "New area"}</DialogTitle>
            <DialogDescription>
              An area scopes one product inside the zoo. Give it the repository it ships from and
              its sessions will start there.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3 px-6 pb-2">
            <label className="flex flex-col gap-1.5">
              <span className="font-medium text-[12px] text-foreground">Name</span>
              <Input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Payments"
                autoFocus
                spellCheck={false}
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="font-medium text-[12px] text-foreground">
                Repository paths <span className="text-muted-foreground">· optional</span>
              </span>
              <textarea
                value={paths}
                onChange={(event) => setPaths(event.target.value)}
                placeholder={"/Users/me/code/payments\none path per line"}
                spellCheck={false}
                className="min-h-16 w-full min-w-0 rounded-lg border border-input bg-transparent p-2 font-mono text-[12px] outline-none focus:border-ring focus:ring-[3px] focus:ring-ring/25"
              />
              <span className="text-[11px] text-muted-foreground">
                Research and build sessions for this area bind to the first of these that is a
                registered repository.
              </span>
            </label>
            {error && <Notice text={error} />}
          </div>
          <DialogFooter>
            <Button type="submit" disabled={busy || !name.trim()}>
              {area ? "Save" : "Create area"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  )
}

export function AreaSwitcher({
  areas,
  selected,
  onSelect,
  board,
  onCreate,
  onRename,
  onDelete,
  busy = false,
  error,
  disabled = false,
}: {
  areas: ZooArea[]
  selected: AreaSelection
  onSelect: (selection: AreaSelection) => void
  /** Used only for the per-area counts in the menu. */
  board: Board
  onCreate: (name: string, repoPaths: string[]) => void
  onRename: (areaId: string, name: string, repoPaths: string[]) => void
  onDelete: (areaId: string) => void
  busy?: boolean
  error?: string | null
  disabled?: boolean
}) {
  const [dialog, setDialog] = useState<{ area: ZooArea | null } | null>(null)
  const current = areas.find((area) => area.id === selected) ?? null

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="outline"
              size="sm"
              disabled={disabled}
              aria-label="Switch area"
              className="max-w-56"
            />
          }
        >
          <Layers />
          <span className="min-w-0 truncate">{current?.name ?? ALL_AREAS_LABEL}</span>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-60">
          <DropdownMenuLabel>Area</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={selected ?? "all"}
            onValueChange={(value) => onSelect(value === "all" ? null : String(value))}
          >
            <DropdownMenuRadioItem value="all">
              <span className="min-w-0 flex-1 truncate">{ALL_AREAS_LABEL}</span>
            </DropdownMenuRadioItem>
            {areas.map((area) => {
              const counts = areaCounts(board, area.id)
              return (
                <DropdownMenuRadioItem key={area.id} value={area.id}>
                  <span className="min-w-0 flex-1 truncate">{area.name}</span>
                  <span className="shrink-0 text-[11px] text-muted-foreground">
                    {counts.items || counts.ideas
                      ? `${counts.ideas} idea${counts.ideas === 1 ? "" : "s"} · ${counts.items} item${counts.items === 1 ? "" : "s"}`
                      : "empty"}
                  </span>
                </DropdownMenuRadioItem>
              )
            })}
          </DropdownMenuRadioGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => setDialog({ area: null })}>
            <Plus />
            New area…
          </DropdownMenuItem>
          {current && (
            <>
              <DropdownMenuItem onClick={() => setDialog({ area: current })}>
                <Pencil />
                Edit “{current.name}”
              </DropdownMenuItem>
              <DropdownMenuItem variant="destructive" onClick={() => onDelete(current.id)}>
                <Trash2 />
                Delete area
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <AreaDialog
        open={dialog !== null}
        onOpenChange={(open) => !open && setDialog(null)}
        area={dialog?.area ?? null}
        busy={busy}
        error={error ?? null}
        onSubmit={(name, repoPaths) => {
          if (dialog?.area) onRename(dialog.area.id, name, repoPaths)
          else onCreate(name, repoPaths)
          setDialog(null)
        }}
      />
    </>
  )
}

/** The small "which product is this" tag shown on cards under All areas. */
export function AreaBadge({ name, className }: { name: string; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex min-w-0 shrink items-center gap-1 rounded-full border border-border/70 bg-muted/40 px-2 py-0.5 font-medium text-[10.5px] text-muted-foreground leading-4",
        className,
      )}
      title={`Area: ${name}`}
    >
      <Layers className="size-2.5 shrink-0" />
      <span className="truncate">{name}</span>
    </span>
  )
}

/** Reassign one row to another area (or to none) from the detail pane. */
export function AreaAssignMenu({
  areas,
  areaId,
  onAssign,
  disabled = false,
}: {
  areas: ZooArea[]
  areaId: string | undefined
  onAssign: (areaId: string | null) => void
  disabled?: boolean
}) {
  const current = areas.find((area) => area.id === areaId) ?? null
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button variant="outline" size="sm" disabled={disabled} aria-label="Change area" />}
      >
        <Layers />
        <span className="min-w-0 truncate">{current?.name ?? "Unassigned"}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuLabel>Move to area</DropdownMenuLabel>
        <DropdownMenuItem onClick={() => onAssign(null)}>
          {!current && <Check />}
          <span className={cn("min-w-0 truncate", current && "pl-6")}>Unassigned</span>
        </DropdownMenuItem>
        {areas.map((area) => (
          <DropdownMenuItem key={area.id} onClick={() => onAssign(area.id)}>
            {current?.id === area.id && <Check />}
            <span className={cn("min-w-0 truncate", current?.id !== area.id && "pl-6")}>
              {area.name}
            </span>
          </DropdownMenuItem>
        ))}
        {areas.length === 0 && (
          <p className="px-2.5 py-1.5 text-[11.5px] text-muted-foreground">
            No areas yet — create one from the header.
          </p>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
