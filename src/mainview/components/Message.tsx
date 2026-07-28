import {
  Bot,
  Brain,
  Check,
  ChevronRight,
  Copy,
  FileDiff,
  FileText,
  Folder,
  Loader2,
  RefreshCw,
  Search,
  Sparkles,
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
import { cn } from "~/lib/cn"
import { renderMarkdown } from "~/lib/markdown"
import { CodeBlock } from "./CodeBlock"
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
  const n = name.toLowerCase()
  if (n.includes("bash")) return Terminal
  if (n.includes("ffgrep") || n.includes("fffind")) return Search
  if (n.includes("read") || n.includes("write") || n.includes("edit")) return FileText
  if (n.includes("sidekick") || n.includes("spawn")) return Bot
  return Wrench
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

function ToolCard({ tool }: { tool: ToolBlockData }) {
  const [open, setOpen] = useState(false)
  const Icon = toolIcon(tool.name)
  const hasBody = !!(tool.inputJson || tool.output || tool.progress || tool.diff)
  return (
    <div className="my-2 overflow-hidden rounded-lg border border-border bg-card/50 shadow-xs">
      <button
        type="button"
        onClick={() => hasBody && setOpen((o) => !o)}
        className={cn(
          "flex w-full items-center gap-2 px-2.5 py-2 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/40",
          hasBody && "cursor-pointer hover:bg-accent/40",
        )}
      >
        <Icon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="shrink-0 font-medium text-[12.5px]">{tool.name}</span>
        {tool.inputPreview && (
          <span className="truncate font-mono text-[11.5px] text-muted-foreground">
            {tool.inputPreview}
          </span>
        )}
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
              className={cn("size-3.5 text-muted-foreground transition-transform", open && "rotate-90")}
            />
          )}
        </span>
      </button>
      {open && hasBody && (
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
      )}
    </div>
  )
}

function ThinkingCard({ label, steps }: { label: string; steps?: string[] }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="my-1.5">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-border bg-muted/40 px-2.5 py-1 font-medium text-[11.5px] text-muted-foreground outline-none transition-colors hover:border-ring/40 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
      >
        <Brain className="size-3 text-primary/70" />
        {label}
        <ChevronRight className={cn("size-3.5 transition-transform", open && "rotate-90")} />
      </button>
      {open && steps && steps.length > 0 && (
        <div className="mt-2 rounded-lg border border-border bg-muted/20 p-3 text-[12px] text-muted-foreground leading-relaxed">
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
  if (block.type === "tool" && block.tool) {
    return <ToolCard tool={block.tool} />
  }
  if (block.type === "files" && block.files) {
    return <ChangedFilesCard data={block.files} />
  }
  if (block.type === "code") {
    return <CodeBlock code={block.content} lang={block.lang} />
  }
  return (
    <div className={cn(bi > 0 && "mt-3")}>
      {renderMarkdown(block.content)}
      {streaming && last && (
        <span className="ml-0.5 inline-block h-[1.05em] w-[2px] translate-y-[2px] animate-caret bg-primary align-text-bottom" />
      )}
    </div>
  )
}

export function MessageView({ message, streaming }: { message: Message; streaming?: boolean }) {
  const [copied, setCopied] = useState(false)
  const isUser = message.role === "user"

  const copyAll = () => {
    const text = message.blocks.map((b) => b.content).join("\n\n")
    try {
      void navigator.clipboard?.writeText(text)
    } catch {
      /* ignore */
    }
    setCopied(true)
    setTimeout(() => setCopied(false), 1400)
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
        {isUser ? <User className="size-4" /> : <Sparkles className="size-4" />}
      </div>

      <div className={cn("flex min-w-0 max-w-[min(62rem,100%)] flex-col gap-1.5", isUser && "items-end")}>
        <div className="flex items-center gap-2 px-0.5">
          <span className="font-semibold text-[13px]">{isUser ? "You" : "Chunky"}</span>
          {message.model && (
            <span className="rounded-full border border-border bg-muted/60 px-2 py-0.5 font-medium text-[11px] text-muted-foreground">
              {message.model}
            </span>
          )}
        </div>

        {isUser ? (
          <div className="rounded-2xl bg-foreground/[0.06] px-4 py-2.5 text-[14px] leading-[1.6] text-foreground">
            {message.blocks.map((block, bi) => (
              <p key={bi} className={cn("whitespace-pre-wrap", bi > 0 && "mt-3")}>
                {block.content}
              </p>
            ))}
          </div>
        ) : (
          <div className="w-full">
            {message.blocks.map((block, bi) => (
              <AssistantBlock
                key={bi}
                block={block}
                bi={bi}
                streaming={streaming}
                last={bi === message.blocks.length - 1}
              />
            ))}
          </div>
        )}

        {!isUser && !streaming && (
          <div className="flex items-center gap-0.5 px-0.5 opacity-0 transition-opacity group-hover/msg:opacity-100">
            <button
              type="button"
              onClick={copyAll}
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
