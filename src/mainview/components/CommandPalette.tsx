import { CornerDownLeft, Search } from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"
import { PALETTE_ACTIONS, type PaletteAction } from "~/lib/mock"
import { cn } from "~/lib/cn"
import { Dialog, DialogPopup } from "./ui/dialog"
import { Kbd } from "./ui/kbd"

export function CommandPalette({
  open,
  onOpenChange,
  onRun,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onRun: (action: PaletteAction) => void
}) {
  const [query, setQuery] = useState("")
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  const results = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return PALETTE_ACTIONS
    return PALETTE_ACTIONS.filter((a) => a.label.toLowerCase().includes(q))
  }, [query])

  useEffect(() => {
    if (open) {
      setQuery("")
      setActive(0)
    }
  }, [open])

  useEffect(() => {
    setActive(0)
  }, [query])

  const groups = useMemo(() => {
    const map = new Map<string, PaletteAction[]>()
    for (const a of results) {
      const arr = map.get(a.group) ?? []
      arr.push(a)
      map.set(a.group, arr)
    }
    return [...map.entries()]
  }, [results])

  const run = (a: PaletteAction | undefined) => {
    if (!a) return
    onRun(a)
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup
        showClose={false}
        className="top-[18%] max-w-xl translate-y-0 overflow-hidden p-0"
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault()
            setActive((i) => Math.min(i + 1, results.length - 1))
          } else if (e.key === "ArrowUp") {
            e.preventDefault()
            setActive((i) => Math.max(i - 1, 0))
          } else if (e.key === "Enter") {
            e.preventDefault()
            run(results[active])
          }
        }}
      >
        <div className="flex items-center gap-2.5 border-border/70 border-b px-4">
          <Search className="size-4 shrink-0 text-muted-foreground" />
          <input
            ref={inputRef}
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Type a command or search…"
            className="h-12 w-full bg-transparent text-[14px] text-foreground outline-none placeholder:text-muted-foreground/70"
          />
          <Kbd>esc</Kbd>
        </div>

        <div className="max-h-[min(60vh,26rem)] overflow-y-auto p-2">
          {results.length === 0 ? (
            <p className="px-3 py-8 text-center text-muted-foreground text-sm">
              No results for “{query}”
            </p>
          ) : (
            groups.map(([group, items]) => (
              <div key={group} className="mb-1">
                <p className="px-2.5 py-1.5 font-medium text-[11px] text-muted-foreground uppercase tracking-wide">
                  {group}
                </p>
                {items.map((a) => {
                  const idx = results.indexOf(a)
                  const isActive = idx === active
                  return (
                    <button
                      key={a.id}
                      type="button"
                      onMouseMove={() => setActive(idx)}
                      onClick={() => run(a)}
                      className={cn(
                        "flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] outline-none transition-colors",
                        isActive ? "bg-accent text-accent-foreground" : "text-foreground/80",
                      )}
                    >
                      <span className="flex-1 truncate">{a.label}</span>
                      {a.hint && <Kbd>{a.hint}</Kbd>}
                      {isActive && <CornerDownLeft className="size-3.5 text-muted-foreground" />}
                    </button>
                  )
                })}
              </div>
            ))
          )}
        </div>

        <div className="flex items-center gap-3 border-border/70 border-t px-4 py-2 text-[11px] text-muted-foreground">
          <span className="flex items-center gap-1">
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd>
            navigate
          </span>
          <span className="flex items-center gap-1">
            <Kbd>⏎</Kbd>
            select
          </span>
          <span className="ml-auto flex items-center gap-1.5">
            <span className="flex size-4 items-center justify-center rounded bg-primary font-bold text-[9px] text-primary-foreground">
              C
            </span>
            Chunky
          </span>
        </div>
      </DialogPopup>
    </Dialog>
  )
}
