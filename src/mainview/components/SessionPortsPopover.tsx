// Header popover listing the TCP ports the session's background tasks are
// currently listening on (`ports.changed`, an authoritative live-only snapshot
// reduced into TranscriptState.ports).
//
// It is a *view* of that snapshot and nothing else: no polling, no local list,
// no memory of ports that have gone away. When the array is empty the trigger
// is not rendered at all, so the header gains an icon only while something is
// actually serving — which is also why there is no empty state inside.
import { ExternalLink, Globe2, Plug } from "lucide-react"
import type { ListeningPort } from "@chunky/protocol"
import { cn } from "~/lib/cn"
import { NO_DRAG_REGION } from "~/lib/dragRegion"
import { openInAppBrowser } from "~/lib/browserNav"
import { openExternal } from "~/lib/openExternal"
import { Button } from "./ui/button"
import { Popover, PopoverPopup, PopoverTrigger } from "./ui/popover"
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip"

/** Where a port can be opened. Injectable so the wiring is unit-testable
 *  without a DOM, and so no call site can reach for `window.open`. */
export interface PortOpeners {
  openInApp: (url: string) => void
  openExternally: (url: string) => void
}

const defaultOpeners: PortOpeners = {
  openInApp: openInAppBrowser,
  openExternally: openExternal,
}

export interface PortRowAction {
  key: "app" | "external"
  label: string
  /** No server-suggested URL → nothing to open, so the action is inert. */
  disabled: boolean
  run: () => void
}

/** The two actions offered for one port, in row order. Pure: given a port and
 *  the openers, it says exactly what the buttons do — including that a
 *  `url: null` port offers only disabled actions. */
export function portRowActions(
  port: ListeningPort,
  openers: PortOpeners = defaultOpeners,
): PortRowAction[] {
  const url = port.url
  return [
    {
      key: "app",
      label: `Open port ${port.port} in Chunky browser`,
      disabled: url == null,
      run: () => {
        if (url != null) openers.openInApp(url)
      },
    },
    {
      key: "external",
      label: `Open port ${port.port} in default browser`,
      disabled: url == null,
      run: () => {
        if (url != null) openers.openExternally(url)
      },
    },
  ]
}

/** "ruby · 127.0.0.1" — what is serving, and where it is bound. */
export function portSubtitle(port: ListeningPort): string {
  const command = port.command?.trim()
  const address = port.address?.trim()
  return [command, address].filter(Boolean).join(" · ")
}

const ACTION_ICONS = { app: Globe2, external: ExternalLink } as const

/** The popup body. Exported so it can be rendered (and asserted on) directly:
 *  a Base UI popup only exists in the DOM while it is open. */
export function PortsList({
  ports,
  openers = defaultOpeners,
}: {
  ports: readonly ListeningPort[]
  openers?: PortOpeners
}) {
  return (
    <div className="flex flex-col">
      <p className="px-1.5 pb-1.5 font-medium text-[11px] text-muted-foreground uppercase tracking-wide">
        Ports
      </p>
      {/* Bounded height: a task farm can listen on a lot of ports, and the
          popup scrolls rather than growing past the window. */}
      <ul className="flex max-h-[15rem] flex-col gap-0.5 overflow-y-auto">
        {ports.map((port) => (
          <li
            className="flex items-center gap-2 rounded-lg px-1.5 py-1 transition-colors hover:bg-accent/60"
            key={`${port.taskId}:${port.address}:${port.port}`}
          >
            <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-emerald-500" />
            <div className="flex min-w-0 flex-1 items-baseline gap-1.5">
              <span className="font-medium text-[13px] text-foreground tabular-nums">
                {port.port}
              </span>
              <span className="truncate text-[11px] text-muted-foreground">
                {portSubtitle(port)}
              </span>
            </div>
            <div className="flex shrink-0 items-center gap-0.5">
              {portRowActions(port, openers).map((action) => {
                const Icon = ACTION_ICONS[action.key]
                return (
                  <Tooltip key={action.key}>
                    <TooltipTrigger
                      render={
                        <Button
                          aria-label={action.label}
                          disabled={action.disabled}
                          onClick={action.run}
                          size="icon-sm"
                          variant="ghost"
                        />
                      }
                    >
                      <Icon />
                    </TooltipTrigger>
                    <TooltipPopup>{action.label}</TooltipPopup>
                  </Tooltip>
                )
              })}
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}

/**
 * Header trigger + popover for the session's listening ports. Renders nothing
 * when the session is not listening on anything.
 */
export function SessionPortsPopover({
  ports,
  openers,
}: {
  ports: readonly ListeningPort[]
  openers?: PortOpeners
}) {
  if (ports.length === 0) return null

  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                <Button
                  aria-label="Forwarded ports"
                  // The header strip is a native drag region; without this a
                  // mousedown here would move the window instead of opening
                  // the popover (see lib/dragRegion.ts).
                  className={cn(NO_DRAG_REGION, "relative")}
                  size="icon-sm"
                  variant="ghost"
                />
              }
            />
          }
        >
          <Plug />
          <span
            className="absolute top-0.5 right-0.5 flex min-w-3 items-center justify-center rounded-full bg-emerald-500 px-[3px] font-medium text-[9px] text-white leading-3 tabular-nums"
            data-slot="ports-count"
          >
            {ports.length}
          </span>
        </TooltipTrigger>
        <TooltipPopup>
          {ports.length === 1 ? "1 listening port" : `${ports.length} listening ports`}
        </TooltipPopup>
      </Tooltip>
      <PopoverPopup align="end" className="w-[18rem]" side="bottom">
        <PortsList openers={openers} ports={ports} />
      </PopoverPopup>
    </Popover>
  )
}
