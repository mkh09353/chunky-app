// Queued prompts, shown above the Composer while the agent works.
//
// Each row is one pending message with its own actions: STEER it into the
// running turn (it lands at the next tool boundary instead of waiting for the
// turn to end) or DROP it. Both are server operations — the queue lives in the
// server's memory — so the row owns just the in-flight/error state around them.
//
// A row whose action FAILED is pinned: it keeps rendering from the last known
// entry even after the server's queue.changed no longer lists it, so a failure
// can never make the user's text disappear without a trace.
import { CornerDownLeft, Loader2, Trash2 } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import type { QueueEntry } from "@chunky/protocol"
import { cn } from "~/lib/cn"

const KIND_TONE: Record<QueueEntry["kind"], string> = {
  prompt: "border-primary/30 bg-primary/10 text-primary",
  steer: "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400",
  interject: "border-sky-500/30 bg-sky-500/10 text-sky-600 dark:text-sky-400",
}

/** A row we keep on screen after a failed action, with the reason. */
interface Pinned {
  entry: QueueEntry
  error: string
}

export function QueueChips({
  entries,
  running = false,
  onSteer,
  onDelete,
}: {
  entries: QueueEntry[]
  /** Actions only make sense while a turn is in flight. */
  running?: boolean
  /** Steer this entry into the running turn. Rejecting keeps the row + reason.
   *  Resolves with an optional note to show (e.g. "it already started"). */
  onSteer?: (entry: QueueEntry) => Promise<string | null | void>
  /** Drop this entry from the queue. */
  onDelete?: (entry: QueueEntry) => Promise<void>
}) {
  const [busy, setBusy] = useState<string | null>(null)
  const [notes, setNotes] = useState<Record<string, string>>({})
  const [pinned, setPinned] = useState<Pinned[]>([])
  // Keep the last shape of every entry we've seen, so a row that vanishes
  // mid-action can still be rendered from memory.
  const seen = useRef(new Map<string, QueueEntry>())
  for (const entry of entries) seen.current.set(entry.id, entry)

  // A pinned row is released once the server confirms it's gone AND the user
  // has had the error on screen — clearing happens on the next successful
  // action or when the same id reappears in the queue.
  useEffect(() => {
    if (entries.length === 0) return
    const live = new Set(entries.map((e) => e.id))
    setPinned((old) => old.filter((p) => !live.has(p.entry.id)))
  }, [entries])

  const rows: { entry: QueueEntry; error?: string; stale?: boolean }[] = [
    ...entries.map((entry) => ({ entry })),
    ...pinned
      .filter((p) => !entries.some((e) => e.id === p.entry.id))
      .map((p) => ({ entry: p.entry, error: p.error, stale: true })),
  ]

  if (rows.length === 0) return null

  const run = async (entry: QueueEntry, action: () => Promise<string | null | void>) => {
    setBusy(entry.id)
    setPinned((old) => old.filter((p) => p.entry.id !== entry.id))
    setNotes((old) => {
      const { [entry.id]: _gone, ...rest } = old
      return rest
    })
    try {
      const note = await action()
      if (note) setNotes((old) => ({ ...old, [entry.id]: note }))
    } catch (err) {
      // Pin the row so the text survives the failure, even though the queue
      // snapshot may no longer include it.
      setPinned((old) => [
        ...old.filter((p) => p.entry.id !== entry.id),
        { entry, error: (err as Error).message || "That didn't work." },
      ])
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-1.5 px-4">
      {rows.map(({ entry, error, stale }) => {
        // Only a plain queued prompt can be steered: a steer/interjection is
        // already destined for the running turn.
        const actionable = running && entry.kind === "prompt" && !stale
        const isBusy = busy === entry.id
        const note = notes[entry.id]
        return (
          <div
            key={entry.id}
            className={cn(
              "flex flex-col gap-1 rounded-lg border border-border bg-card/60 px-3 py-1.5 text-[12.5px] shadow-xs backdrop-blur-sm",
              error && "border-destructive/40",
            )}
          >
            <div className="flex min-w-0 items-center gap-2">
              <CornerDownLeft className="size-3.5 shrink-0 text-muted-foreground/70" />
              {entry.kind !== "prompt" && (
                <span
                  className={cn(
                    "shrink-0 rounded-full border px-1.5 py-0.5 font-medium text-[10px] uppercase tracking-wide",
                    KIND_TONE[entry.kind] ?? "border-border bg-muted/50 text-muted-foreground",
                  )}
                >
                  {entry.kind}
                </span>
              )}
              <span className="min-w-0 flex-1 truncate text-muted-foreground">
                {entry.shown || entry.text}
              </span>

              {/* Actions never wrap away: the text column is the only one that
                  gives up space. */}
              {actionable && (onSteer || onDelete) && (
                <div className="flex shrink-0 items-center gap-0.5">
                  {onSteer && (
                    <button
                      type="button"
                      disabled={isBusy}
                      onClick={() => void run(entry, () => onSteer(entry))}
                      title="Send this now, at the next tool boundary, instead of waiting for the turn to finish"
                      className="inline-flex cursor-pointer items-center gap-1 rounded-md px-1.5 py-1 font-medium text-[11.5px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
                    >
                      {isBusy ? (
                        <Loader2 className="size-3 animate-spin" />
                      ) : (
                        <CornerDownLeft className="size-3" />
                      )}
                      Steer
                    </button>
                  )}
                  {onDelete && (
                    <button
                      type="button"
                      disabled={isBusy}
                      aria-label="Remove this queued message"
                      title="Remove this queued message"
                      onClick={() => void run(entry, () => onDelete(entry))}
                      className="inline-flex cursor-pointer items-center justify-center rounded-md p-1 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:pointer-events-none disabled:opacity-50"
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  )}
                </div>
              )}
            </div>

            {(error || note) && (
              <span className={cn("pl-5 text-[11px]", error ? "text-destructive" : "text-muted-foreground")}>
                {error ?? note}
              </span>
            )}
          </div>
        )
      })}
    </div>
  )
}
