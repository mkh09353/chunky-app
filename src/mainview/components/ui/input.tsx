import { Input as InputPrimitive } from "@base-ui/react/input"

import { cn } from "~/lib/cn"

function Input({ className, ...props }: InputPrimitive.Props) {
  return (
    <InputPrimitive
      className={cn(
        "h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-3 text-sm text-foreground shadow-xs/5 outline-none transition-[border-color,box-shadow] duration-150 selection:bg-primary/25 placeholder:text-muted-foreground/70 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/25 disabled:pointer-events-none disabled:opacity-60 dark:bg-input/25",
        "[&::-webkit-search-cancel-button]:appearance-none",
        className,
      )}
      data-slot="input"
      {...props}
    />
  )
}

export { Input }
