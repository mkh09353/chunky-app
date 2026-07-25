import type * as React from "react"

import { cn } from "~/lib/cn"

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      className={cn(
        "w-full min-w-0 resize-none bg-transparent text-sm text-foreground outline-none selection:bg-primary/25 placeholder:text-muted-foreground/70 disabled:pointer-events-none disabled:opacity-60",
        className,
      )}
      data-slot="textarea"
      {...props}
    />
  )
}

export { Textarea }
