// "Get on fire" — the one-line strip above the composer.
//
// Why it exists: the wizard can be skipped, and a hand-picked model quietly
// ends the active mode (see lib/modes: a mode's identity IS its effective
// pairing). Either way the user ends up off the pairing the product is built
// around, with no hint that it exists. This is that hint: one calm row, one
// click to be back on it, and a dismiss for people who mean it.
//
// It owns no policy — `fireNudgeMode` decides whether it may appear at all
// (live server, recommendation present and unlocked, saved mode seeded, not
// already active, not dismissed, wizard closed) and App passes the answer in.
import { Flame, X } from "lucide-react"
import { cn } from "~/lib/cn"
import { NO_DRAG_REGION } from "~/lib/dragRegion"

export function FireNudge({
  /** The mode to offer, or null when the strip must stay silent. */
  mode,
  /** One derived sentence (fireNudgeCopy) — never a hardcoded roster. */
  copy,
  onApply,
  onDismiss,
  busy,
}: {
  mode: string | null
  copy: string
  onApply: () => void
  onDismiss: () => void
  busy?: boolean
}) {
  if (!mode) return null
  return (
    <div className="mx-auto flex w-full max-w-5xl px-4">
      <div
        className={cn(
          NO_DRAG_REGION,
          "flex min-w-0 w-full items-center gap-2 rounded-lg border border-border border-l-2 border-l-primary/60 bg-card/60 px-3 py-1.5 shadow-xs backdrop-blur-sm",
        )}
      >
        <Flame className="size-3.5 shrink-0 text-primary/80" />
        <p className="min-w-0 flex-1 truncate text-[12px] text-muted-foreground">{copy}</p>
        <button
          type="button"
          disabled={busy}
          onClick={onApply}
          className={cn(
            NO_DRAG_REGION,
            "shrink-0 cursor-pointer rounded-full bg-primary/15 px-2.5 py-0.5 font-medium text-[11px] text-primary outline-none motion-safe:transition-colors hover:bg-primary/25 focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-60",
          )}
        >
          Use {mode}
        </button>
        <button
          type="button"
          aria-label={`Dismiss the ${mode} suggestion`}
          onClick={onDismiss}
          className={cn(
            NO_DRAG_REGION,
            "shrink-0 cursor-pointer rounded-md p-0.5 text-muted-foreground/70 outline-none motion-safe:transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40",
          )}
        >
          <X className="size-3.5" />
        </button>
      </div>
    </div>
  )
}
