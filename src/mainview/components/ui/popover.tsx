// A small non-modal popover surface, styled like the menu/tooltip popups so
// every floating surface in the app shares one look.
//
// Non-modal by default (Base UI's `modal` defaults to false): a popover opened
// from inside a Dialog must not fight the dialog's focus trap — Base UI keeps
// nested popups in one focus tree, so the dialog stays open while the popover
// takes and returns focus.
import { Popover as PopoverPrimitive } from "@base-ui/react/popover"
import { cn } from "~/lib/cn"

export const Popover = PopoverPrimitive.Root
export const PopoverTrigger = PopoverPrimitive.Trigger
export const PopoverClose = PopoverPrimitive.Close

export function PopoverPopup({
  className,
  children,
  side = "bottom",
  align = "center",
  sideOffset = 6,
  ...props
}: PopoverPrimitive.Popup.Props & {
  side?: PopoverPrimitive.Positioner.Props["side"]
  align?: PopoverPrimitive.Positioner.Props["align"]
  sideOffset?: PopoverPrimitive.Positioner.Props["sideOffset"]
}) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Positioner
        align={align}
        className="z-50"
        side={side}
        sideOffset={sideOffset}
      >
        <PopoverPrimitive.Popup
          className={cn(
            "origin-(--transform-origin) rounded-xl border border-border bg-popover p-2 text-popover-foreground shadow-panel outline-none",
            "transition-[transform,opacity] duration-150 data-[ending-style]:scale-95 data-[starting-style]:scale-95 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0",
            className,
          )}
          data-slot="popover-popup"
          {...props}
        >
          {children}
        </PopoverPrimitive.Popup>
      </PopoverPrimitive.Positioner>
    </PopoverPrimitive.Portal>
  )
}
