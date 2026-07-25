import { mergeProps } from "@base-ui/react/merge-props"
import { useRender } from "@base-ui/react/use-render"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "~/lib/cn"

const buttonVariants = cva(
  "relative inline-flex shrink-0 cursor-pointer select-none items-center justify-center gap-2 whitespace-nowrap rounded-lg border font-medium text-sm outline-none transition-[background-color,border-color,box-shadow,color] duration-150 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-60 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    defaultVariants: {
      size: "default",
      variant: "default",
    },
    variants: {
      size: {
        default: "h-8 px-3",
        sm: "h-7 gap-1.5 rounded-md px-2.5 text-xs",
        lg: "h-9 px-4",
        icon: "size-8",
        "icon-sm": "size-7 rounded-md",
        "icon-xs": "size-6 rounded-md [&_svg:not([class*='size-'])]:size-3.5",
      },
      variant: {
        default:
          "border-primary bg-primary text-primary-foreground shadow-xs shadow-primary/25 inset-shadow-[0_1px_rgb(255_255_255/0.16)] hover:bg-primary/90 active:shadow-none active:inset-shadow-[0_1px_rgb(0_0_0/0.08)]",
        secondary: "border-transparent bg-secondary text-secondary-foreground hover:bg-accent",
        outline:
          "border-input bg-transparent text-foreground shadow-xs/5 hover:bg-accent/60 dark:bg-input/25 dark:hover:bg-input/50 [&_svg:not([class*='text-'])]:text-muted-foreground",
        ghost:
          "border-transparent text-foreground hover:bg-accent [&_svg:not([class*='text-'])]:text-muted-foreground",
        destructive:
          "border-destructive bg-destructive text-white shadow-xs shadow-destructive/25 hover:bg-destructive/90",
        link: "border-transparent text-primary underline-offset-4 hover:underline",
      },
    },
  },
)

interface ButtonProps extends useRender.ComponentProps<"button"> {
  variant?: VariantProps<typeof buttonVariants>["variant"]
  size?: VariantProps<typeof buttonVariants>["size"]
}

function Button({ className, variant, size, render, ...props }: ButtonProps) {
  const defaultProps = {
    className: cn(buttonVariants({ className, size, variant })),
    "data-slot": "button",
    type: render ? undefined : ("button" as const),
  }
  return useRender({
    defaultTagName: "button",
    props: mergeProps<"button">(defaultProps, props),
    render,
  })
}

export { Button, buttonVariants }
