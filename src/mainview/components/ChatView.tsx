import {
  ChevronDown,
  GitPullRequest,
  Info,
  MoreHorizontal,
  PanelRightOpen,
  Share2,
  Sparkles,
} from "lucide-react"
import { useEffect, useRef, useState } from "react"
import type { Repo } from "~/lib/api"
import type { Message, Project, Thread } from "~/lib/mock"
import { Button } from "./ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu"
import { RepoTabs } from "./RepoTabs"
import { ScrollArea } from "./ui/scroll-area"
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip"
import { MessageView } from "./Message"
import { childThreads, itemsToMessages } from "~/lib/mapTranscript"
import type { TranscriptState } from "~/lib/transcript"

/** Top chrome strip: repo tabs + compact thread title + actions. */
export function ChatTopBar({
  thread,
  repos,
  activeRepoId,
  onSelectRepo,
  onAddRepo,
  onRemoveRepo,
  reposBusy = false,
  reposDisabled = false,
  headerRight,
  onRename, onFork, onRewind, onGoal, onShip, onStats,
}: {
  thread: Thread
  /** Optional; when omitted, repo tabs are hidden (demo / offline). */
  repos?: Repo[]
  activeRepoId?: string | null
  onSelectRepo?: (id: string) => void
  onAddRepo?: (path: string) => Promise<void>
  onRemoveRepo?: (id: string) => void | Promise<void>
  reposBusy?: boolean
  reposDisabled?: boolean
  headerRight?: React.ReactNode
  onRename?: () => void; onFork?: () => void; onRewind?: () => void; onGoal?: () => void; onShip?: () => void; onStats?: () => void
}) {
  const showRepos =
    !!repos && !!onSelectRepo && !!onAddRepo && !!onRemoveRepo && repos.length >= 0

  return (
    <header className="app-drag flex h-[52px] shrink-0 items-center gap-3 px-3 text-sidebar-foreground sm:px-4">
      {showRepos ? (
        <RepoTabs
          repos={repos}
          activeId={activeRepoId ?? null}
          onSelect={onSelectRepo}
          onAdd={onAddRepo}
          onRemove={onRemoveRepo}
          busy={reposBusy}
          disabled={reposDisabled}
        />
      ) : (
        <div className="min-w-0 flex-1" />
      )}

      <div className="no-drag hidden min-w-0 max-w-[28%] items-center gap-1.5 md:flex">
        <span className="truncate text-[12px] text-muted-foreground" title={thread.title}>
          {thread.title}
        </span>
      </div>

      <div className="no-drag flex shrink-0 items-center gap-1.5">
        <div className="hidden items-stretch sm:flex">
          <Button variant="outline" size="sm" className="gap-1.5" onClick={onShip}><GitPullRequest className="size-3.5" /><span className="hidden lg:inline">Ship it</span></Button>
        </div>

        {headerRight}
        <Tooltip>
          <TooltipTrigger render={<Button variant="ghost" size="icon-sm" />}>
            <Share2 />
          </TooltipTrigger>
          <TooltipPopup>Share thread</TooltipPopup>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger render={<Button variant="ghost" size="icon-sm" />}>
            <PanelRightOpen />
          </TooltipTrigger>
          <TooltipPopup>Toggle panel</TooltipPopup>
        </Tooltip>
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" />}>
            <MoreHorizontal />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={onRename}>Rename session</DropdownMenuItem>
            <DropdownMenuItem onClick={onFork}>Fork session…</DropdownMenuItem>
            <DropdownMenuItem onClick={onRewind}>Rewind to turn…</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={onGoal}>Goal mode…</DropdownMenuItem>
            <DropdownMenuItem onClick={onShip}>Ship it…</DropdownMenuItem>
            <DropdownMenuItem onClick={onStats}>Usage & scoreboard</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  )
}

/** Transcript body only — lives inside the curved content panel. */
export function ChatView({
  thread,
  streamingId,
  loading = false,
  transcript,
  modelName,
  foldAll = false,
  compacted = 0,
}: {
  thread: Thread
  project?: Project
  streamingId: string | null
  headerRight?: React.ReactNode
  loading?: boolean
  transcript?: TranscriptState
  modelName?: string
  foldAll?: boolean
  compacted?: number
}) {
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [thread.messages.length, streamingId, loading])

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <ScrollArea className="flex-1" viewportRef={scrollRef} viewportClassName="scroll-smooth">
        <div className="mx-auto flex max-w-3xl flex-col gap-7 px-5 py-8">
          <div className="mx-auto mb-1 flex items-center gap-2 rounded-full border border-border bg-muted/40 px-3 py-1 text-[11px] text-muted-foreground">
            <Sparkles className="size-3 text-primary" />
            {loading ? "Loading transcript…" : "Chunky started this thread"}
          </div>
          {loading && thread.messages.length === 0 ? (
            <p className="py-12 text-center text-[13px] text-muted-foreground">
              Replaying session history…
            </p>
          ) : thread.messages.length === 0 ? (
            <p className="py-12 text-center text-[13px] text-muted-foreground">
              Send a message to begin.
            </p>
          ) : (
            thread.messages.map((m: Message) => (
              <MessageView key={m.id} message={m} streaming={m.id === streamingId} />
            ))
          )}
          {transcript && childThreads(transcript, "main").map((node) => (
            <ThreadCard key={node.id} nodeId={node.id} transcript={transcript} modelName={modelName} foldAll={foldAll} />
          ))}
          {compacted > 0 && (
            <div className="mx-auto flex items-center gap-2 rounded-full border border-border bg-muted/40 px-3 py-1 text-[11px] text-muted-foreground">
              <Info className="size-3" />
              Context compacted — older turns summarized{compacted > 1 ? ` · ×${compacted}` : ""}
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  )
}

function ThreadCard({ nodeId, transcript, modelName, foldAll }: { nodeId: string; transcript: TranscriptState; modelName?: string; foldAll: boolean }) {
  const node = transcript.threads[nodeId]!
  const [open, setOpen] = useState(!foldAll)
  useEffect(() => setOpen(!foldAll), [foldAll])
  const messages = itemsToMessages(node.items, node.model ?? modelName)
  return <section className="ml-4 overflow-hidden rounded-xl border border-primary/20 bg-primary/[0.035] shadow-xs sm:ml-8">
    <button type="button" onClick={() => setOpen((value) => !value)} className="flex w-full items-center gap-2 px-3 py-2.5 text-left hover:bg-primary/[0.06]">
      <ChevronDown className={`size-4 text-primary transition-transform ${open ? "" : "-rotate-90"}`} />
      <Sparkles className="size-3.5 text-primary" /><span className="min-w-0 flex-1 truncate text-[13px] font-semibold">{node.title}</span>
      {node.model && <span className="max-w-32 truncate rounded-full border border-border bg-card px-2 py-0.5 text-[10px] text-muted-foreground">{node.model}</span>}
      <span className={node.status === "running" ? "text-[11px] text-primary" : "text-[11px] text-muted-foreground"}>{node.status === "running" ? "Running" : "Idle"}</span>
    </button>
    {open && <div className="border-border/70 border-t px-3 py-3"><div className="flex flex-col gap-5">{messages.length ? messages.map((message) => <MessageView key={message.id} message={message} />) : <span className="text-[12px] text-muted-foreground">Waiting for work…</span>}{childThreads(transcript, node.id).map((child) => <ThreadCard key={child.id} nodeId={child.id} transcript={transcript} modelName={modelName} foldAll={foldAll} />)}</div></div>}
  </section>
}
