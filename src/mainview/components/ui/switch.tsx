import { Switch as SwitchPrimitive } from "@base-ui/react/switch"

import { cn } from "~/lib/cn"

function Switch({ className, ...props }: SwitchPrimitive.Root.Props) {
  return (
    <SwitchPrimitive.Root
      className={cn(
        "inline-flex h-[18px] w-[30px] shrink-0 cursor-pointer items-center rounded-full p-px outline-none transition-[background-color,box-shadow] duration-200 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background data-checked:bg-primary data-unchecked:bg-input data-disabled:cursor-not-allowed data-disabled:opacity-60",
        className,
      )}
      data-slot="switch"
      {...props}
    >
      <SwitchPrimitive.Thumb
        className="pointer-events-none block size-4 rounded-full bg-white shadow-sm transition-transform duration-200 will-change-transform data-checked:translate-x-3 dark:data-unchecked:bg-foreground/80"
        data-slot="switch-thumb"
      />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
