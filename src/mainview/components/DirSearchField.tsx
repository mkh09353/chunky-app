// The "find a project" field: one search box plus the listbox of matching
// folders. Lifted out of RepoTabs so the Zoo's area dialog offers the exact
// same discovery instead of a second, worse one. State lives in
// hooks/useDirSearch.ts; the search itself is bun-main RPC (lib/dirSearch.ts).

import { Loader2, Search } from "lucide-react"
import { useId, type RefObject } from "react"
import { cn } from "~/lib/cn"
import type { DirSearchHit } from "~/lib/dirSearch"
import { compactPath } from "~/lib/format"
import type { DirSearch } from "~/hooks/useDirSearch"

export function DirSearchField({
  search,
  onChoose,
  label = "Find a project",
  placeholder = "e.g. budg, chunky-site",
  emptyHint = "No folders matched. Try another name.",
  disabled = false,
  inputRef,
  className,
}: {
  search: DirSearch
  /** What picking a folder means to the caller (add it, fill a field, …). */
  onChoose: (hit: DirSearchHit) => void
  label?: string | null
  placeholder?: string
  emptyHint?: string
  disabled?: boolean
  inputRef?: RefObject<HTMLInputElement | null>
  className?: string
}) {
  const listboxId = useId()
  const { query, hits, searching, error, activeHit } = search

  return (
    <div className={className}>
      {label && (
        <label className="mb-1 block font-medium text-[10px] text-muted-foreground uppercase tracking-wide">
          {label}
        </label>
      )}
      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <input
          ref={inputRef}
          value={query}
          spellCheck={false}
          disabled={disabled}
          placeholder={placeholder}
          onChange={(event) => search.setQuery(event.target.value)}
          onKeyDown={(event) => search.keyDown(event, onChoose)}
          aria-controls={listboxId}
          aria-autocomplete="list"
          aria-activedescendant={activeHit >= 0 ? `${listboxId}-opt-${activeHit}` : undefined}
          className="h-9 w-full min-w-0 rounded-lg border border-border bg-background py-0 pr-2.5 pl-8 text-[12px] text-foreground outline-none transition-colors placeholder:text-muted-foreground/70 focus-visible:border-ring/50 focus-visible:ring-2 focus-visible:ring-ring/25"
        />
      </div>

      {(query.trim() || searching || error) && (
        <div
          id={listboxId}
          role="listbox"
          aria-label="Matching folders"
          className="mt-1.5 max-h-40 overflow-y-auto rounded-lg border border-border/80 bg-background/60"
        >
          {searching && hits.length === 0 && (
            <div className="flex items-center gap-2 px-2.5 py-2 text-[11px] text-muted-foreground">
              <Loader2 className="size-3 animate-spin" />
              Searching…
            </div>
          )}
          {!searching && error && (
            <div className="px-2.5 py-2 text-[11px] text-destructive">{error}</div>
          )}
          {!searching && !error && query.trim() && hits.length === 0 && (
            <div className="px-2.5 py-2 text-[11px] text-muted-foreground">{emptyHint}</div>
          )}
          {hits.map((hit, i) => {
            const active = i === activeHit
            return (
              <button
                key={hit.path}
                id={`${listboxId}-opt-${i}`}
                type="button"
                role="option"
                aria-selected={active}
                disabled={disabled}
                onMouseEnter={() => search.setActiveHit(i)}
                onClick={() => onChoose(hit)}
                onDoubleClick={() => onChoose(hit)}
                className={cn(
                  "flex w-full cursor-pointer flex-col gap-0.5 px-2.5 py-1.5 text-left outline-none transition-colors",
                  active ? "bg-accent text-accent-foreground" : "hover:bg-accent/60",
                )}
              >
                <span className="truncate font-medium text-[12px]">{hit.name}</span>
                <span
                  className={cn(
                    "truncate font-mono text-[10px]",
                    active ? "text-accent-foreground/70" : "text-muted-foreground",
                  )}
                  title={hit.path}
                >
                  {compactPath(hit.path)}
                </span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
