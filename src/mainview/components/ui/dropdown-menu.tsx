import { Menu as MenuPrimitive } from "@base-ui/react/menu"
import { Check } from "lucide-react"
import type * as React from "react"
import { cn } from "~/lib/cn"

export const DropdownMenu = MenuPrimitive.Root
export const DropdownMenuGroup = MenuPrimitive.Group
export const DropdownMenuRadioGroup = MenuPrimitive.RadioGroup
/** Groups a nested menu: one SubTrigger item plus one SubContent popup. */
export const DropdownMenuSub = MenuPrimitive.SubmenuRoot

/** Row + popup styling shared by items and surfaces, so a submenu can never
 *  drift from the menu it hangs off. */
const ITEM_CLASSES =
  "flex min-h-8 cursor-pointer select-none items-center gap-2 rounded-lg px-2.5 text-sm outline-none transition-colors data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0 [&_svg:not([class*='text-'])]:text-muted-foreground"

const POPUP_CLASSES =
  "min-w-44 origin-[var(--transform-origin)] rounded-xl border border-border bg-popover p-1 text-popover-foreground shadow-panel outline-none transition-[transform,opacity] duration-150 data-[ending-style]:scale-95 data-[starting-style]:scale-95 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0"

export function DropdownMenuTrigger({ className, ...props }: MenuPrimitive.Trigger.Props) {
  return <MenuPrimitive.Trigger data-slot="dropdown-trigger" className={className} {...props} />
}

export function DropdownMenuContent({
  className,
  children,
  side = "bottom",
  align = "start",
  sideOffset = 6,
  anchor,
  ...props
}: MenuPrimitive.Popup.Props & {
  side?: MenuPrimitive.Positioner.Props["side"]
  align?: MenuPrimitive.Positioner.Props["align"]
  sideOffset?: MenuPrimitive.Positioner.Props["sideOffset"]
  /** Position against something other than the trigger (e.g. a cursor point). */
  anchor?: MenuPrimitive.Positioner.Props["anchor"]
}) {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Positioner side={side} align={align} sideOffset={sideOffset} anchor={anchor} className="z-50">
        <MenuPrimitive.Popup
          data-slot="dropdown-content"
          className={cn(POPUP_CLASSES, className)}
          {...props}
        >
          {children}
        </MenuPrimitive.Popup>
      </MenuPrimitive.Positioner>
    </MenuPrimitive.Portal>
  )
}

export function DropdownMenuItem({
  className,
  inset,
  variant = "default",
  ...props
}: MenuPrimitive.Item.Props & { inset?: boolean; variant?: "default" | "destructive" }) {
  return (
    <MenuPrimitive.Item
      data-slot="dropdown-item"
      data-variant={variant}
      className={cn(
        ITEM_CLASSES,
        "data-[variant=destructive]:text-destructive data-[variant=destructive]:data-[highlighted]:bg-destructive/10 data-[variant=destructive]:[&_svg]:text-destructive",
        inset && "pl-8",
        className,
      )}
      {...props}
    />
  )
}

/** A menu row that opens a nested menu on hover/click. Renders a <div>, so it
 *  can sit beside a regular item in the same row. */
export function DropdownMenuSubTrigger({ className, ...props }: MenuPrimitive.SubmenuTrigger.Props) {
  return (
    <MenuPrimitive.SubmenuTrigger
      data-slot="dropdown-sub-trigger"
      className={cn(ITEM_CLASSES, "data-[popup-open]:bg-accent data-[popup-open]:text-accent-foreground", className)}
      {...props}
    />
  )
}

/** The nested menu's popup. Portalled like DropdownMenuContent, so a submenu
 *  is never clipped by a scrolling parent popup. */
export function DropdownMenuSubContent({
  className,
  children,
  side = "right",
  align = "start",
  sideOffset = 6,
  ...props
}: MenuPrimitive.Popup.Props & {
  side?: MenuPrimitive.Positioner.Props["side"]
  align?: MenuPrimitive.Positioner.Props["align"]
  sideOffset?: MenuPrimitive.Positioner.Props["sideOffset"]
}) {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Positioner side={side} align={align} sideOffset={sideOffset} className="z-50">
        <MenuPrimitive.Popup
          data-slot="dropdown-sub-content"
          className={cn(POPUP_CLASSES, className)}
          {...props}
        >
          {children}
        </MenuPrimitive.Popup>
      </MenuPrimitive.Positioner>
    </MenuPrimitive.Portal>
  )
}

export function DropdownMenuRadioItem({
  className,
  children,
  ...props
}: MenuPrimitive.RadioItem.Props) {
  return (
    <MenuPrimitive.RadioItem
      data-slot="dropdown-radio-item"
      className={cn(
        "relative flex min-h-8 cursor-pointer select-none items-center gap-2 rounded-lg py-1 pr-2.5 pl-8 text-sm outline-none transition-colors data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground",
        className,
      )}
      {...props}
    >
      <span className="absolute left-2.5 inline-flex items-center">
        <MenuPrimitive.RadioItemIndicator>
          <Check className="size-4 text-primary" />
        </MenuPrimitive.RadioItemIndicator>
      </span>
      {children}
    </MenuPrimitive.RadioItem>
  )
}

// A visual menu section label. Base UI's GroupLabel throws unless it is a
// direct descendant of <Menu.Group>; our menus also use labels for popup
// headers and lightweight sections, so render a non-interactive div instead.
export function DropdownMenuLabel({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      role="presentation"
      className={cn("px-2.5 py-1.5 font-medium text-muted-foreground text-xs", className)}
      {...props}
    />
  )
}

export function DropdownMenuSeparator({ className, ...props }: MenuPrimitive.Separator.Props) {
  return <MenuPrimitive.Separator className={cn("-mx-1 my-1 h-px bg-border", className)} {...props} />
}

export function DropdownMenuShortcut({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      className={cn("ml-auto font-medium text-muted-foreground/70 text-xs tracking-wide", className)}
      {...props}
    />
  )
}
