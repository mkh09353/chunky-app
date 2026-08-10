// Debounced fuzzy directory search, shared by every "find me a project on
// disk" affordance (the header's Add repository popover, the Zoo area dialog).
//
// The search itself is bun-main FFF over RPC — see lib/dirSearch.ts. Nothing
// here fetches; this hook only owns the query, the debounce, the in-flight
// generation guard, and which hit the keyboard is on.

import { useCallback, useEffect, useRef, useState, type Dispatch, type KeyboardEvent as ReactKeyboardEvent, type SetStateAction } from "react"
import { nativeDirSearchAvailable, searchDirectories, type DirSearchHit } from "~/lib/dirSearch"

export const DIR_SEARCH_DEBOUNCE_MS = 180

export type DirSearch = {
  /** False in the browser build (no native bridge) — hide the field. */
  available: boolean
  query: string
  setQuery: Dispatch<SetStateAction<string>>
  hits: DirSearchHit[]
  searching: boolean
  error: string | null
  /** Index of the hit the keyboard is on, or -1. */
  activeHit: number
  setActiveHit: Dispatch<SetStateAction<number>>
  /** Arrow/Enter handling for the input; Enter picks the active hit. */
  keyDown: (
    event: ReactKeyboardEvent<HTMLInputElement>,
    choose: (hit: DirSearchHit) => void,
  ) => void
  /** Clear the query and drop any in-flight response on the floor. */
  reset: () => void
}

export function useDirSearch({
  /** Only search while the surface holding the field is open. */
  enabled = true,
  limit = 12,
}: { enabled?: boolean; limit?: number } = {}): DirSearch {
  const available = nativeDirSearchAvailable()
  const [query, setQuery] = useState("")
  const [hits, setHits] = useState<DirSearchHit[]>([])
  const [searching, setSearching] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [activeHit, setActiveHit] = useState(-1)
  const seqRef = useRef(0)

  const reset = useCallback(() => {
    // Invalidate any in-flight search so a slow response cannot repopulate hits.
    seqRef.current += 1
    setQuery("")
    setHits([])
    setSearching(false)
    setError(null)
    setActiveHit(-1)
  }, [])

  useEffect(() => {
    if (!enabled || !available) return
    const q = query.trim()
    if (!q) {
      seqRef.current += 1
      setHits([])
      setSearching(false)
      setError(null)
      setActiveHit(-1)
      return
    }
    const seq = ++seqRef.current
    setSearching(true)
    const timer = window.setTimeout(() => {
      void (async () => {
        const res = await searchDirectories(q, limit)
        if (seq !== seqRef.current) return
        setHits(res.items)
        setError(res.error ?? null)
        setActiveHit(res.items.length > 0 ? 0 : -1)
        setSearching(false)
      })()
    }, DIR_SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [query, enabled, available, limit])

  const keyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLInputElement>, choose: (hit: DirSearchHit) => void) => {
      if (event.key === "ArrowDown") {
        if (hits.length === 0) return
        event.preventDefault()
        setActiveHit((i) => (i + 1) % hits.length)
        return
      }
      if (event.key === "ArrowUp") {
        if (hits.length === 0) return
        event.preventDefault()
        setActiveHit((i) => (i <= 0 ? hits.length - 1 : i - 1))
        return
      }
      if (event.key === "Enter") {
        const hit = activeHit >= 0 ? hits[activeHit] : undefined
        if (hit) {
          event.preventDefault()
          choose(hit)
        }
      }
    },
    [hits, activeHit],
  )

  return { available, query, setQuery, hits, searching, error, activeHit, setActiveHit, keyDown, reset }
}
