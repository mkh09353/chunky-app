// The composer's status rule: TUI-parity chips (incognito · executor ·
// sidekick · advisor · goal) painted in the app's visual language.
//
// Layout rules: the row never wraps. The accent/danger chips (incognito +
// executor) always survive; the dim/warning chips are the first to be dropped
// on narrow widths and truncate before they push anything off.
import type { StatusChip } from "~/lib/composerStatus"
import { cn } from "~/lib/cn"

const TONE: Record<StatusChip["tone"], string> = {
  danger: "font-semibold tracking-wide text-destructive",
  accent: "font-medium text-primary",
  dim: "text-muted-foreground",
  warning: "font-medium text-amber-600 dark:text-amber-400",
}

export function ComposerStatus({ chips }: { chips: StatusChip[] }) {
  if (chips.length === 0) return null
  return (
    <div className="flex min-w-0 flex-nowrap items-center gap-1.5 overflow-hidden whitespace-nowrap px-3 pt-1 pb-0.5 text-[11px] leading-tight">
      {chips.map((chip, i) => {
        // Secondary chips collapse away first: hidden on narrow composers.
        const secondary = chip.tone === "dim" || chip.tone === "warning"
        return (
          <span
            key={chip.key}
            className={cn("flex min-w-0 items-center gap-1.5", secondary && "hidden sm:flex")}
          >
            {i > 0 && <span className="text-border select-none">·</span>}
            <span className={cn("max-w-[14rem] truncate", TONE[chip.tone])} title={chip.title}>
              {chip.text}
            </span>
          </span>
        )
      })}
    </div>
  )
}
