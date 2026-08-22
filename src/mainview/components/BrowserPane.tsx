import { ArrowLeft, ArrowRight, Cookie, Globe2, LoaderCircle, RotateCw, X } from "lucide-react"
import { useCallback, useEffect, useRef, useState } from "react"
import type { FormEvent, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react"
import { announceAppBrowserTarget, preferredWebviewRenderer } from "~/lib/appBrowser"
import {
  clampPaneWidth,
  MIN_PANE_WIDTH,
  maxPaneWidth,
  persistPaneWidth,
  readPaneWidth,
  readPreferredPaneWidth,
} from "~/lib/browserPaneWidth"
import { subscribeBrowserNavigation, takePendingBrowserUrl } from "~/lib/browserNav"
import { cn } from "~/lib/cn"
import { rectsIntersect } from "~/lib/browserOverlay"
import { NO_DRAG_REGION } from "~/lib/dragRegion"
import { cookieSyncCompleteFirstRun, cookieSyncGetSettings } from "~/lib/cookieSync"
import { CookieSyncModal } from "./browser/CookieSyncModal"
import { Button } from "./ui/button"

const LAST_URL_KEY = "chunky.browser.lastUrl"
const DEFAULT_URL = "https://duckduckgo.com/"

function readLastUrl(): string {
  try {
    return localStorage.getItem(LAST_URL_KEY) || DEFAULT_URL
  } catch {
    return DEFAULT_URL
  }
}

function persistUrl(url: string) {
  try {
    localStorage.setItem(LAST_URL_KEY, url)
  } catch {
    // Storage may be unavailable in private/locked-down contexts.
  }
}

/** Resolve browser-style address input without sending arbitrary prose to a host. */
export function normalizeBrowserAddress(input: string): string {
  const value = input.trim()
  if (!value) return DEFAULT_URL

  if (/^[a-z][a-z\d+.-]*:/i.test(value)) {
    try {
      return new URL(value).href
    } catch {
      return `https://duckduckgo.com/?q=${encodeURIComponent(value)}`
    }
  }

  // Hosts, localhost, IPv4 addresses, and paths with a host-like first segment.
  const looksLikeUrl =
    value === "localhost" ||
    value.startsWith("localhost:") ||
    /^\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?(?:\/|$)/.test(value) ||
    /^(?:[\w-]+\.)+[a-z]{2,}(?::\d+)?(?:\/|$)/i.test(value)
  if (looksLikeUrl) {
    try {
      return new URL(`https://${value}`).href
    } catch {
      // Fall through to search for malformed host-looking input.
    }
  }

  return `https://duckduckgo.com/?q=${encodeURIComponent(value)}`
}

function desktopWebviewAvailable(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof (window as unknown as { __electrobunWebviewId?: number }).__electrobunWebviewId === "number" &&
    typeof customElements !== "undefined" &&
    customElements.get("electrobun-webview") !== undefined
  )
}

/** Navigation events carry the URL as the CustomEvent detail (a plain string). */
function urlFromDetail(detail: unknown): string | null {
  if (typeof detail === "string" && detail.trim()) return detail.trim()
  if (detail && typeof detail === "object") {
    const value = (detail as { url?: unknown }).url
    if (typeof value === "string" && value.trim()) return value.trim()
  }
  return null
}

/**
 * Off-screen holder for a webview element whose native side is still being
 * created. See `destroyWebview`.
 */
let parkingLot: HTMLDivElement | null = null
function getParkingLot(): HTMLElement {
  if (parkingLot?.isConnected) return parkingLot
  parkingLot = document.createElement("div")
  parkingLot.setAttribute("aria-hidden", "true")
  parkingLot.style.cssText =
    "position:fixed;left:-10000px;top:-10000px;width:1px;height:1px;overflow:hidden;pointer-events:none;"
  document.body.appendChild(parkingLot)
  return parkingLot
}

