// The composer's status rule: the few chips that must not be missed (incognito
// · executor · goal), painted in the app's visual language.
//
// It rides INLINE, to the right of the model selector on the composer's action
// row — one row, not two. Layout rules: the row never wraps, and the
// accent/danger chips (incognito + executor) always survive; the secondary
// chips drop as the composer narrows and truncate before they push anything
// off. Sidekick seats and the advisor are NOT chips: they hang off the executor
// chip as `details` and are spelled out on hover, so the rule stays short.
import type { StatusChip } from "~/lib/composerStatus"
import { cn } from "~/lib/cn"
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip"

const TONE: Record<StatusChip["tone"], string> = {
  danger: "font-semibold tracking-wide text-destructive",
  accent: "font-medium text-primary",
  dim: "text-muted-foreground",
  warning: "font-medium text-amber-600 dark:text-amber-400",
}

/** Drop order as the composer narrows: the least load-bearing chip goes first.
 *  Anything unlisted drops at the earliest (narrowest) breakpoint. */
const DROP_AT: Record<string, string> = {
  goal: "hidden lg:flex",
}

/** Same thing said twice? The selector already names the model. */
function sameLabel(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase()
}

export function ComposerStatus({
  chips,
  /** Text on the model selector this rule sits beside; an executor chip that
   *  would only repeat it is dropped rather than shown twice in a row. */
  selectorLabel,
}: {
  chips: StatusChip[]
  selectorLabel?: string
}) {
  // An executor chip that only repeats the selector beside it is noise — unless
  // it is carrying the seat breakdown, which has nowhere else to live.
  const visible = selectorLabel
    ? chips.filter(
        (chip) =>
          !(
            chip.key === "executor" &&
            !chip.details?.length &&
            sameLabel(chip.text, selectorLabel)
          ),
      )
    : chips
  if (visible.length === 0) return null
  return (
    <div className="flex min-w-0 flex-nowrap items-center gap-1.5 overflow-hidden whitespace-nowrap ps-1 text-[11px] leading-tight">
      {visible.map((chip, i) => {
        // Secondary chips collapse away first: hidden on narrow composers.
        const secondary = chip.tone === "dim" || chip.tone === "warning"
        const label = (
          <span
            className={cn("max-w-[14rem] truncate", TONE[chip.tone])}
            title={chip.details ? undefined : chip.title}
          >
            {chip.text}
          </span>
        )
        return (
          <span
            key={chip.key}
            className={cn(
              "flex min-w-0 items-center gap-1.5",
              secondary && (DROP_AT[chip.key] ?? "hidden sm:flex"),
            )}
          >
            {i > 0 && <span className="text-border select-none">·</span>}
            {chip.details && chip.details.length > 0 ? (
              // Hover (and focus) spells out what the `+N` suffix collapsed.
              // The popup is pointer-events-none, so it can never swallow a
              // click meant for the model selector beside it.
              <Tooltip>
                <TooltipTrigger
                  render={
                    <span
                      tabIndex={0}
                      className={cn(
                        "max-w-[14rem] cursor-default truncate outline-none focus-visible:ring-1 focus-visible:ring-ring/50",
                        TONE[chip.tone],
                      )}
                    />
                  }
                >
                  {chip.text}
                </TooltipTrigger>
                <TooltipPopup align="start">
                  <div className="flex flex-col gap-0.5">
                    {chip.details.map((detail) => (
                      <div key={detail.name} className="flex gap-1.5">
                        <span className="font-medium">{detail.name}</span>
                        <span className="text-muted-foreground">— {detail.model}</span>
                      </div>
                    ))}
                  </div>
                </TooltipPopup>
              </Tooltip>
            ) : (
              label
            )}
          </span>
        )
      })}
    </div>
  )
}
