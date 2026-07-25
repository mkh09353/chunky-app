import type * as React from "react"
import { cn } from "~/lib/cn"

export function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      className={cn(
        "animate-shimmer rounded-md bg-muted bg-[length:200%_100%]",
        "bg-[linear-gradient(90deg,transparent,color-mix(in_oklch,var(--foreground)_8%,transparent),transparent)]",
        className,
      )}
      {...props}
    />
  )
}