/**
 * Tear down a native child webview.
 *
 * `<electrobun-webview>` creates its native view asynchronously
 * (requestAnimationFrame + an RPC round trip) and only sends `webviewTagRemove`
 * from `disconnectedCallback` once `webviewId` exists. Removing the element
 * during that window (StrictMode's mount/unmount/mount, or a fast toggle) would
 * otherwise leak a native webview composited over the whole window forever.
 */
function destroyWebview(element: ElectrobunWebviewElement, initStarted: () => boolean) {
  // Neutralize an init that has not started yet, so no native view is created.
  // (The pending requestAnimationFrame callback calls `this.initWebview()`.)
  const started = initStarted()
  element.initWebview = async () => {}

  if (element.webviewId != null || !started) {
    // Either fully created (disconnectedCallback tears the native view down) or
    // never started (nothing native exists).
    element.remove()
    return
  }

  // An init already in flight will still resolve; park the element (1x1,
  // off-screen — a 0x0 rect is ignored by the overlay sync) so it stays
  // connected and its `disconnectedCallback` can do the real teardown.
  element.style.position = "static"
  element.style.width = "1px"
  element.style.height = "1px"
  getParkingLot().appendChild(element)

  const startedAt = Date.now()
  const timer = window.setInterval(() => {
    if (element.webviewId != null || Date.now() - startedAt > 5_000) {
      window.clearInterval(timer)
      element.remove()
    }
  }, 50)
}

/**
 * Overlay guard.
 *
 * The native child webview is composited ABOVE the host DOM, and it is a plain
 * NSView: Electrobun's mask support only clips the layer (no `hitTest:`
 * override in libNativeWrapper), so a masked region would still swallow mouse
 * events. Anything React draws over the pane — dialogs, the command palette,
 * dropdown menus, popovers, tooltips, toasts — would be both invisible and dead
 * to clicks. Hiding the native view while something covers the pane is the only
 * mechanism that makes overlays visible AND interactive, and it is a pure
 * visibility change: the page, its scroll position and its history survive.
 */
const OVERLAY_POLL_MS = 200
const OVERLAY_PROBE_COLUMNS = 4
const OVERLAY_PROBE_ROWS = 6

/**
 * Does anything inside this portal layer overlap `target`?
 *
 * Base UI mounts one wrapper `div` per popup directly on `document.body`, and
 * those wrappers have no box of their own (their children are fixed). So
 * descend through zero-area nodes only: the first node with a real box is the
 * positioner/popup and answers the question. Rect-based rather than
 * hit-tested, so `pointer-events: none` popups (tooltips) still count.
 */
function layerCovers(node: Element, target: DOMRect, depth = 0): boolean {
  if (depth > 8) return false
  const rect = node.getBoundingClientRect()
  if (rect.width > 0 && rect.height > 0) {
    const style = getComputedStyle(node)
    if (style.visibility === "hidden" || style.display === "none") return false
    return rectsIntersect(rect, target)
  }
  for (const child of Array.from(node.children)) {
    if (layerCovers(child, target, depth + 1)) return true
  }
  return false
}

/**
 * Catch overlays that are not portals (the fixed notice toast lives inside the
 * app tree) by hit-testing a coarse grid: if the topmost element over a probe
 * point is not the pane itself, something is painted on top of it.
 */
function probeCovered(host: HTMLElement, rect: DOMRect): boolean {
  for (let column = 0; column < OVERLAY_PROBE_COLUMNS; column += 1) {
    for (let row = 0; row < OVERLAY_PROBE_ROWS; row += 1) {
      const x = rect.left + ((column + 0.5) * rect.width) / OVERLAY_PROBE_COLUMNS
      const y = rect.top + ((row + 0.5) * rect.height) / OVERLAY_PROBE_ROWS
      const top = document.elementFromPoint(x, y)
      if (top && top !== host && !host.contains(top)) return true
    }
  }
  return false
}

/** Is any DOM overlay covering the pane right now? */
function paneCovered(host: HTMLElement): boolean {
  const rect = host.getBoundingClientRect()
  if (rect.width < 1 || rect.height < 1) return false
  for (const layer of Array.from(document.body.children)) {
    // Skip the app tree itself (the pane lives in it) — only sibling portal
    // layers and stray hosts can be stacked above it.
    if (layer.contains(host)) continue
    if (layerCovers(layer, rect)) return true
  }
  return probeCovered(host, rect)
}

