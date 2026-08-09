import {
  Bell,
  Bot,
  Brain,
  Check,
  ChevronRight,
  Copy,
  FileDiff,
  FileText,
  Folder,
  Loader2,
  Paperclip,
  RefreshCw,
  Search,
  Terminal,
  ThumbsDown,
  ThumbsUp,
  User,
  Wrench,
  X,
} from "lucide-react"
import { useState } from "react"
import type {
  ChangedFiles,
  FileDiff as FileDiffData,
  Message,
  MessageBlock,
  ToolBlockData,
} from "~/lib/mock"
import chunkyLogo from "~/assets/chunky-logo.png"
import type { ToolSummary } from "~/lib/toolSummary"
import { groupStatus, groupSummary, toolKind } from "~/lib/toolSummary"
import { cn } from "~/lib/cn"
import { Markdown } from "~/lib/markdown"
import { CodeBlock } from "./CodeBlock"
import { LiveRunSection, useLiveRuns } from "./LiveRun"
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip"

/** Collapsible "Worked for 3m 11s ›" divider between the prompt and the reply. */
function WorkedRow({ duration, steps }: { duration: string; steps?: string[] }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="my-1.5">
      <div className="flex items-center gap-3">
        <span className="h-px flex-1 bg-border" />
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-border bg-card/70 px-2.5 py-1 font-medium text-[11.5px] text-muted-foreground outline-none transition-colors hover:border-ring/40 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
        >
          <Check className="size-3 text-success" />
          Worked for {duration}
          <ChevronRight className={cn("size-3.5 transition-transform", open && "rotate-90")} />
        </button>
        <span className="h-px flex-1 bg-border" />
      </div>
      {open && steps && (
        <ul className="mt-2 flex flex-col gap-1.5 rounded-lg border border-border bg-muted/30 p-3">
          {steps.map((s, i) => (
            <li key={i} className="flex items-center gap-2 text-[12px] text-muted-foreground">
              <Check className="size-3 shrink-0 text-success/80" />
              {s}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function DiffBar({ added, removed }: { added: number; removed: number }) {
  const total = added + removed || 1
  const greens = Math.max(0, Math.min(5, Math.round((added / total) * 5)))
  return (
    <span className="flex items-center gap-px">
      {Array.from({ length: 5 }).map((_, i) => (
        <span
          key={i}
          className={cn(
            "size-[7px] rounded-[2px]",
            i < greens ? "bg-success" : "bg-destructive/70",
          )}
        />
      ))}
    </span>
  )
}

function ChangedFilesCard({ data }: { data: ChangedFiles }) {
  const [open, setOpen] = useState(true)
  return (
    <div className="my-3 overflow-hidden rounded-xl border border-border bg-card/50 shadow-xs">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full cursor-pointer items-center gap-2 px-3 py-2.5 text-left outline-none transition-colors hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring/40"
      >
        <ChevronRight
          className={cn("size-3.5 text-muted-foreground transition-transform", open && "rotate-90")}
        />
        <FileDiff className="size-3.5 text-muted-foreground" />
        <span className="font-medium text-[13px]">{data.total} changed files</span>
        <span className="ml-auto flex items-center gap-2.5 font-mono text-[12px] tabular-nums">
          <span className="text-success">+{data.added}</span>
          <span className="text-destructive">−{data.removed}</span>
        </span>
      </button>
      {open && (
        <div className="border-border border-t">
          {data.files.map((f, i) => (
            <div
              key={i}
              className="flex items-center gap-2 border-border/50 px-3 py-1.5 text-[12.5px] last:border-b-0 [&:not(:last-child)]:border-b hover:bg-accent/30"
            >
              <Folder className="size-3.5 shrink-0 text-muted-foreground/70" />
              <span className="truncate font-mono text-muted-foreground">{f.path}</span>
              <span className="ml-auto flex shrink-0 items-center gap-2.5 font-mono text-[11.5px] tabular-nums">
                <span className="text-success">+{f.added}</span>
                <span className="text-destructive">−{f.removed}</span>
                <DiffBar added={f.added} removed={f.removed} />
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function IconButton({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            // The row is reachable by keyboard (focus reveals it), so each
            // button needs a name a screen reader can read — the tooltip alone
            // is a hover affordance.
            aria-label={label}
            className="inline-flex size-7 cursor-pointer items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 [&_svg]:size-3.5"
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipPopup>{label}</TooltipPopup>
    </Tooltip>
  )
}

function toolIcon(name: string) {
  switch (toolKind(name)) {
    case "bash":
      return Terminal
    case "search":
      return Search
    case "read":
    case "write":
    case "edit":
      return FileText
    case "delegate":
      return Bot
    default:
      return Wrench
  }
}

/** Icon for a whole activity group: the family it is made of, or a generic
 *  wrench once it is mixed. */
function groupIcon(tools: ToolBlockData[]) {
  const first = tools[0]
  if (!first) return Wrench
  const kind = toolKind(first.name)
  return tools.every((tool) => toolKind(tool.name) === kind) ? toolIcon(first.name) : Wrench
}

/** What a call did, in words: dim verb + the argument that matters. */
function ToolSummaryLine({
  summary,
  withLabel = true,
}: {
  summary: ToolSummary
  /** The standalone card already names the tool, so it drops the verb. */
  withLabel?: boolean
}) {
  return (
    <>
      {withLabel && <span className="shrink-0 text-muted-foreground">{summary.label}</span>}
      {summary.detail && (
        <span
          className={cn(
            "min-w-0 truncate text-[11.5px] text-muted-foreground",
            summary.mono && "font-mono",
          )}
        >
          {summary.detail}
        </span>
      )}
    </>
  )
}

function DiffView({ diff }: { diff: FileDiffData }) {
  return (
    <div className="overflow-hidden rounded-md border border-border bg-background/60 font-mono text-[11.5px] leading-[1.55]">
      {diff.path && (
        <div className="flex items-center gap-2 border-border/70 border-b bg-muted/40 px-2.5 py-1.5">
          <FileDiff className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate text-muted-foreground">{diff.path}</span>
          <span className="ml-auto flex shrink-0 items-center gap-2 tabular-nums">
            <span className="text-success">+{diff.added}</span>
            <span className="text-destructive">−{diff.removed}</span>
          </span>
        </div>
      )}
      <div className="overflow-x-auto">
        {diff.lines.map((l, i) => (
          <div
            key={i}
            className={cn(
              "whitespace-pre px-2.5",
              l.kind === "add" && "bg-success/12",
              l.kind === "del" && "bg-destructive/12",
              l.kind === "context" && "text-muted-foreground",
            )}
          >
            <span
              className={cn(
                "select-none pr-2",
                l.kind === "add"
                  ? "text-success"
                  : l.kind === "del"
                    ? "text-destructive"
                    : "text-muted-foreground/40",
              )}
            >
              {l.kind === "add" ? "+" : l.kind === "del" ? "-" : " "}
            </span>
            {l.text || " "}
          </div>
        ))}
        {diff.truncated && <div className="px-2.5 py-1 text-muted-foreground/70">… truncated</div>}
      </div>
    </div>
  )
}

function ToolStatus({ tool }: { tool: ToolBlockData }) {
  if (!tool.done) return <Loader2 className="size-3.5 animate-spin text-primary" />
  if (tool.ok === false) return <X className="size-3.5 text-destructive" />
  return <Check className="size-3.5 text-success" />
}

/** Aggregate status of an activity group: waiting, then failed, then done. */
function GroupStatus({ tools }: { tools: ToolBlockData[] }) {
  const status = groupStatus(tools)
  if (status === "running") return <Loader2 className="size-3.5 animate-spin text-primary" />
  if (status === "failed") return <X className="size-3.5 text-destructive" />
  return <Check className="size-3.5 text-success" />
}

/** Is there anything to reveal when this call is expanded? */
function toolHasBody(tool: ToolBlockData): boolean {
  return !!(tool.inputJson || tool.output || tool.progress || tool.diff)
}

/** The full detail of one call — diff, raw arguments, progress, output. Shared
 *  by the standalone card and by a row inside an activity group. */
function ToolDetail({ tool }: { tool: ToolBlockData }) {
  return (
    <div className="flex flex-col gap-2 border-border border-t bg-muted/20 p-2.5">
      {tool.diff && <DiffView diff={tool.diff} />}
      {tool.inputJson && (
        <pre className="max-h-72 overflow-auto rounded-md border border-border bg-background/60 p-2 font-mono text-[11px] leading-relaxed text-muted-foreground">
          {tool.inputJson}
        </pre>
      )}
      {!tool.done && tool.progress && (
        <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-background/60 p-2 font-mono text-[11px] leading-relaxed text-muted-foreground">
          {tool.progress}
        </pre>
      )}
      {tool.output && (
        <pre
          className={cn(
            "max-h-72 overflow-auto whitespace-pre-wrap rounded-md border p-2 font-mono text-[11px] leading-relaxed",
            tool.ok === false
              ? "border-destructive/30 bg-destructive/5 text-foreground"
              : "border-border bg-background/60 text-muted-foreground",
          )}
        >
          {tool.output}
        </pre>
      )}
    </div>
  )
}

/** One call inside an expanded activity group: its summary line, click-expanded
 *  to exactly the detail the standalone card shows. */
function ToolGroupRow({ tool }: { tool: ToolBlockData }) {
  const [open, setOpen] = useState(false)
  const Icon = toolIcon(tool.name)
  const hasBody = toolHasBody(tool)
  return (
    <div className="border-border/50 [&:not(:last-child)]:border-b">
      <button
        type="button"
        onClick={() => hasBody && setOpen((o) => !o)}
        className={cn(
          "flex w-full items-center gap-2 px-2.5 py-1.5 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/40",
          hasBody && "cursor-pointer hover:bg-accent/30",
        )}
      >
        <Icon className="size-3.5 shrink-0 text-muted-foreground/70" />
        <span className="flex min-w-0 items-center gap-1.5 text-[11.5px]">
          <ToolSummaryLine summary={tool.summary} />
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-2">
          {tool.diff && (
            <span className="flex items-center gap-1.5 font-mono text-[11px] tabular-nums">
              <span className="text-success">+{tool.diff.added}</span>
              <span className="text-destructive">−{tool.diff.removed}</span>
            </span>
          )}
          <ToolStatus tool={tool} />
          {hasBody && (
            <ChevronRight
              className={cn(
                "size-3.5 text-muted-foreground transition-transform",
                open && "rotate-90",
              )}
            />
          )}
        </span>
      </button>
      {open && hasBody && <ToolDetail tool={tool} />}
    </div>
  )
}

/** Consecutive plain tool calls, folded into one secondary activity line.
 *
 *  Collapsed it is a single row ("Ran 6 commands ✓"), so the assistant's prose
 *  keeps the page. While the newest call is still in flight the group shows
 *  that one line under the header — enough to see the agent working — and
 *  drops back to the single line once everything has settled. */
function ToolGroupCard({ tools }: { tools: ToolBlockData[] }) {
  const [open, setOpen] = useState(false)
  const Icon = groupIcon(tools)
  const last = tools[tools.length - 1]
  const running = !!last && !last.done
  return (
    <div className="my-2 overflow-hidden rounded-lg border border-border/60 bg-muted/20">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left outline-none transition-colors hover:bg-accent/30 focus-visible:ring-2 focus-visible:ring-ring/40"
      >
        <Icon className="size-3.5 shrink-0 text-muted-foreground/70" />
        <span className="truncate font-medium text-[12px] text-muted-foreground">
          {groupSummary(tools)}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-2">
          <GroupStatus tools={tools} />
          <ChevronRight
            className={cn(
              "size-3.5 text-muted-foreground transition-transform",
              open && "rotate-90",
            )}
          />
        </span>
      </button>
      {!open && running && last && (
        // Live activity: the call currently in flight, one line, no controls.
        <div className="flex items-center gap-2 border-border/50 border-t px-2.5 py-1.5 text-[11.5px]">
          <Loader2 className="size-3 shrink-0 animate-spin text-primary" />
          <span className="flex min-w-0 items-center gap-1.5">
            <ToolSummaryLine summary={last.summary} />
          </span>
        </div>
      )}
      {open && (
        <div className="flex flex-col border-border/50 border-t">
          {tools.map((tool, i) => (
            <ToolGroupRow key={`${tool.id}:${i}`} tool={tool} />
          ))}
        </div>
      )}
    </div>
  )
}

function ToolCard({
  tool,
  runId,
  runIds,
  settledRunIds,
  accent,
}: {
  tool: ToolBlockData
  /** Present when this call spawned a delegate: the run it owns. */
  runId?: string
  /** Runs spawned by this call that are still in flight: each streams a live
   *  tail inside the card until it settles. */
  runIds?: string[]
  /** Runs spawned by this call that have finished: their whole transcript is
   *  reachable from this card's expanded body. */
  settledRunIds?: string[]
  accent?: string
}) {
  const [open, setOpen] = useState(false)
  // Everything this pill's delegates need: the live tails while they run, the
  // run records that name them, and the renderer for their full transcript.
  const { views, elapsedOf, runs, renderRunDetail } = useLiveRuns()
  const live = (runIds ?? (runId ? [runId] : []))
    .map((id) => views.get(id))
    .filter((view): view is NonNullable<typeof view> => !!view)
  const settled = (settledRunIds ?? [])
    .map((id) => runs.get(id))
    .filter((run): run is NonNullable<typeof run> => !!run)
  const delegate = live.length > 0 || settled.length > 0
  const detailIds = renderRunDetail ? settled.map((run) => run.id) : []
  const hasBody = toolHasBody(tool) || detailIds.length > 0
  const expandable = hasBody || live.length > 0

  // A delegate pill says who ran, not what JSON went in: the brief itself is
  // in the expanded detail, and the run's own title is what the reader tracks.
  const title = live[0]?.title ?? settled[0]?.title
  const toolCount =
    live.reduce((sum, view) => sum + view.toolCount, 0) +
    settled.reduce((sum, run) => sum + run.toolCount, 0)
  const Icon = toolIcon(tool.name)

  return (
    <div
      {...(runId ? { "data-run-pill": runId } : {})}
      style={accent ? { borderLeftColor: accent } : undefined}
      className={cn(
        "my-2 overflow-hidden rounded-lg border border-border bg-card/50 shadow-xs transition-colors",
        accent && "border-l-2",
        live.length > 0 && "border-primary/30",
      )}
    >
      <button
        type="button"
        onClick={() => expandable && setOpen((o) => !o)}
        className={cn(
          "flex w-full items-center gap-2 px-2.5 py-2 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/40",
          expandable && "cursor-pointer hover:bg-accent/40",
        )}
      >
        <Icon className="size-3.5 shrink-0 text-muted-foreground" />
        {delegate && title ? (
          <>
            <span className="min-w-0 truncate font-medium text-[12.5px]">{title}</span>
            {toolCount > 0 && (
              <span className="shrink-0 text-[11px] text-muted-foreground">
                {toolCount} tool{toolCount === 1 ? "" : "s"}
              </span>
            )}
          </>
        ) : (
          <>
            <span className="shrink-0 font-medium text-[12.5px]">{tool.name}</span>
            {/* The card already names the tool, so the summary drops its verb
                and shows only the argument that matters. */}
            <ToolSummaryLine summary={tool.summary} withLabel={false} />
          </>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-2">
          {tool.diff && (
            <span className="flex items-center gap-1.5 font-mono text-[11px] tabular-nums">
              <span className="text-success">+{tool.diff.added}</span>
              <span className="text-destructive">−{tool.diff.removed}</span>
            </span>
          )}
          <ToolStatus tool={tool} />
          {expandable && (
            <ChevronRight
              className={cn("size-3.5 text-muted-foreground transition-transform", open && "rotate-90")}
            />
          )}
        </span>
      </button>
      {/* Watch it work: the tail streams here while the run is in flight and
          disappears of its own accord the moment the run settles — at which
          point the same delegate is readable in full below. */}
      {live.map((view) => (
        <LiveRunSection
          key={view.runId}
          view={view}
          {...(elapsedOf(view.runId) != null ? { elapsedMs: elapsedOf(view.runId)! } : {})}
          expanded={open}
        />
      ))}
      {open && toolHasBody(tool) && <ToolDetail tool={tool} />}
      {open &&
        detailIds.map((id) => (
          <div key={id} className="border-border border-t bg-muted/20 p-2">
            {renderRunDetail!(id)}
          </div>
        ))}
    </div>
  )
}

/** Reasoning, folded to one quiet line — the same activity card as a tool
 *  group, so everything the agent did between two paragraphs of prose reads as
 *  one visual family: muted text, subtle border, chevron, detail on demand. */
function ThinkingCard({ label, steps }: { label: string; steps?: string[] }) {
  const [open, setOpen] = useState(false)
  const hasSteps = !!steps && steps.length > 0
  return (
    <div className="my-2 overflow-hidden rounded-lg border border-border/60 bg-muted/20">
      <button
        type="button"
        onClick={() => hasSteps && setOpen((o) => !o)}
        className={cn(
          "flex w-full items-center gap-2 px-2.5 py-1.5 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/40",
          hasSteps && "cursor-pointer hover:bg-accent/30",
        )}
      >
        <Brain className="size-3.5 shrink-0 text-muted-foreground/70" />
        <span className="truncate font-medium text-[12px] text-muted-foreground">{label}</span>
        {hasSteps && (
          <ChevronRight
            className={cn(
              "ml-auto size-3.5 shrink-0 text-muted-foreground transition-transform",
              open && "rotate-90",
            )}
          />
        )}
      </button>
      {open && hasSteps && (
        <div className="border-border/50 border-t p-2.5 text-[11.5px] text-muted-foreground leading-relaxed">
          {steps.map((s, i) => (
            <p key={i} className={cn(i > 0 && "mt-1.5")}>
              {s}
            </p>
          ))}
        </div>
      )}
    </div>
  )
}

function AssistantBlock({
  block,
  bi,
  streaming,
  last,
}: {
  block: MessageBlock
  bi: number
  streaming?: boolean
  last: boolean
}) {
  if (block.type === "worked") {
    return <WorkedRow duration={block.content} steps={block.steps} />
  }
  if (block.type === "thinking") {
    return <ThinkingCard label={block.content} steps={block.steps} />
  }
  if (block.type === "toolGroup" && block.tools && block.tools.length > 0) {
    return <ToolGroupCard tools={block.tools} />
  }
  if (block.type === "tool" && block.tool) {
    return (
      <ToolCard
        tool={block.tool}
        {...(block.runId ? { runId: block.runId } : {})}
        {...(block.runIds ? { runIds: block.runIds } : {})}
        {...(block.settledRunIds ? { settledRunIds: block.settledRunIds } : {})}
        {...(block.accent ? { accent: block.accent } : {})}
      />
    )
  }
  if (block.type === "files" && block.files) {
    return <ChangedFilesCard data={block.files} />
  }
  if (block.type === "code") {
    return <CodeBlock code={block.content} lang={block.lang} />
  }
  return (
    <div className={cn(bi > 0 && "mt-3")}>
      <Markdown source={block.content} />
      {streaming && last && (
        <span className="ml-0.5 inline-block h-[1.05em] w-[2px] translate-y-[2px] animate-caret bg-primary align-text-bottom" />
      )}
    </div>
  )
}

/** The action row is quiet by default and fades in on hover. It is NOT
 *  conditionally mounted — it holds its space at all times, so revealing it can
 *  never reflow the transcript (which would wake the bottom-follow observer
 *  mid-scroll). Focus-within covers keyboard users, and a pointer that cannot
 *  hover (touch) gets the row outright, since it would otherwise be
 *  unreachable. */
const ACTION_ROW_REVEAL =
  "opacity-0 transition-opacity group-hover/msg:opacity-100 group-focus-within/msg:opacity-100 [@media(hover:none)]:opacity-100"

export function MessageView({
  message,
  streaming,
  actionsPinned = false,
}: {
  message: Message
  streaming?: boolean
  /** Keep the actions visible without hovering — set on the answer that just
   *  landed, so what you can do with a reply is discoverable. */
  actionsPinned?: boolean
}) {
  const [copied, setCopied] = useState(false)
  const notice = message.notice
  // A notice is still a user-role item on the wire; it is just not something a
  // human said, so it never wears the "You" bubble.
  const isUser = message.role === "user" && !notice
  const blocks = message.blocks

  const copyAll = () => {
    const text = blocks.map((b) => b.content).join("\n\n")
    try {
      void navigator.clipboard?.writeText(text)
    } catch {
      /* ignore */
    }
    setCopied(true)
    setTimeout(() => setCopied(false), 1400)
  }

  if (notice) {
    return (
      <div className="flex min-w-0 px-1">
        {/* Indented to the text column (avatar 2rem + gap 0.875rem) so it reads
            as part of the conversation without claiming a speaker. */}
        <div className="ml-[2.875rem] flex min-w-0 max-w-[min(72rem,100%)] items-start gap-2 rounded-lg border border-border/60 bg-muted/30 px-3 py-2 text-[12.5px] leading-[1.5] text-muted-foreground">
          <Bell className="mt-[3px] size-3.5 shrink-0 opacity-70" />
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
            <span className="rounded-full border border-border bg-card/70 px-2 py-0.5 font-medium text-[10.5px] text-muted-foreground">
              {notice.from}
            </span>
            {blocks.map((block, bi) => (
              <p key={bi} className="min-w-0 whitespace-pre-wrap break-words">
                {block.content}
              </p>
            ))}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className={cn("group/msg flex gap-3.5 px-1", isUser && "flex-row-reverse")}>
      <div
        className={cn(
          "mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg border shadow-xs",
          isUser
            ? "border-border bg-card text-muted-foreground"
            : "border-primary/30 bg-primary/15 text-primary",
        )}
      >
        {isUser ? (
          <User className="size-4" />
        ) : (
          // The brand mark itself, not a generic glyph. 128px source rendered at
          // 26 — crisp on retina, and its transparent artwork sits on the same
          // tinted chip in both themes.
          <img
            src={chunkyLogo}
            alt=""
            aria-hidden="true"
            draggable={false}
            className="size-[26px] select-none object-contain"
          />
        )}
      </div>

      <div className={cn("flex min-w-0 max-w-[min(72rem,100%)] flex-col gap-1.5", isUser && "items-end")}>
        <div className="flex items-center gap-2 px-0.5">
          <span className="font-semibold text-[13px]">{isUser ? "You" : "Chunky"}</span>
          {message.model && (
            <span className="rounded-full border border-border bg-muted/60 px-2 py-0.5 font-medium text-[11px] text-muted-foreground">
              {message.model}
            </span>
          )}
        </div>

        {isUser ? (
          <div
            className={cn(
              "min-w-0 max-w-full rounded-2xl bg-foreground/[0.06] px-4 py-2.5 text-[14px] leading-[1.6] text-foreground",
              // Optimistic row: posted, not yet echoed back. Dimmed rather than
              // restyled, so the swap to the authoritative row is invisible.
              message.sending && "opacity-70",
              message.sendError && "ring-1 ring-destructive/40",
            )}
          >
            {blocks.map((block, bi) => (
              <p key={bi} className={cn("whitespace-pre-wrap break-words", bi > 0 && "mt-3")}>
                {block.content}
              </p>
            ))}
            {!!message.imageCount && (
              <div
                className={cn(
                  "flex items-center gap-1 text-[11px] leading-none text-muted-foreground",
                  blocks.some((block) => block.content) && "mt-2",
                )}
              >
                <Paperclip className="size-3" />
                <span>
                  {message.imageCount} {message.imageCount === 1 ? "image" : "images"}
                </span>
              </div>
            )}
            {message.sending && (
              <div className="mt-2 flex items-center gap-1 text-[11px] leading-none text-muted-foreground">
                <Loader2 className="size-3 animate-spin" />
                <span>Sending…</span>
              </div>
            )}
            {message.sendError && (
              <div className="mt-2 flex items-start gap-1 text-[11px] leading-tight text-destructive">
                <X className="mt-px size-3 shrink-0" />
                <span className="break-words">Not sent — {message.sendError}</span>
              </div>
            )}
          </div>
        ) : (
          <div className="w-full">
            {blocks.map((block, bi) => (
              <AssistantBlock
                key={bi}
                block={block}
                bi={bi}
                streaming={streaming}
                last={bi === blocks.length - 1}
              />
            ))}
          </div>
        )}

        {!isUser && !streaming && (
          <div
            className={cn(
              "flex items-center gap-0.5 px-0.5",
              actionsPinned ? "opacity-100" : ACTION_ROW_REVEAL,
            )}
          >
            <button
              type="button"
              onClick={copyAll}
              aria-label={copied ? "Copied" : "Copy message"}
              className={cn(
                "inline-flex size-7 cursor-pointer items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 [&_svg]:size-3.5",
                copied && "text-success",
              )}
            >
              {copied ? <Check /> : <Copy />}
            </button>
            <IconButton label="Regenerate">
              <RefreshCw />
            </IconButton>
            <IconButton label="Good response">
              <ThumbsUp />
            </IconButton>
            <IconButton label="Bad response">
              <ThumbsDown />
            </IconButton>
          </div>
        )}
      </div>
    </div>
  )
}
