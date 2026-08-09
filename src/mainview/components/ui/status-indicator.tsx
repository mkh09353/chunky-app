// The single shared treatment for "what is this session doing right now".
//
// Every surface that answers that question — the sidebar rows, the repo tabs,
// the far-left overview, the Home feed — used to hand-roll its own six pixels
// (`size-1.5 animate-pulse rounded-full bg-primary`). A pulse is a poor signal
// for work in flight: it reads as a notification badge breathing, not as
// something turning, and it is the same shape as the solid "unread" dot it sits
// next to. A spinning ring is unambiguous at a glance and cannot be confused
// with a badge.
//
// The slot is ALWAYS rendered at a fixed size, empty states included, so a list
// of titles stays aligned down its column instead of jittering as rows start
// and stop working.
//
// Reduced motion: the ring stops spinning but stays a RING. That is what keeps
// "working" distinguishable from the solid "unread" dot without any animation
// at all — falling back to a dot would collapse two states into one glyph.
import type * as React from "react"
import { cn } from "~/lib/cn"

/** A small spinning arc: one primary segment over a faint primary track.
 *
 *  Deliberately a bordered circle rather than a lucide icon — at 12px an icon's
 *  strokes land between device pixels and read as a grey smudge, while a
 *  1.5px border ring stays crisp. */
export function WorkingSpinner({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      className={cn(
        "size-3 shrink-0 animate-spin rounded-full border-[1.5px] border-primary/25 border-t-primary motion-reduce:animate-none",
        className,
      )}
      {...props}
    />
  )
}

/** What a session row is doing, in one fixed-size slot. */
export type StatusGlyphState = "working" | "unread" | "idle"

/**
 * Working → spinner, finished-but-unseen → solid dot, everything else → an
 * empty slot of the same size.
 *
 * The wrapper is the alignment contract: callers get the same footprint in all
 * three states, so they can put it at the head of a row and forget about it.
 */
export function StatusGlyph({
  state,
  className,
}: {
  state: StatusGlyphState
  className?: string
}) {
  return (
    <span className={cn("flex size-3 shrink-0 items-center justify-center", className)}>
      {state === "working" ? (
        <WorkingSpinner aria-label="Working" />
      ) : state === "unread" ? (
        <span className="size-1.5 rounded-full bg-primary" aria-label="Unread" />
      ) : null}
    </span>
  )
}
