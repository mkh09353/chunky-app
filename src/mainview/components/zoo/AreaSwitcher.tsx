// The area switcher: which product the workspace is looking at.
//
// One zoo, many areas — so this is a scope control, not a board picker. "All
// areas" is a first-class choice (and the default), every area is a radio row,
// and new areas are created from the same menu. Base UI's Menu owns the
// keyboard and focus behaviour; this only supplies rows and styling.

import { ChevronDown, Check, Folder, Layers, Pencil, Plus, Trash2, X } from "lucide-react"
import { useEffect, useState, type FormEvent } from "react"
import { cn } from "~/lib/cn"
import { compactPath } from "~/lib/format"
import { useDirSearch } from "~/hooks/useDirSearch"
import { DirSearchField } from "../DirSearchField"
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
  DropdownMenuCheckboxItem,
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

/**
 * A registered repository, as the server's repo registry reports it. Structural
 * on purpose: the app passes its own `Repo` rows straight through.
 */
export type AreaRepo = { id: string; path: string; name?: string }

/** What creating an area from the assignment menu reports back. */
export type CreateAreaResult = { ok: true; areaId: string } | { ok: false; error: string }

/** Same normalization the repo binding uses, so checkboxes match what binds. */
function samePath(a: string, b: string): boolean {
  const norm = (path: string) => path.trim().replace(/\/+$/, "") || "/"
  return norm(a) === norm(b)
}

/** Check/uncheck one repository, keeping the configured order (first wins). */
export function togglePath(paths: readonly string[], path: string): string[] {
  return paths.some((entry) => samePath(entry, path))
    ? paths.filter((entry) => !samePath(entry, path))
    : [...paths, path]
}

/** Append hand-typed paths, ignoring blanks and ones already configured. */
export function addPaths(paths: readonly string[], input: string): string[] {
  const next = [...paths]
  for (const entry of parseRepoPaths(input)) {
    if (!next.some((existing) => samePath(existing, entry))) next.push(entry)
  }
  return next
}

/**
 * Create an area and, only if that worked, move the row into it.
 *
 * A failed create (a duplicate name, a dead host) must leave the row where it
 * was and hand the reason back for the dialog to show.
 */
export async function createAndAssignArea(
  create: () => Promise<CreateAreaResult>,
  assign: (areaId: string) => void,
): Promise<string | null> {
  const result = await create()
  if (!result.ok) return result.error
  assign(result.areaId)
  return null
}

/** How a chosen path is labelled: its registered name, else its folder name. */
function pathLabel(path: string, repos: readonly AreaRepo[]): string {
  const repo = repos.find((entry) => samePath(entry.path, path))
  if (repo) return repo.name || repo.path
  const parts = path.replace(/\/+$/, "").split("/")
  return parts[parts.length - 1] || path
}

/**
 * Which repositories an area ships from.
 *
 * Two ways in, both of them the app's existing ones: the registered
 * repositories (the same list the header's repo tabs show) as a menu of
 * checkboxes, and the header's own fuzzy directory search for anything that
 * isn't registered yet. Chosen repositories — including paths the registry
 * cannot explain, which are kept rather than dropped — are removable rows.
 */
