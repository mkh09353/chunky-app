// Right-click menu for external links anywhere in the app. The delegated
// listener lives in ~/lib/openExternal; this only renders what it asks for.
import { Copy, ExternalLink, Globe2 } from "lucide-react"
import { useEffect, useMemo, useState } from "react"
import { openInAppBrowser } from "~/lib/browserNav"
import { openExternal, subscribeLinkMenu, type LinkMenuRequest } from "~/lib/openExternal"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel } from "./ui/dropdown-menu"

/** Enough of the URL to recognise it, without stretching the menu. */
function linkLabel(url: string): string {
  try {
    const { host, pathname } = new URL(url)
    const path = pathname === "/" ? "" : pathname
    return `${host}${path}`
  } catch {
    return url
  }
}

function copyLink(url: string) {
  try {
    void navigator.clipboard?.writeText(url)
  } catch {
    /* clipboard permission denied — the link stays visible in the transcript */
  }
}

export function ExternalLinkMenu() {
  const [request, setRequest] = useState<LinkMenuRequest | null>(null)

  useEffect(() => subscribeLinkMenu(setRequest), [])

  // A zero-size virtual element at the cursor — the same shape Base UI's own
  // ContextMenu anchors to. Memoized: a fresh object each render would restart
  // positioning on every commit.
  const x = request?.x ?? 0
  const y = request?.y ?? 0
  const anchor = useMemo(
    () => ({ getBoundingClientRect: () => DOMRect.fromRect({ x, y, width: 0, height: 0 }) }),
    [x, y],
  )

  if (!request) return null

  const close = () => setRequest(null)
  const run = (action: () => void) => () => {
    action()
    close()
  }

  return (
    <DropdownMenu
      open
      // Not modal: a context menu should not lock page scroll or freeze the app
      // behind it; an outside press still dismisses it.
      modal={false}
      onOpenChange={(open) => {
        if (!open) close()
      }}
    >
      <DropdownMenuContent
        anchor={anchor}
        side="bottom"
        align="start"
        sideOffset={2}
        // Bounded so a long URL in the label cannot stretch the menu.
        className="min-w-52 max-w-72"
      >
        <DropdownMenuLabel className="truncate">{linkLabel(request.url)}</DropdownMenuLabel>
        <DropdownMenuItem onClick={run(() => openInAppBrowser(request.url))}>
          <Globe2 />
          Open in Chunky browser
        </DropdownMenuItem>
        <DropdownMenuItem onClick={run(() => openExternal(request.url))}>
          <ExternalLink />
          Open in default browser
        </DropdownMenuItem>
        <DropdownMenuItem onClick={run(() => copyLink(request.url))}>
          <Copy />
          Copy link
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
