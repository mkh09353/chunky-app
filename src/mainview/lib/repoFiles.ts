import type { FileSearchItem } from "@chunky/protocol"

export function normalizeRepoPath(path: string): string {
  return path.replace(/^\.\//, "").replace(/^\/+|\/+$/g, "")
}

/** FFF treats whitespace-separated terms as a fuzzy AND query. */
export function buildRepoFilesQuery(directory: string, term: string): string {
  return [normalizeRepoPath(directory), term.trim()].filter(Boolean).join(" ")
}

export function filterAndSortRepoFiles(items: FileSearchItem[], directory: string): FileSearchItem[] {
  const scope = normalizeRepoPath(directory)
  const prefix = scope ? `${scope}/` : ""
  const unique = new Map<string, FileSearchItem>()
  for (const item of items) {
    const path = normalizeRepoPath(item.path)
    if (!path || path === scope || (prefix && !path.startsWith(prefix))) continue
    if (!unique.has(path)) unique.set(path, item)
  }
  return [...unique.values()].sort((a, b) => {
    const directoryOrder = Number(b.kind === "directory") - Number(a.kind === "directory")
    if (directoryOrder) return directoryOrder
    return normalizeRepoPath(a.path).localeCompare(normalizeRepoPath(b.path), undefined, {
      numeric: true,
      sensitivity: "base",
    })
  })
}