/**
 * Keep the native view hidden exactly while the pane is covered. Returns a
 * teardown for the observers it installs.
 */
function watchOverlays(host: HTMLElement, element: ElectrobunWebviewElement): () => void {
  const appRoot = host.closest("body > *")
  let applied: boolean | null = null
  let frame = 0

  const evaluate = () => {
    // Before the native view exists there is nothing to hide; `applied` stays
    // untouched so the poll re-applies as soon as it does.
    if (element.webviewId == null) return
    const covered = paneCovered(host)
    if (applied === covered) return
    applied = covered
    element.toggleHidden(covered)
  }
  const schedule = () => {
    // MutationObserver callbacks run before the next paint. Apply the native
    // visibility change in that callback rather than waiting for an animation
    // frame; otherwise the first click on a newly opened popup can still be
    // intercepted by the native view.
    if (!frame) {
      frame = requestAnimationFrame(() => {
        // Clear the handle only when the queued callback runs. Synchronous
        // evaluation below must not make the pending RAF uncancellable.
        frame = 0
        evaluate()
      })
    }
    evaluate()
  }

  // Overlays mount and unmount as DOM changes, so react to those directly (the
  // observer runs before paint) and ignore the app tree's own churn — chat
  // streaming must not cost a geometry pass on every token.
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      const target = record.target as Node
      if (!appRoot || target === document.body || !appRoot.contains(target)) {
        schedule()
        return
      }
    }
  })
  observer.observe(document.body, { childList: true, subtree: true })

  // Safety net for overlays that move without mounting (repositioned popups,
  // in-tree toasts) and for applying state once the native view appears.
  const poll = window.setInterval(evaluate, OVERLAY_POLL_MS)
  window.addEventListener("resize", schedule)
  schedule()

  return () => {
    observer.disconnect()
    window.clearInterval(poll)
    window.removeEventListener("resize", schedule)
    if (frame) cancelAnimationFrame(frame)
  }
}

/**
 * @param baseUrl Live Chunky server to announce this pane to as a remotely
 *   drivable CDP target, or null when there is no connected server (offline,
 *   demo, browser-only dev) — in which case nothing is announced.
 */