function RepoPicker({
  repos,
  paths,
  onChange,
  open,
}: {
  repos: readonly AreaRepo[]
  paths: readonly string[]
  onChange: (paths: string[]) => void
  /** Only search while the dialog is open. */
  open: boolean
}) {
  const search = useDirSearch({ enabled: open })
  const [manual, setManual] = useState("")

  const has = (path: string) => paths.some((entry) => samePath(entry, path))
  const remove = (path: string) => onChange(paths.filter((entry) => !samePath(entry, path)))
  const add = (path: string) => onChange(addPaths(paths, path))
  const addManual = () => {
    onChange(addPaths(paths, manual))
    setManual("")
  }

  useEffect(() => {
    if (!open) {
      search.reset()
      setManual("")
    }
    // `search.reset` is stable; re-running on every render would clear typing.
  }, [open, search.reset])

  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <span className="font-medium text-[12px] text-foreground">
        Repositories <span className="text-muted-foreground">· optional</span>
      </span>

      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        <DropdownMenu>
          <DropdownMenuTrigger
            render={<Button type="button" variant="outline" size="sm" disabled={repos.length === 0} />}
          >
            <Folder />
            <span className="min-w-0 truncate">
              {repos.length === 0 ? "No registered repositories" : "Choose registered…"}
            </span>
            <ChevronDown />
          </DropdownMenuTrigger>
          {/* Base UI clamps/flips this against the viewport; long registries
              scroll inside the popup rather than growing off-screen. */}
          <DropdownMenuContent align="start" className="max-h-72 min-w-64 max-w-[min(24rem,calc(100vw-2rem))] overflow-y-auto">
            <DropdownMenuLabel>Registered repositories</DropdownMenuLabel>
            {repos.map((repo) => (
              <DropdownMenuCheckboxItem
                key={repo.id}
                checked={has(repo.path)}
                onCheckedChange={() => onChange(togglePath(paths, repo.path))}
                closeOnClick={false}
              >
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="min-w-0 truncate text-[12.5px]">{repo.name || repo.path}</span>
                  <span className="min-w-0 truncate font-mono text-[10.5px] text-muted-foreground">
                    {compactPath(repo.path)}
                  </span>
                </span>
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <span className="text-[11px] text-muted-foreground">
          {paths.length
            ? `${paths.length} selected`
            : "None yet — sessions fall back to the selected repository."}
        </span>
      </div>

      {paths.length > 0 && (
        <ul className="flex min-w-0 flex-col gap-1">
          {paths.map((path) => {
            const registered = repos.some((repo) => samePath(repo.path, path))
            return (
              <li
                key={path}
                className="flex min-w-0 items-center gap-2 rounded-lg border border-border/70 bg-muted/30 py-1 pr-1 pl-2.5"
              >
                <Folder className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="min-w-0 truncate text-[12px] text-foreground">
                    {pathLabel(path, repos)}
                    {!registered && (
                      <span className="ml-1.5 text-[10.5px] text-muted-foreground">
                        not registered
                      </span>
                    )}
                  </span>
                  <span
                    className="min-w-0 truncate font-mono text-[10.5px] text-muted-foreground"
                    title={path}
                  >
                    {compactPath(path)}
                  </span>
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Remove ${path}`}
                  onClick={() => remove(path)}
                >
                  <X />
                </Button>
              </li>
            )
          })}
        </ul>
      )}

      {search.available ? (
        <DirSearchField
          search={search}
          label="Find another repository"
          emptyHint="No folders matched. Try another name."
          onChoose={(hit) => {
            add(hit.path)
            search.reset()
          }}
        />
      ) : (
        // No native bridge (browser build): typing a path is the only way in.
        <div className="flex min-w-0 items-center gap-1.5">
          <Input
            value={manual}
            onChange={(event) => setManual(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return
              // Enter here adds a path; it must not submit the whole dialog.
              event.preventDefault()
              addManual()
            }}
            placeholder="/Users/me/code/payments"
            spellCheck={false}
            className="min-w-0 flex-1 font-mono text-[12px]"
          />
          <Button type="button" variant="outline" size="sm" disabled={!manual.trim()} onClick={addManual}>
            Add path
          </Button>
        </div>
      )}

      <span className="text-[11px] text-muted-foreground">
        Research and build sessions for this area bind to the first of these that is a registered
        repository.
      </span>
    </div>
  )
}

function AreaDialog({
  open,
  onOpenChange,
  area,
  onSubmit,
  busy,
  error,
  repos = [],
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Present when editing; absent when creating. */
  area: ZooArea | null
  onSubmit: (name: string, repoPaths: string[]) => void
  busy: boolean
  error: string | null
  /** The server's registered repositories, for the checklist. */
  repos?: readonly AreaRepo[]
}) {
  const [name, setName] = useState("")
  const [paths, setPaths] = useState<string[]>([])

  useEffect(() => {
    if (!open) return
    setName(area?.name ?? "")
    setPaths([...(area?.repoPaths ?? [])])
  }, [open, area])

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!name.trim() || busy) return
    onSubmit(name.trim(), paths)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup
        className="max-h-[calc(100vh-2rem)] overflow-y-auto"
        // Assignment menus live on selectable cards; nothing in here selects one.
        onClick={(event) => event.stopPropagation()}
      >
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
            <RepoPicker repos={repos} paths={paths} onChange={setPaths} open={open} />
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
  repos = [],
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
  /** Registered repositories offered as checkboxes in the create/edit dialog. */
  repos?: readonly AreaRepo[]
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
        repos={repos}
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
  repos = [],
  onCreateArea,
}: {
  areas: ZooArea[]
  areaId: string | undefined
  onAssign: (areaId: string | null) => void
  disabled?: boolean
  /** Registered repositories offered in the inline create dialog. */
  repos?: readonly AreaRepo[]
  /**
   * Create an area without leaving this menu. On success the row being
   * assigned moves into the new area straight away; on failure the dialog
   * stays open and shows why.
   */
  onCreateArea?: (name: string, repoPaths: string[]) => Promise<CreateAreaResult>
}) {
  const current = areas.find((area) => area.id === areaId) ?? null
  const [creating, setCreating] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const create = async (name: string, repoPaths: string[]) => {
    if (!onCreateArea) return
    setBusy(true)
    setError(null)
    const failure = await createAndAssignArea(
      () => onCreateArea(name, repoPaths),
      (newAreaId) => {
        setCreating(false)
        onAssign(newAreaId)
      },
    )
    setBusy(false)
    setError(failure)
  }

  return (
    <>
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
              No areas yet.
            </p>
          )}
          {onCreateArea && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={() => {
                  setError(null)
                  setCreating(true)
                }}
              >
                <Plus />
                New area…
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      {onCreateArea && (
        <AreaDialog
          open={creating}
          onOpenChange={(open) => {
            if (open) return
            setCreating(false)
            setError(null)
          }}
          area={null}
          busy={busy}
          error={error}
          repos={repos}
          onSubmit={(name, repoPaths) => void create(name, repoPaths)}
        />
      )}
    </>
  )
}
