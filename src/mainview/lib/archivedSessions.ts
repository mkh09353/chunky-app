// Local-only session archiving. Purely a renderer-side view filter: archived
// ids live in localStorage and NOTHING is ever deleted on the server.
import { useCallback, useSyncExternalStore } from "react"

export const ARCHIVED_SESSIONS_KEY = "chunky.archivedSessions"

const listeners = new Set<() => void>()
let cache: ReadonlySet<string> | null = null
let storageBound = false

function load(): ReadonlySet<string> {
  try {
    const raw = localStorage.getItem(ARCHIVED_SESSIONS_KEY)
    if (!raw) return new Set<string>()
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return new Set<string>()
    return new Set(parsed.filter((id): id is string => typeof id === "string" && id.length > 0))
  } catch {
    return new Set<string>()
  }
}

/** Stable snapshot: the same Set reference until something actually changes. */
function snapshot(): ReadonlySet<string> {
  if (!cache) cache = load()
  return cache
}

function emit() {
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  if (!storageBound && typeof window !== "undefined") {
    storageBound = true
    window.addEventListener("storage", (event) => {
      if (event.key !== null && event.key !== ARCHIVED_SESSIONS_KEY) return
      cache = null
      emit()
    })
  }
  return () => {
    listeners.delete(listener)
  }
}

function persist(next: ReadonlySet<string>) {
  cache = next
  try {
    localStorage.setItem(ARCHIVED_SESSIONS_KEY, JSON.stringify([...next]))
  } catch {
    /* quota / storage disabled — the filter still works for this window */
  }
  emit()
}

export function readArchivedSessions(): ReadonlySet<string> {
  return snapshot()
}

export function archiveSession(id: string): void {
  const current = snapshot()
  if (!id || current.has(id)) return
  const next = new Set(current)
  next.add(id)
  persist(next)
}

export function unarchiveSession(id: string): void {
  const current = snapshot()
  if (!current.has(id)) return
  const next = new Set(current)
  next.delete(id)
  persist(next)
}

export interface ArchivedSessions {
  archived: ReadonlySet<string>
  isArchived: (id: string) => boolean
  archive: (id: string) => void
  unarchive: (id: string) => void
  toggle: (id: string) => void
}

/** Subscribe to the archived-session set (shared across components/windows). */
export function useArchivedSessions(): ArchivedSessions {
  const archived = useSyncExternalStore(subscribe, snapshot, snapshot)
  const isArchived = useCallback((id: string) => archived.has(id), [archived])
  const toggle = useCallback(
    (id: string) => {
      if (archived.has(id)) unarchiveSession(id)
      else archiveSession(id)
    },
    [archived],
  )
  return { archived, isArchived, archive: archiveSession, unarchive: unarchiveSession, toggle }
}
