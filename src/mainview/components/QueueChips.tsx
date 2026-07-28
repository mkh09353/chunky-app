import { Clock } from "lucide-react"
import type { QueueEntry } from "@chunky/protocol"
import { cn } from "~/lib/cn"

const KIND_TONE: Record<QueueEntry["kind"], string> = {
  prompt: "border-primary/30 bg-primary/10 text-primary",
  steer: "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400",
  interject: "border-sky-500/30 bg-sky-500/10 text-sky-600 dark:text-sky-400",
}

/**
 * Display-only stack of queued messages, shown above the Composer while the
 * agent is running. There is NO dequeue endpoint, so entries are read-only.
 */
export function QueueChips({ entries }: { entries: QueueEntry[] }) {
  if (!entries || entries.length === 0) return null
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-1.5 px-4">
      {entries.map((e) => (
        // TODO: needs server dequeue route — no remove button until then.
        <div
          key={e.id}
          className="flex items-center gap-2 rounded-lg border border-border bg-card/60 px-3 py-1.5 text-[12.5px] shadow-xs backdrop-blur-sm"
        >
          <Clock className="size-3.5 shrink-0 text-muted-foreground/70" />
          <span
            className={cn(
              "shrink-0 rounded-full border px-1.5 py-0.5 font-medium text-[10px] uppercase tracking-wide",
              KIND_TONE[e.kind] ?? "border-border bg-muted/50 text-muted-foreground",
            )}
          >
            {e.kind}
          </span>
          <span className="truncate text-muted-foreground">{e.shown || e.text}</span>
        </div>
      ))}
    </div>
  )
}
