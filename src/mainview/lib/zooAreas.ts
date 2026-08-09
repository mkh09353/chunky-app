// Areas: multi-product scoping over ONE zoo board.
//
// The rule that makes this a scope and not a partition: a row with no areaId is
// "unassigned" and shows up in EVERY area. Only a row that names a DIFFERENT
// area is filtered out. So boards stored before areas existed keep working, and
// evidence recorded before a product was carved out still supports its ideas.
//
// Pure except for the selected-area preference, which is a disposable renderer
// preference (localStorage, same treatment as the theme).

import type { ZooArea, ZooIdea, ZooInsight, ZooItem, ZooSource } from "../../shared/zooTypes"

/** `null` is a real selection: "All areas". */
export type AreaSelection = string | null

const STORAGE_KEY = "zoo.area"

export type AreaScoped = { areaId?: string }

/** Does this row belong in the current view? */
export function inArea(row: AreaScoped, selected: AreaSelection): boolean {
  if (selected === null) return true
  return row.areaId === undefined || row.areaId === selected
}

/** Rows that name an area no longer on the board read as unassigned. */
export function knownArea(areas: readonly ZooArea[], areaId: string | undefined): ZooArea | null {
  if (!areaId) return null
  return areas.find((area) => area.id === areaId) ?? null
}

export function areaName(areas: readonly ZooArea[], areaId: string | undefined): string | null {
  return knownArea(areas, areaId)?.name ?? null
}

export type Board = {
  sources: readonly ZooSource[]
  insights: readonly ZooInsight[]
  ideas: readonly ZooIdea[]
  items: readonly ZooItem[]
}

/**
 * Narrow a whole board to one area. Evidence is NOT narrowed by callers that
 * resolve citations — an idea in one area may cite an insight recorded in
 * another, and that link must still render (see buildInbox, which indexes every
 * insight and filters only what becomes a card).
 */
export function scopeBoard(board: Board, selected: AreaSelection): Board {
  if (selected === null) return board
  return {
    sources: board.sources.filter((row) => inArea(row, selected)),
    insights: board.insights.filter((row) => inArea(row, selected)),
    ideas: board.ideas.filter((row) => inArea(row, selected)),
    items: board.items.filter((row) => inArea(row, selected)),
  }
}

/** How many things an area currently holds — used for the switcher's subtitle. */
export function areaCounts(board: Board, areaId: string): { ideas: number; items: number } {
  return {
    ideas: board.ideas.filter((row) => row.areaId === areaId).length,
    items: board.items.filter((row) => row.areaId === areaId).length,
  }
}

// ---- repo binding ---------------------------------------------------------

export type RepoLike = { id: string; path: string }

function normalizePath(path: string): string {
  const trimmed = path.trim().replace(/\/+$/, "")
  return trimmed || "/"
}

/**
 * The repo a session for this area should be bound to.
 *
 * Matches an area's configured paths against the server's repo registry, in the
 * area's own order (first configured path wins). Returns null when the area has
 * no paths or none of them is a registered repo — the caller then falls back to
 * whatever repository is currently selected.
 */
export function repoIdForArea(area: ZooArea | null, repos: readonly RepoLike[]): string | null {
  if (!area?.repoPaths?.length) return null
  const byPath = new Map<string, string>()
  for (const repo of repos) byPath.set(normalizePath(repo.path), repo.id)
  for (const path of area.repoPaths) {
    const match = byPath.get(normalizePath(path))
    if (match) return match
  }
  return null
}

// ---- selected-area preference --------------------------------------------

/** Disposable renderer preference: which area the workspace opens on. */
export function loadSelectedArea(): AreaSelection {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    return stored && stored !== "all" ? stored : null
  } catch {
    return null
  }
}

export function saveSelectedArea(selected: AreaSelection): void {
  try {
    if (selected === null) localStorage.removeItem(STORAGE_KEY)
    else localStorage.setItem(STORAGE_KEY, selected)
  } catch {
    /* storage disabled */
  }
}

/** A stored area that has since been deleted must not hide the whole board. */
export function resolveSelection(selected: AreaSelection, areas: readonly ZooArea[]): AreaSelection {
  if (selected === null) return null
  return areas.some((area) => area.id === selected) ? selected : null
}
