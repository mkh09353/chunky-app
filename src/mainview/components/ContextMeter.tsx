import type { UsageDelta } from "@chunky/protocol"
import { cn } from "~/lib/cn"
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip"

const k = (n: number) => `${Math.round(n / 1000)}k`

/**
 * Compact context-window meter. `used` is the last turn's inputTokens (the
 * prompt/context size). Renders nothing without usage + a known limit (e.g.
 * demo/offline mode), so it never crashes those paths.
 */
export function ContextMeter({
  usage,
  limit,
}: {
  usage: UsageDelta | null
  limit?: number
}) {
  if (!usage || !limit || limit <= 0) return null
  const used = usage.inputTokens || 0
  const frac = Math.max(0, Math.min(1, used / limit))
  const tone =
    frac >= 0.9 ? "bg-destructive" : frac >= 0.7 ? "bg-amber-500" : "bg-muted-foreground/50"
  const textTone =
    frac >= 0.9 ? "text-destructive" : frac >= 0.7 ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground"

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            className="flex cursor-default items-center gap-1.5 rounded-md px-1.5 py-1 outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
            aria-label="Context window usage"
          />
        }
      >
        <span className={cn("font-mono text-[11px] tabular-nums", textTone)}>
          {k(used)} / {k(limit)}
        </span>
        <span className="h-1.5 w-14 overflow-hidden rounded-full bg-border">
          <span
            className={cn("block h-full rounded-full transition-all", tone)}
            style={{ width: `${frac * 100}%` }}
          />
        </span>
      </TooltipTrigger>
      <TooltipPopup>
        <div className="flex flex-col gap-0.5 font-mono text-[11px]">
          <span>{usage.inputTokens ?? 0} input (context)</span>
          <span>{usage.outputTokens ?? 0} output</span>
          {usage.cacheReadTokens != null && <span>{usage.cacheReadTokens} cache-read</span>}
          {usage.reasoningTokens != null && <span>{usage.reasoningTokens} reasoning</span>}
        </div>
      </TooltipPopup>
    </Tooltip>
  )
}