export function BrowserPane({ onClose, baseUrl }: { onClose: () => void; baseUrl?: string | null }) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const webviewRef = useRef<ElectrobunWebviewElement | null>(null)
  const [available] = useState(desktopWebviewAvailable)
  const initialUrlRef = useRef<string>("")
  // A link right-clicked into "Open in Chunky browser" while the pane was
  // closed is parked in the store; it wins over the last visited URL.
  if (!initialUrlRef.current) initialUrlRef.current = takePendingBrowserUrl() || readLastUrl()
  const [url, setUrl] = useState(initialUrlRef.current)
  const [draft, setDraft] = useState(initialUrlRef.current)
  const [loading, setLoading] = useState(available)
  const [canGoBack, setCanGoBack] = useState(false)
  const [canGoForward, setCanGoForward] = useState(false)
  // A CDP target for this pane only exists once its page is up, so the server
  // cannot be told anything useful before that.
  const [paneLive, setPaneLive] = useState(false)

  // ── Cookie sync ──────────────────────────────────────────────────────────
  // The first-launch offer, and the site picker it opens. `firstRunComplete`
  // lives on the Bun side (never localStorage); the ref only stops this launch
  // from asking twice if the pane remounts.
  const [cookiePrompt, setCookiePrompt] = useState(false)
  const [cookieModal, setCookieModal] = useState(false)
  const cookieAskedRef = useRef(false)

  // ── Pane width ───────────────────────────────────────────────────────────
  const [paneWidth, setPaneWidth] = useState(() => readPaneWidth(window.innerWidth))
  const [maxWidth, setMaxWidth] = useState(() => maxPaneWidth(window.innerWidth))
  const [resizing, setResizing] = useState(false)
  const widthRef = useRef(paneWidth)
  // The width the user actually asked for, which may be wider than what fits
  // right now. Resizing the window clamps the pane against this, so a spell in
  // a small window does not quietly shrink the preference.
  const preferredRef = useRef(readPreferredPaneWidth(window.innerWidth))
  const dragRef = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null)
  const syncFrameRef = useRef(0)

  /**
   * Push the pane's current geometry to the native side.
   *
   * Electrobun already keeps the overlay in step on its own — its
   * OverlaySyncController watches the `<electrobun-webview>` element with a
   * ResizeObserver and re-syncs on a 100ms poll — so this is not what makes
   * resizing *work*; it is what makes it look attached. Forcing a sync per
   * animation frame while dragging replaces the poll's visible lag with the
   * native view tracking the divider.
   */
  const scheduleOverlaySync = useCallback(() => {
    if (syncFrameRef.current) return
    syncFrameRef.current = requestAnimationFrame(() => {
      syncFrameRef.current = 0
      webviewRef.current?.syncDimensions(true)
    })
  }, [])

  const applyWidth = useCallback((next: number) => {
    setPaneWidth((current) => {
      const clamped = clampPaneWidth(next, window.innerWidth)
      return clamped === current ? current : clamped
    })
  }, [])

  // One place that reacts to the width actually changing, whatever moved it —
  // drag, arrow key, or the window getting smaller.
  useEffect(() => {
    widthRef.current = paneWidth
    scheduleOverlaySync()
  }, [paneWidth, scheduleOverlaySync])

  useEffect(() => () => {
    if (syncFrameRef.current) cancelAnimationFrame(syncFrameRef.current)
  }, [])

  // A window that shrank must not leave the pane owning more than its share —
  // and growing it again gives the chosen width back. Deliberately not
  // persisted: only the user picks a new preference.
  useEffect(() => {
    const onResize = () => {
      setMaxWidth(maxPaneWidth(window.innerWidth))
      applyWidth(preferredRef.current)
    }
    window.addEventListener("resize", onResize)
    return () => window.removeEventListener("resize", onResize)
  }, [applyWidth])

  /**
   * The native child webview is composited ABOVE the host DOM and is a plain
   * NSView, so while the cursor is over it the renderer sees no mouse events at
   * all — no DOM shield at any z-index can catch them. Passthrough is the only
   * thing that keeps a drag alive across the pane: it makes the native view
   * ignore hit tests, so events reach the host webview (and, via pointer
   * capture, the divider). It is a hit-testing change only — the page keeps
   * painting, so nothing flickers.
   */
  const setDragCaptureMode = useCallback((dragging: boolean) => {
    webviewRef.current?.togglePassthrough(dragging)
  }, [])

  const beginResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    dragRef.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: widthRef.current }
    setResizing(true)
    setDragCaptureMode(true)
  }

  const moveResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    // The divider is on the pane's left edge, so dragging left widens it.
    applyWidth(drag.startWidth - (event.clientX - drag.startX))
  }

  const endResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    dragRef.current = null
    setResizing(false)
    setDragCaptureMode(false)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    preferredRef.current = widthRef.current
    persistPaneWidth(widthRef.current)
    webviewRef.current?.syncDimensions(true)
  }

  const onDividerKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return
    event.preventDefault()
    const step = (event.shiftKey ? 64 : 16) * (event.key === "ArrowLeft" ? 1 : -1)
    const next = clampPaneWidth(widthRef.current + step, window.innerWidth)
    applyWidth(next)
    preferredRef.current = next
    persistPaneWidth(next)
  }

  const syncHistory = useCallback((webview: ElectrobunWebviewElement) => {
    void Promise.all([webview.canGoBack(), webview.canGoForward()])
      .then(([back, forward]) => {
        setCanGoBack(back)
        setCanGoForward(forward)
      })
      .catch(() => {
        setCanGoBack(false)
        setCanGoForward(false)
      })
  }, [])

  // The element is created imperatively rather than in JSX on purpose:
  //
  // 1. React 19 assigns unknown props on a custom element as *properties* when
  //    the name exists on the instance (`key in domElement`). Electrobun's tag
  //    exposes a getter-only `sandbox`, so `<electrobun-webview sandbox="">`
  //    threw "Attempted to assign to readonly property" during the commit,
  //    which unmounted the whole React root — the blank window.
  // 2. `sandbox`/`src` must be attributes *before* the element connects, since
  //    `initWebview` reads them once.
  // 3. Owning create + destroy in one effect keeps StrictMode's double-invoke
  //    symmetric (create → destroy → create) instead of leaving React-owned
  //    DOM wired to a torn-down native view.
  // 4. The renderer kind (CEF vs system WebView) is a bun-process answer, so
  //    creation waits on one cached round trip; `cancelled` keeps an unmount
  //    inside that window from creating any native view at all.
  useEffect(() => {
    if (!available) return
    const host = hostRef.current
    if (!host) return

    const mount = (rendererKind: "cef" | "native"): (() => void) | null => {
      const element = document.createElement("electrobun-webview") as ElectrobunWebviewElement
      if (typeof element.on !== "function") return null

      // Native-view creation is deferred to a rAF; knowing whether it actually
      // started lets teardown skip the parking dance in the common case.
      let initStarted = false
      const startInit = element.initWebview.bind(element)
      element.initWebview = async () => {
        initStarted = true
        await startInit()
      }

      // CEF when this build bundled it (the only renderer with a Chrome
      // DevTools Protocol listener, so the only one an agent can drive),
      // otherwise the system WebView.
      element.setAttribute("renderer", rendererKind)
      // Sandboxed: the embedded page gets the event bridge but no host RPC.
      element.setAttribute("sandbox", "")
      element.setAttribute("src", initialUrlRef.current)
      // Electrobun injects an unlayered `electrobun-webview { width:800px;
      // height:300px }` default style, which outranks Tailwind's layered
      // utilities. Inline styles are the only reliable way to size the element —
      // and the element's rect is exactly where the native webview is composited.
      element.style.cssText = "display:block;position:absolute;inset:0;width:100%;height:100%;background:transparent;"

      const onNavigate = (event: CustomEvent) => {
        const next = urlFromDetail(event.detail) ?? element.src
        if (next) {
          setUrl(next)
          setDraft(next)
          persistUrl(next)
        }
        setLoading(false)
        setPaneLive(true)
        syncHistory(element)
      }
      const onDomReady = () => {
        setLoading(false)
        setPaneLive(true)
        syncHistory(element)
      }
      // Links that ask for a new window stay in the pane; there is no tab UI.
      const onNewWindow = (event: CustomEvent) => {
        const next = urlFromDetail(event.detail)
        if (!next) return
        setLoading(true)
        element.loadURL(next)
      }

      element.on("did-navigate", onNavigate)
      element.on("did-navigate-in-page", onNavigate)
      element.on("did-commit-navigation", onNavigate)
      element.on("dom-ready", onDomReady)
      element.on("new-window-open", onNewWindow)

      host.appendChild(element)
      webviewRef.current = element
      const stopOverlayWatch = watchOverlays(host, element)

      return () => {
        element.off("did-navigate", onNavigate)
        element.off("did-navigate-in-page", onNavigate)
        element.off("did-commit-navigation", onNavigate)
        element.off("dom-ready", onDomReady)
        element.off("new-window-open", onNewWindow)
        stopOverlayWatch()
        if (webviewRef.current === element) webviewRef.current = null
        destroyWebview(element, () => initStarted)
      }
    }

    let cancelled = false
    let teardown: (() => void) | null = null
    void preferredWebviewRenderer().then((rendererKind) => {
      if (cancelled) return
      teardown = mount(rendererKind)
    })

    return () => {
      cancelled = true
      teardown?.()
    }
  }, [available, syncHistory])

  const navigate = useCallback((rawUrl: string) => {
    const nextUrl = normalizeBrowserAddress(rawUrl)
    setUrl(nextUrl)
    setDraft(nextUrl)
    persistUrl(nextUrl)
    setLoading(true)
    webviewRef.current?.loadURL(nextUrl)
  }, [])

  /**
   * Tell the server how to drive this pane. Reactive rather than once-on-open:
   * the pane may well be opened before a server is reachable (offline, or during
   * a reconnect), and the CDP endpoint can only be *discovered* while a page of
   * ours is up. The announcer dedupes by payload, so navigating around costs at
   * most one cheap round trip to the bun process and no repeat POST.
   */
  useEffect(() => {
    if (!baseUrl || !paneLive) return
    void announceAppBrowserTarget(baseUrl, url)
  }, [baseUrl, paneLive, url])

  /**
   * Offer the Chrome import once the pane is actually live. Gated on the
   * server-side `firstRunComplete` flag plus a readable Chrome store, so a
   * machine without Chrome (or a user who already answered) is never nagged.
   */
  useEffect(() => {
    if (!paneLive || cookieAskedRef.current) return
    cookieAskedRef.current = true
    let cancelled = false
    void cookieSyncGetSettings()
      .then((state) => {
        if (cancelled) return
        if (!state.firstRunComplete && state.chromeAvailable) setCookiePrompt(true)
      })
      .catch(() => {
        // No cookie-sync support (web build, older runtime): stay quiet.
      })
    return () => {
      cancelled = true
    }
  }, [paneLive])

  const dismissCookiePrompt = useCallback(() => {
    setCookiePrompt(false)
    void cookieSyncCompleteFirstRun()
  }, [])

  // Navigation requests that arrive while the pane is already open.
  useEffect(
    () =>
      subscribeBrowserNavigation((next) => {
        // Clear the parked request so a later remount does not repeat it.
        takePendingBrowserUrl()
        navigate(next)
      }),
    [navigate],
  )

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    navigate(draft)
  }

  return (
    <aside
      className="relative flex min-h-0 min-w-[20rem] flex-none flex-col border-border/70 border-l bg-background/70"
      style={{ width: paneWidth }}
      aria-label="Browser pane"
    >
      {/* Resize handle. It reaches further OUT than in on purpose: the half
          lying over the pane is dead once the native webview is composited on
          top of it, so the grabbable strip is the half over the chat side. */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize browser pane"
        aria-valuenow={Math.round(paneWidth)}
        aria-valuemin={MIN_PANE_WIDTH}
        aria-valuemax={maxWidth}
        tabIndex={0}
        onPointerDown={beginResize}
        onPointerMove={moveResize}
        onPointerUp={endResize}
        onPointerCancel={endResize}
        onKeyDown={onDividerKeyDown}
        className={cn(
          NO_DRAG_REGION,
          "group absolute inset-y-0 -left-2 z-30 w-4 cursor-col-resize touch-none outline-none",
        )}
      >
        <span
          aria-hidden
          className={cn(
            "pointer-events-none absolute inset-y-0 left-2 w-px transition-colors",
            resizing
              ? "bg-primary"
              : "bg-transparent group-hover:bg-primary/60 group-focus-visible:bg-primary/60",
          )}
        />
      </div>
      <form className="no-drag flex h-[52px] shrink-0 items-center gap-1 border-border/70 border-b px-2" onSubmit={submit}>
        <Button type="button" variant="ghost" size="icon-sm" disabled={!available || !canGoBack} onClick={() => { setLoading(true); webviewRef.current?.goBack() }} aria-label="Back">
          <ArrowLeft />
        </Button>
        <Button type="button" variant="ghost" size="icon-sm" disabled={!available || !canGoForward} onClick={() => { setLoading(true); webviewRef.current?.goForward() }} aria-label="Forward">
          <ArrowRight />
        </Button>
        <Button type="button" variant="ghost" size="icon-sm" disabled={!available} onClick={() => { setLoading(true); webviewRef.current?.reload() }} aria-label="Reload">
          <RotateCw className={cn(loading && "animate-spin")} />
        </Button>
        <div className="relative min-w-0 flex-1">
          <Globe2 className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onFocus={(event) => event.currentTarget.select()}
            placeholder="Search or enter URL"
            spellCheck={false}
            title={url}
            className="h-8 w-full rounded-lg border border-input bg-muted/30 py-1 pl-8 pr-3 text-[12px] text-foreground outline-none placeholder:text-muted-foreground/70 focus:border-ring focus:ring-[3px] focus:ring-ring/25"
            aria-label="Browser address"
          />
        </div>
        <Button type="button" variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close browser">
          <X />
        </Button>
      </form>

      <div className="relative min-h-0 flex-1 overflow-hidden bg-muted/30">
        {available ? (
          // The native webview is composited over this box; it must stay empty
          // of anything meant to be SEEN (the native view paints over it).
          <div ref={hostRef} className="absolute inset-0">
            {/* Drag shield. It has to live inside the host, not beside it:
                `paneCovered` treats any element it does not contain as an
                overlay and hides the native view, which would blank the page
                for the whole drag. Inside, `host.contains(...)` is true, so the
                page keeps painting while the cursor stays col-resize. */}
            {resizing ? <div className="absolute inset-0 z-10 cursor-col-resize" /> : null}
          </div>
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-7 text-center">
            <div className="flex size-10 items-center justify-center rounded-xl border border-primary/20 bg-primary/10 text-primary"><Globe2 className="size-5" /></div>
            <div>
              <p className="font-medium text-[13px] text-foreground">Embedded browser is available in the desktop app</p>
              <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">Run Chunky through Electrobun to browse here. The web development build does not embed native webviews.</p>
            </div>
          </div>
        )}
        {available && loading ? <LoaderCircle className="pointer-events-none absolute right-3 top-3 size-4 animate-spin text-primary" aria-label="Loading" /> : null}

        {/* First-launch cookie offer. Deliberately a sibling of the webview
            host rather than a child of it: `paneCovered` treats anything it
            does not contain as an overlay and hides the native view while it
            is up, which is what makes this card both visible and clickable
            over the composited page.

            The full-pane scrim is what guarantees that: the card alone is too
            small for `probeCovered`'s coarse grid to reliably land on, so the
            native view would otherwise stay composited on top and swallow the
            clicks. The scrim spans the whole host rect (a sibling of `host`, so
            `host.contains(...)` is false), so every probe point hits it and the
            native view is hidden the moment the offer is up. */}
        {cookiePrompt ? (
          <div className={cn(NO_DRAG_REGION, "absolute inset-0 z-10 bg-foreground/5")} aria-hidden />
        ) : null}
        {cookiePrompt ? (
          <div
            role="dialog"
            aria-label="Sync your Chrome logins"
            className={cn(
              NO_DRAG_REGION,
              "absolute inset-x-3 bottom-3 z-20 flex flex-col gap-2 rounded-xl border border-border bg-popover/95 p-3 shadow-panel backdrop-blur",
            )}
          >
            <div className="flex items-start gap-2.5">
              <div className="flex size-7 shrink-0 items-center justify-center rounded-lg border border-primary/20 bg-primary/10 text-primary">
                <Cookie className="size-4" />
              </div>
              <div className="min-w-0">
                <p className="font-medium text-[13px] text-foreground">Sync your Chrome logins?</p>
                <p className="mt-0.5 text-[11.5px] leading-relaxed text-muted-foreground">
                  Copy cookies for the sites you choose into this browser, locally. Nothing is uploaded.
                </p>
              </div>
            </div>
            <div className="flex items-center justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={dismissCookiePrompt}>Not now</Button>
              <Button
                size="sm"
                onClick={() => {
                  setCookiePrompt(false)
                  setCookieModal(true)
                }}
              >
                Choose sites
              </Button>
            </div>
          </div>
        ) : null}
      </div>

      {/* Rendered through the Base UI dialog portal (a body-level sibling
          layer), which `paneCovered`'s layer scan already accounts for, so the
          native view steps aside while the picker is open. */}
      <CookieSyncModal open={cookieModal} onOpenChange={setCookieModal} />
    </aside>
  )
}
