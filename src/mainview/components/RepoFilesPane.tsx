import { ArrowLeft, ChevronRight, Clipboard, File, Folder, LoaderCircle, RefreshCw, X } from "lucide-react"
import { useCallback, useEffect, useRef, useState } from "react"
import type { FileSearchItem } from "@chunky/protocol"
import { searchFiles, type Repo } from "~/lib/api"
import { copyText } from "~/lib/clipboard"
import { cn } from "~/lib/cn"
import { NO_DRAG_REGION } from "~/lib/dragRegion"
import { clampPaneWidth, MIN_PANE_WIDTH, maxPaneWidth, persistPaneWidth, readPaneWidth, readPreferredPaneWidth } from "~/lib/browserPaneWidth"
import { buildRepoFilesQuery, filterAndSortRepoFiles, normalizeRepoPath } from "~/lib/repoFiles"
import { Button } from "./ui/button"

function isDirectory(item: FileSearchItem): boolean { return item.kind === "directory" }

export function RepoFilesPane({ repo, baseUrl, onClose }: { repo: Repo; baseUrl: string; onClose: () => void }) {
  const [width, setWidth] = useState(() => readPaneWidth(window.innerWidth))
  const [maxWidth, setMaxWidth] = useState(() => maxPaneWidth(window.innerWidth))
  const [query, setQuery] = useState("")
  const [directory, setDirectory] = useState("")
  const [items, setItems] = useState<FileSearchItem[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const sequence = useRef(0)
  const drag = useRef<{ id: number; x: number; width: number } | null>(null)
  const widthRef = useRef(width)

  useEffect(() => { widthRef.current = width }, [width])
  useEffect(() => {
    const onResize = () => {
      setMaxWidth(maxPaneWidth(window.innerWidth))
      setWidth(clampPaneWidth(readPreferredPaneWidth(window.innerWidth), window.innerWidth))
    }
    window.addEventListener("resize", onResize)
    return () => window.removeEventListener("resize", onResize)
  }, [])

  const refresh = useCallback(() => {
    const request = ++sequence.current
    setLoading(true)
    setError(null)
    void searchFiles(baseUrl, buildRepoFilesQuery(directory, query), repo.id, 50)
      .then((next) => {
        if (request === sequence.current) setItems(filterAndSortRepoFiles(next, directory))
      })
      .catch((reason) => {
        if (request === sequence.current) setError(reason instanceof Error ? reason.message : "Quick files search failed")
      })
      .finally(() => {
        if (request === sequence.current) setLoading(false)
      })
  }, [baseUrl, directory, query, repo.id])

  useEffect(() => {
    const timer = window.setTimeout(refresh, 180)
    return () => window.clearTimeout(timer)
  }, [refresh])

  const beginResize = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    drag.current = { id: event.pointerId, x: event.clientX, width: widthRef.current }
  }
  const moveResize = (event: React.PointerEvent<HTMLDivElement>) => {
    const current = drag.current
    if (current?.id === event.pointerId) setWidth(clampPaneWidth(current.width - (event.clientX - current.x), window.innerWidth))
  }
  const endResize = (event: React.PointerEvent<HTMLDivElement>) => {
    if (drag.current?.id !== event.pointerId) return
    drag.current = null
    persistPaneWidth(widthRef.current)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
  }
  const resizeByKeyboard = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return
    event.preventDefault()
    const step = (event.shiftKey ? 64 : 16) * (event.key === "ArrowLeft" ? 1 : -1)
    const next = clampPaneWidth(widthRef.current + step, window.innerWidth)
    setWidth(next)
    persistPaneWidth(next)
  }
  const copy = async (item: FileSearchItem) => {
    const path = normalizeRepoPath(item.path)
    if (await copyText(path)) {
      setCopied(path)
      window.setTimeout(() => setCopied((current) => current === path ? null : current), 1500)
    }
  }
  const goUp = () => setDirectory(directory.split("/").slice(0, -1).join("/"))

  return (
    <aside className="relative flex min-h-0 min-w-[20rem] flex-none flex-col border-border/70 border-l bg-background/70" style={{ width }} aria-label={`Quick files for ${repo.name}`}>
      <div role="separator" tabIndex={0} aria-label="Resize quick files pane" aria-valuemin={MIN_PANE_WIDTH} aria-valuemax={maxWidth} aria-valuenow={Math.round(width)} onPointerDown={beginResize} onPointerMove={moveResize} onPointerUp={endResize} onPointerCancel={endResize} onKeyDown={resizeByKeyboard} className={cn(NO_DRAG_REGION, "group absolute inset-y-0 -left-2 z-20 w-4 cursor-col-resize touch-none outline-none")}>
        <span aria-hidden className="pointer-events-none absolute inset-y-0 left-2 w-px bg-transparent transition-colors group-hover:bg-primary/60 group-focus-visible:bg-primary/60" />
      </div>
      <header className={cn(NO_DRAG_REGION, "flex h-[52px] shrink-0 items-center gap-2 border-border/70 border-b px-3")}>
        <Folder className="size-4 shrink-0 text-primary" />
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium" title={repo.name}>{repo.name}</span>
        <Button variant="ghost" size="icon-sm" onClick={refresh} aria-label="Refresh quick files"><RefreshCw className={cn("size-3.5", loading && "animate-spin")} /></Button>
        <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close quick files"><X /></Button>
      </header>
      <div className={cn(NO_DRAG_REGION, "flex min-w-0 flex-col gap-2 border-border/70 border-b p-3")}>
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find indexed files" aria-label="Find indexed files" className="h-8 min-w-0 rounded-lg border border-input bg-muted/30 px-2.5 text-[12px] outline-none focus:border-ring focus:ring-[3px] focus:ring-ring/25" />
        <div className="flex min-w-0 items-center gap-2 text-[11px] text-muted-foreground">
          <Button variant="ghost" size="icon-sm" disabled={!directory} onClick={goUp} aria-label="Up one directory"><ArrowLeft className="size-3.5" /></Button>
          <span className="min-w-0 truncate">Repository root{directory ? ` / ${directory}` : ""}</span>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {loading && !items.length ? <div className="flex items-center gap-2 p-3 text-[12px] text-muted-foreground"><LoaderCircle className="size-3.5 animate-spin" />Searching indexed files…</div> : error ? <p className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-[12px] text-destructive">{error}</p> : !items.length ? <p className="p-3 text-[12px] text-muted-foreground">No indexed files found.</p> : items.map((item) => {
          const path = normalizeRepoPath(item.path)
          const name = path.split("/").pop() || path
          const directoryItem = isDirectory(item)
          return <div key={path} className="group flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 hover:bg-accent"><button type="button" disabled={!directoryItem} onClick={() => directoryItem && setDirectory(path)} className={cn("flex min-w-0 flex-1 items-center gap-2 text-left text-[12px]", directoryItem && "cursor-pointer")}><span className="shrink-0 text-primary">{directoryItem ? <Folder className="size-3.5" /> : <File className="size-3.5" />}</span><span className="min-w-0 truncate" title={path}>{name}</span>{directoryItem && <ChevronRight className="ml-auto size-3 shrink-0 text-muted-foreground" />}</button>{!directoryItem && <Button variant="ghost" size="icon-sm" onClick={() => void copy(item)} aria-label={`Copy ${path}`} className="size-6 shrink-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"><Clipboard className="size-3" /></Button>}</div>
        })}
      </div>
      <span role="status" aria-live="polite" className="sr-only">{copied ? `Copied ${copied}` : ""}</span>
    </aside>
  )
}
