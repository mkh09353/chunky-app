// A small non-modal popover surface, styled like the menu/tooltip popups so
// every floating surface in the app shares one look.
//
// Non-modal by default (Base UI's `modal` defaults to false): a popover opened
// from inside a Dialog must not fight the dialog's focus trap — Base UI keeps
// nested popups in one focus tree, so the dialog stays open while the popover
// takes and returns focus.
import { Popover as PopoverPrimitive } from "@base-ui/react/popover"
import { cn } from "~/lib/cn"
import { NO_DRAG_REGION } from "~/lib/dragRegion"
import { OverlayLock } from "~/lib/nativeOverlayGuard"

export const Popover = PopoverPrimitive.Root
export const PopoverTrigger = PopoverPrimitive.Trigger
export const PopoverClose = PopoverPrimitive.Close

export function PopoverPopup({
  className,
  children,
  side = "bottom",
  align = "center",
  sideOffset = 6,
  collisionPadding = 8,
  ...props
}: PopoverPrimitive.Popup.Props & {
  side?: PopoverPrimitive.Positioner.Props["side"]
  align?: PopoverPrimitive.Positioner.Props["align"]
  sideOffset?: PopoverPrimitive.Positioner.Props["sideOffset"]
  /** Keeps the popup this far from the viewport edges (Base UI clamps/flips
   *  against it and publishes the result as `--available-width/height`). */
  collisionPadding?: PopoverPrimitive.Positioner.Props["collisionPadding"]
}) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Positioner
        align={align}
        className="z-50"
        collisionPadding={collisionPadding}
        side={side}
        sideOffset={sideOffset}
      >
        <PopoverPrimitive.Popup
          className={cn(
            // A floating surface is never a window-drag handle: it is portaled
            // to <body>, so it can be painted over the titlebar strip, and
            // WITHOUT this class a mousedown there would start a native window
            // move instead of reaching the popup (see lib/dragRegion.ts).
            NO_DRAG_REGION,
            "origin-(--transform-origin) rounded-xl border border-border bg-popover p-2 text-popover-foreground shadow-panel outline-none",
            "transition-[transform,opacity] duration-150 data-[ending-style]:scale-95 data-[starting-style]:scale-95 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0",
            className,
          )}
          data-slot="popover-popup"
          {...props}
        >
          {/* A popover has no backdrop and can be small (or dragged, like the
              Add repository panel), which is exactly what the pane's geometric
              probe can miss. The lock mounts with the popup and measures it, so
              the native webview steps aside while — and only while — the popup
              actually overlaps the pane. */}
          <OverlayLock mode="intersect" />
          {children}
        </PopoverPrimitive.Popup>
      </PopoverPrimitive.Positioner>
    </PopoverPrimitive.Portal>
  )
}
