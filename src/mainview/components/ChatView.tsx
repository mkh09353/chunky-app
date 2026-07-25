import {
  ChevronDown,
  GitPullRequest,
  Info,
  MoreHorizontal,
  PanelRightOpen,
  Share2,
  Sparkles,
} from "lucide-react"
import { useEffect, useRef } from "react"
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
          <Button variant="outline" size="sm" className="gap-1.5 rounded-r-none border-r-0">
            <GitPullRequest className="size-3.5" />
            <span className="hidden lg:inline">View PR</span>
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="outline"
                  size="sm"
                  aria-label="PR actions"
                  className="rounded-l-none px-1.5"
                />
              }
            >
              <ChevronDown className="size-3.5" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem>Copy PR link</DropdownMenuItem>
              <DropdownMenuItem>View diff</DropdownMenuItem>
              <DropdownMenuItem>Request review…</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem>Merge when ready</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
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
            <DropdownMenuItem>Rename thread</DropdownMenuItem>
            <DropdownMenuItem>Duplicate</DropdownMenuItem>
            <DropdownMenuItem>Export as Markdown</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive">Delete thread</DropdownMenuItem>
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
  compacted = 0,
}: {
  thread: Thread
  project?: Project
  streamingId: string | null
  headerRight?: React.ReactNode
  loading?: boolean
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
