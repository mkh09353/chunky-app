import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronDown,
  ChevronUp,
  Cookie,
  Copy,
  ExternalLink,
  Globe2,
  LoaderCircle,
  MoreHorizontal,
  RotateCw,
  Search,
  SquareTerminal,
  TriangleAlert,
  X,
} from "lucide-react"
import { useCallback, useEffect, useRef, useState } from "react"
import type { FormEvent, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react"
import { announceAppBrowserTarget, preferredWebviewRenderer } from "~/lib/appBrowser"
import { resolveAddressKey, shouldSyncAddressDraft } from "~/lib/browserAddressBar"
import {
  INITIAL_FIND_STATE,
  findReducer,
  isDuplicateFindOpen,
  shouldClaimFindShortcut,
  shouldOpenFromMenuSignal,
  type FindEvent,
  type FindState,
} from "~/lib/browserFind"
import { onBrowserFindRequested } from "~/lib/browserMenu"
import { GUEST_GUARD_SCRIPT, isPageCloseRequest } from "~/lib/browserGuest"
import { describeLoadFailure, isErrorPageUrl, shouldClearFailure, type LoadFailure } from "~/lib/browserLoadState"
import {
  isAllowedPaneUrl,
  resolveAddressInput,
  resolveProgrammaticUrl,
  resolveStartupUrl,
} from "~/lib/browserNavPolicy"
import { resolveWebviewTeardown, shouldRetainForReuse } from "~/lib/browserPaneTeardown"
import { isPaneOwnedNode, resolveStageRect, type PaneRect } from "~/lib/browserStage"
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
import {
  computeSuppression,
  lockedOverlaysCoverRect,
  subscribeOverlayLock,
  useOverlayLock,
} from "~/lib/nativeOverlayGuard"
import { cookieSyncCompleteFirstRun, cookieSyncGetSettings } from "~/lib/cookieSync"
import { copyText } from "~/lib/clipboard"
import { openExternal } from "~/lib/openExternal"
import { CookieSyncModal } from "./browser/CookieSyncModal"
import { Button } from "./ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "./ui/dropdown-menu"

const LAST_URL_KEY = "chunky.browser.lastUrl"

function readLastUrl(): string | null {
  try {
    return localStorage.getItem(LAST_URL_KEY)
  } catch {
    return null
  }
}

/**
 * Remember the last page — but only one the pane would accept again. An error
 * page, or anything the policy refuses, must not become the next launch's
 * start-up URL.
 */
function persistUrl(url: string) {
  if (!isAllowedPaneUrl(url) || isErrorPageUrl(url)) return
  try {
    localStorage.setItem(LAST_URL_KEY, url)
  } catch {
    // Storage may be unavailable in private/locked-down contexts.
  }
}

/** How long a refused address stays called out in the toolbar. */
const ADDRESS_ERROR_MS = 4_000

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
 * The stage: a body-level, React-independent home for the webview element.
 *
 * React must never own an ancestor of `<electrobun-webview>`. Unmounting the
 * pane's subtree — which React does not only on a normal unmount but also while
 * unwinding from an uncaught render error anywhere in the app — disconnects the
 * element, and a disconnect with a live `webviewId` exits the process (note 5
 * on the mount effect). Hosting the element here makes its survival independent
 * of the React tree: the root can be torn down and rebuilt and the page in the
 * pane keeps running, untouched.
 *
 * `pointer-events: none` because the stage is a positioning box only — the
 * native view is composited above the whole window and does its own hit
 * testing; the DOM box must not intercept anything (and `elementFromPoint` must
 * skip it, so the overlay probe keeps seeing the real UI).
 */
let stage: HTMLDivElement | null = null
function getBrowserStage(): HTMLDivElement {
  if (stage?.isConnected) return stage
  stage = document.createElement("div")
  stage.setAttribute("aria-hidden", "true")
  stage.dataset.browserStage = ""
  // Starts off-screen: nothing is composited until the first rect sync.
  stage.style.cssText =
    "position:fixed;left:-10000px;top:-10000px;width:1px;height:1px;overflow:hidden;pointer-events:none;z-index:0;"
  document.body.appendChild(stage)
  return stage
}

/** Put the stage exactly over the pane slot. Returns the rect now applied. */
function syncStageRect(host: HTMLElement | null, visible: boolean, previous: PaneRect | null): PaneRect | null {
  const slot = host ? host.getBoundingClientRect() : null
  const next = resolveStageRect({
    slot: slot ? { x: slot.x, y: slot.y, width: slot.width, height: slot.height } : null,
    visible,
    previous,
  })
  if (!next) return previous
  const box = getBrowserStage()
  box.style.left = `${next.x}px`
  box.style.top = `${next.y}px`
  box.style.width = `${next.width}px`
  box.style.height = `${next.height}px`
  return next
}

/**
 * The one webview element this process ever creates.
 *
 * Kept at module scope so a remount (StrictMode's double invoke, or the root
 * error boundary resetting the tree) reuses the live element and its page
 * instead of creating a second native view next to the first one — which,
 * since the first can never be removed, would be permanent.
 */
let liveWebview: ElectrobunWebviewElement | null = null

/** How long to keep watching a parked element for a late-arriving native view. */
const PARK_WATCH_MS = 30_000

/** How often to re-measure the pane slot and move the stage onto it. */
const STAGE_POLL_MS = 100

/** Take the native view out of sight and out of the hit-test path. */
function suppressNativeView(element: ElectrobunWebviewElement) {
  if (element.webviewId == null) return
  try {
    element.toggleHidden(true)
    element.togglePassthrough(true)
  } catch {
    // A native side that is already gone is exactly the state we wanted.
  }
}

/**
 * Park a webview element: leave it exactly where it is (in the stage, which
 * nothing but this module can remove) with the native view hidden and
 * passthrough. Watches for an init that resolves after teardown so a late
 * native view is suppressed too.
 */
function parkWebview(element: ElectrobunWebviewElement) {
  suppressNativeView(element)
  if (element.webviewId != null) return
  const startedAt = Date.now()
  const timer = window.setInterval(() => {
    if (element.webviewId != null) {
      window.clearInterval(timer)
      suppressNativeView(element)
      return
    }
    if (Date.now() - startedAt > PARK_WATCH_MS) window.clearInterval(timer)
  }, 50)
}

/**
 * Tear down a webview element — by parking it, almost always.
 *
 * `<electrobun-webview>` creates its native view asynchronously
 * (requestAnimationFrame + an RPC round trip) and sends `webviewTagRemove` from
 * `disconnectedCallback` once `webviewId` exists. That message ends in
 * `CloseBrowser(false)` on a `SetAsChild` CEF browser, which closes the app's
 * main window and exits the process (see `~/lib/browserGuest`). So removal is
 * allowed ONLY when no native view was ever started; everything else is parked
 * for the rest of the process's life. `resolveWebviewTeardown` owns that rule.
 *
 * Returns whether the element survived and may be reused by a later mount.
 */
function destroyWebview(element: ElectrobunWebviewElement, initStarted: () => boolean): boolean {
  // Neutralize an init that has not started yet, so no native view is created.
  // (The pending requestAnimationFrame callback calls `this.initWebview()`.)
  const started = initStarted()
  element.initWebview = async () => {}

  const decision = resolveWebviewTeardown({ webviewId: element.webviewId ?? null, initStarted: started })
  if (decision === "remove") {
    // Nothing native exists and nothing is on its way: `disconnectedCallback`
    // is a no-op, so this is the one safe removal.
    element.remove()
    return shouldRetainForReuse(decision)
  }
  parkWebview(element)
  return shouldRetainForReuse(decision)
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
  const box = stage
  for (let column = 0; column < OVERLAY_PROBE_COLUMNS; column += 1) {
    for (let row = 0; row < OVERLAY_PROBE_ROWS; row += 1) {
      const x = rect.left + ((column + 0.5) * rect.width) / OVERLAY_PROBE_COLUMNS
      const y = rect.top + ((row + 0.5) * rect.height) / OVERLAY_PROBE_ROWS
      const top = document.elementFromPoint(x, y)
      // The pane's own slot and its stage are not overlays. (The stage is
      // `pointer-events: none`, so `elementFromPoint` should skip it anyway —
      // this is the belt to that braces.)
      if (top && !isPaneOwnedNode(top, host, box)) return true
    }
  }
  return false
}

/** Is any DOM overlay covering the pane right now? */
function paneCovered(host: HTMLElement): boolean {
  const rect = host.getBoundingClientRect()
  if (rect.width < 1 || rect.height < 1) return false
  const box = stage
  for (const layer of Array.from(document.body.children)) {
    // Skip the app tree itself (the pane lives in it) — only sibling portal
    // layers and stray hosts can be stacked above it. The stage is a body-level
    // sibling that sits exactly ON the pane by construction, so it would
    // otherwise read as a permanent overlay and hide the page forever.
    if (layer.contains(host)) continue
    if (box && (layer === box || layer.contains(box))) continue
    if (layerCovers(layer, rect)) return true
  }
  return probeCovered(host, rect)
}

/**
 * The single owner of the native view's visibility and hit testing.
 *
 * Three independent things want the native view out of the way, and they must
 * not fight over the same two switches:
 *
 * - an overlay covering the pane (a dialog, popover, menu, or the pane's own
 *   first-run card) — the view must neither paint nor take clicks;
 * - a divider drag — the page must KEEP painting while the cursor crosses it,
 *   so only hit testing gives way;
 * - a CLOSED pane. The pane stays mounted once opened (see note 5 on the mount
 *   effect), so "closed" is a visibility question, not a teardown: the native
 *   view is composited by the OS and would otherwise keep painting over the
 *   chat no matter what the DOM does.
 *
 * `computeSuppression` owns the actual rule; this only applies it and skips
 * redundant native calls.
 */
interface NativeSuppressor {
  setCovered: (covered: boolean) => void
  setDragging: (dragging: boolean) => void
  setClosed: (closed: boolean) => void
}

function createSuppressor(element: ElectrobunWebviewElement): NativeSuppressor {
  let covered = false
  let dragging = false
  let closed = false
  let appliedHidden: boolean | null = null
  let appliedPassthrough: boolean | null = null

  const apply = () => {
    // Before the native view exists there is nothing to toggle; the applied
    // state stays untouched so the next evaluation re-applies once it does.
    if (element.webviewId == null) return
    const { hidden, passthrough } = computeSuppression({ covered, dragging, closed })
    if (appliedHidden !== hidden) {
      appliedHidden = hidden
      element.toggleHidden(hidden)
    }
    if (appliedPassthrough !== passthrough) {
      appliedPassthrough = passthrough
      element.togglePassthrough(passthrough)
    }
  }

  return {
    setCovered: (next) => {
      covered = next
      apply()
    },
    setDragging: (next) => {
      dragging = next
      apply()
    },
    setClosed: (next) => {
      closed = next
      apply()
    },
  }
}

/**
 * Keep the native view hidden exactly while the pane is covered. Returns a
 * teardown for the observers it installs.
 */
function watchOverlays(host: HTMLElement, suppressor: NativeSuppressor): () => void {
  const appRoot = host.closest("body > *")
  let frame = 0

  const evaluate = () => {
    // The locks are the explicit answer: every shared popup primitive holds one
    // while mounted, so a dialog ("always") or an overlapping popover
    // ("intersect") steps the native view aside however small it is — while a
    // menu on the far side of the window leaves the page alone. `paneCovered`
    // stays as the geometric fallback for overlays that take no lock at all
    // (in-tree toasts, drawers, anything hand-rolled).
    suppressor.setCovered(lockedOverlaysCoverRect(host.getBoundingClientRect()) || paneCovered(host))
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
  // A lock transition is applied in the same tick the popup mounts, so the
  // first click on it can never be eaten while a poll tick is pending.
  const stopLockWatch = subscribeOverlayLock(evaluate)
  schedule()

  return () => {
    observer.disconnect()
    window.clearInterval(poll)
    window.removeEventListener("resize", schedule)
    stopLockWatch()
    if (frame) cancelAnimationFrame(frame)
  }
}

/**
 * @param visible Whether the pane is open. It is NOT unmounted when closed:
 *   the native webview element may never leave the DOM (note 5 on the mount
 *   effect), so App keeps this component mounted for good once it has been
 *   opened and closing only hides it — both the DOM box and the native view.
 * @param baseUrl Live Chunky server to announce this pane to as a remotely
 *   drivable CDP target, or null when there is no connected server (offline,
 *   demo, browser-only dev) — in which case nothing is announced. A hidden but
 *   live pane keeps its announcement: it is still a drivable CDP target.
 */
export function BrowserPane({
  onClose,
  baseUrl,
  visible,
}: {
  onClose: () => void
  baseUrl?: string | null
  visible: boolean
}) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const webviewRef = useRef<ElectrobunWebviewElement | null>(null)
  // Owns the native view's hidden/passthrough state; created with the element.
  const suppressorRef = useRef<NativeSuppressor | null>(null)
  const [available] = useState(desktopWebviewAvailable)
  const initialUrlRef = useRef<string>("")
  // A link right-clicked into "Open in Chunky browser" before this pane existed
  // is parked in the store; it wins over the last visited URL. Only the very
  // first mount can see one — afterwards the pane is permanently mounted, so a
  // request while it is hidden arrives live through `subscribeBrowserNavigation`
  // and the store is cleared there.
  // Both candidates go through the policy: a parked request comes from a page
  // (or the server) and a persisted one from disk, so neither is trusted to be
  // a loadable http(s) URL. An unacceptable value falls back to the home page
  // rather than leaving the pane blank.
  if (!initialUrlRef.current) {
    initialUrlRef.current = resolveStartupUrl(takePendingBrowserUrl(), readLastUrl())
  }
  // The suppressor is created after an async round trip, and `visible` may have
  // changed by then, so the latest answer is kept where that callback can read
  // it rather than captured.
  const visibleRef = useRef(visible)
  visibleRef.current = visible
  const [url, setUrl] = useState(initialUrlRef.current)
  const [draft, setDraft] = useState(initialUrlRef.current)
  const [loading, setLoading] = useState(available)
  const [canGoBack, setCanGoBack] = useState(false)
  const [canGoForward, setCanGoForward] = useState(false)
  // A CDP target for this pane only exists once its page is up, so the server
  // cannot be told anything useful before that.
  const [paneLive, setPaneLive] = useState(false)
  // A refused address: shown inline in the toolbar, never as a dialog.
  const [addressError, setAddressError] = useState<string | null>(null)
  const addressErrorTimer = useRef(0)
  // The engine committed its own error document instead of the page we asked
  // for. `null` whenever a real page is showing.
  const [failure, setFailure] = useState<LoadFailure | null>(null)
  // What the pane last asked for, so a committed error page can be described in
  // terms of the request rather than `chrome-error://chromewebdata/`.
  const requestedUrlRef = useRef<string>(initialUrlRef.current)
  // The mount effect's event handlers are created once, before the navigation
  // callbacks below exist; this ref hands them the current one without making
  // the whole webview effect depend on it.
  const programmaticNavRef = useRef<((url: string) => void) | null>(null)

  // ── Address bar editing ───────────────────────────────────────────
  // True from focus until blur/commit: while it is true a page navigation may
  // not touch the field (`shouldSyncAddressDraft`).
  const [editing, setEditing] = useState(false)
  const editingRef = useRef(false)
  editingRef.current = editing
  const addressRef = useRef<HTMLInputElement | null>(null)
  // Set for exactly one mouseup after a focus-select, so the click that focused
  // the field cannot immediately collapse the selection.
  const justFocusedRef = useRef(false)

  // ── Find in page ────────────────────────────────────────────────
  const [find, setFind] = useState<FindState>(INITIAL_FIND_STATE)
  // The authoritative copy for `dispatchFind`, which must compute exactly one
  // transition per event (see there).
  const findRef = useRef<FindState>(INITIAL_FIND_STATE)
  // When the bar was last opened, for de-duplicating the two ⌘F routes.
  const lastFindOpenRef = useRef<number | null>(null)
  // Brief "Copied" state on the action menu's copy row; no toast.
  const [copied, setCopied] = useState(false)
  const copiedTimer = useRef(0)
  useEffect(() => () => window.clearTimeout(copiedTimer.current), [])
  const findInputRef = useRef<HTMLInputElement | null>(null)
  const paneRef = useRef<HTMLElement | null>(null)
  // Is the pane the surface the user is working in? Set from real DOM
  // interaction inside the pane, cleared by interaction anywhere else — so ⌘F
  // in the composer or a dialog is never claimed.
  const paneEngagedRef = useRef(false)
  // The error surface is painted over the pane, and a DOM overlay cannot cover
  // a natively composited view: holding the overlay lock is what makes the
  // suppressor step the page aside so this is both visible and clickable.
  useOverlayLock(failure != null, "always")

  const flagAddressError = useCallback((reason: string) => {
    setAddressError(reason)
    window.clearTimeout(addressErrorTimer.current)
    addressErrorTimer.current = window.setTimeout(() => setAddressError(null), ADDRESS_ERROR_MS)
  }, [])

  useEffect(() => () => window.clearTimeout(addressErrorTimer.current), [])

  // ── Cookie sync ──────────────────────────────────────────────────────────
  // The first-launch offer, and the site picker it opens. `firstRunComplete`
  // lives on the Bun side (never localStorage); the ref only stops this launch
  // from asking twice if the pane remounts.
  const [cookiePrompt, setCookiePrompt] = useState(false)
  const [cookieModal, setCookieModal] = useState(false)
  const cookieAskedRef = useRef(false)
  // The offer is painted over the pane itself, so it needs the native view out
  // of the way just as much as a portaled dialog does — "always", since it is
  // by definition over the pane. Holding the overlay lock replaces the full-pane
  // scrim that existed only to trip the geometric probe.
  useOverlayLock(cookiePrompt, "always")

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
  // The rect currently written to the stage; `resolveStageRect` compares against
  // it so layout jitter costs no native resize.
  const stageRectRef = useRef<PaneRect | null>(null)

  /**
   * Keep the stage exactly over the pane slot.
   *
   * This is what replaces "the element is a child of the slot": the element
   * fills the stage, so the rect Electrobun's OverlaySyncController reads off
   * the element is the slot's rect. It runs before every forced sync, on every
   * width change, and on a cheap observer + poll pair for layout changes this
   * component never hears about (sidebar toggles, window chrome, fullscreen).
   */
  const syncStage = useCallback(() => {
    stageRectRef.current = syncStageRect(hostRef.current, visibleRef.current, stageRectRef.current)
  }, [])

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
      // Stage first: the element's rect IS the stage's rect, so a forced sync
      // before the box moved would push the previous geometry.
      syncStage()
      webviewRef.current?.syncDimensions(true)
    })
  }, [syncStage])

  // Layout changes that never reach this component still have to move the
  // stage. A ResizeObserver on the slot catches size changes; the poll catches
  // pure moves (the slot's x can change without its box resizing).
  useEffect(() => {
    if (!available) return
    const host = hostRef.current
    if (!host) return
    syncStage()
    const observer = new ResizeObserver(() => syncStage())
    observer.observe(host)
    // 100ms matches Electrobun's own OverlaySyncController cadence, so a pure
    // move (the files pane taking the slot next door, say) settles in about the
    // same time a resize did before the element left the React tree.
    const poll = window.setInterval(syncStage, STAGE_POLL_MS)
    return () => {
      observer.disconnect()
      window.clearInterval(poll)
    }
  }, [available, syncStage])

  /**
   * Closing the pane is a visibility change, not a teardown (note 5 on the
   * mount effect): the DOM box goes to `display: none` in the markup below, and
   * the native view — composited by the OS, entirely outside the DOM's reach —
   * is hidden and made passthrough here. Re-opening pushes the geometry back,
   * since the element measured 0×0 for the whole time it was hidden.
   */
  useEffect(() => {
    suppressorRef.current?.setClosed(!visible)
    if (visible) scheduleOverlaySync()
  }, [visible, scheduleOverlaySync])

  // The stage is body-level, so it does not disappear with the pane's DOM box:
  // hiding is the suppressor's job, and the geometry is simply frozen while the
  // pane is closed (see `resolveStageRect`).

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
    // Routed through the suppressor so a drag that starts or ends while an
    // overlay is up cannot clobber the overlay's own passthrough state.
    suppressorRef.current?.setDragging(dragging)
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
  //    DOM wired to a torn-down native view. "Destroy" parks rather than
  //    removes, and the second mount REUSES the parked element (module-level
  //    `liveWebview`), so a remount never produces a second native view.
  // 3b. The element is appended to the body-level STAGE, never to React-owned
  //    DOM: see `getBrowserStage`. React unmounting this component — or the
  //    whole root, while unwinding from an uncaught render error — therefore
  //    cannot disconnect it, which is the difference between "the app shows a
  //    fallback" and "the app exits" (note 5).
  // 4. The renderer kind (CEF vs system WebView) is a bun-process answer, so
  //    creation waits on one cached round trip; `cancelled` keeps an unmount
  //    inside that window from creating any native view at all.
  // 5. Once the native view exists, this element must never leave the DOM — not
  //    removed, and not REPARENTED with `appendChild` either. Verified against
  //    the installed Electrobun (1.18.1, CEF 147), the chain is:
  //
  //      disconnectedCallback → `webviewTagRemove` → `BrowserView.remove()`
  //        → `-[CEFWebViewImpl remove]` → `CloseBrowser(false)`
  //        → CEF's default close for a `SetAsChild` browser, i.e.
  //          `CloseHostWindow()` = `performClose:` on the browser view's window
  //          — which is OUR MAIN WINDOW, since the pane's CEF browser is a
  //          child NSView of it
  //        → `-[WindowDelegate windowWillClose:]` → Electrobun's `close` event
  //        → BrowserWindow.ts empties `BrowserWindowMap` and, with
  //          `exitOnLastWindowClosed` defaulting to true, calls `quit()`
  //        → `stopEventLoop()` + `forceExit(0)`: a silent exit, no crash report.
  //
  //    (`CefQuitMessageLoop` is NOT what does it in this version — it is only
  //    reachable from `stopEventLoop`, i.e. from `quit()` itself.) Moving a
  //    connected node with `appendChild` is a remove+insert whose
  //    custom-element reactions run synchronously, so "parking" a live element
  //    triggers the same chain (and `connectedCallback` then re-runs
  //    `initWebview`, creating a second view). Hence: closing the pane HIDES it
  //    (`visible`), App keeps BrowserPane mounted for the rest of the app's
  //    life once it has been opened, and `destroyWebview` PARKS rather than
  //    removes anything that has (or may still get) a native view.
  useEffect(() => {
    if (!available) return
    const host = hostRef.current
    if (!host) return

    const mount = (rendererKind: "cef" | "native"): (() => void) | null => {
      // Reuse the element this process already owns, if there is one: it can
      // never be destroyed, so a second one would be a second permanent native
      // view stacked on the same slot.
      const reused = liveWebview
      const element = reused ?? (document.createElement("electrobun-webview") as ElectrobunWebviewElement)
      if (typeof element.on !== "function") return null

      // Native-view creation is deferred to a rAF; knowing whether it actually
      // started tells teardown whether removal is still safe. A reused element
      // has been through that already.
      let initStarted = reused != null
      if (!reused) {
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
        // Take `window.close()` away from the guest page: a page that closes
        // itself would otherwise close this app's main window and exit the
        // process (see note 5 and `~/lib/browserGuest`). The attribute is the
        // early path (it runs before page scripts where Electrobun honours a
        // custom preload); `injectGuard` below re-applies it on every navigation
        // so the guard does not depend on that.
        element.setAttribute("preload", GUEST_GUARD_SCRIPT)
        element.setAttribute("src", initialUrlRef.current)
        // Electrobun injects an unlayered `electrobun-webview { width:800px;
        // height:300px }` default style, which outranks Tailwind's layered
        // utilities. Inline styles are the only reliable way to size the element —
        // and the element's rect is exactly where the native webview is composited
        // (here: the stage's rect, which tracks the pane slot).
        element.style.cssText =
          "display:block;position:absolute;inset:0;width:100%;height:100%;background:transparent;"
      }

      // Re-arm the guest guard. The script is static and idempotent, so running
      // it on every navigation event costs nothing after the first hit of a
      // given document and covers the case where the `preload` attribute is not
      // applied to sandboxed CEF views.
      const injectGuard = () => {
        try {
          element.executeJavascript(GUEST_GUARD_SCRIPT)
        } catch {
          // No native side yet (or already gone): the next event re-tries.
        }
      }
      const onNavigate = (event: CustomEvent) => {
        injectGuard()
        const next = urlFromDetail(event.detail) ?? element.src
        if (next) {
          // The only load-failure signal this stack actually produces: the
          // engine navigating to its own error document (see
          // `~/lib/browserLoadState` — there is no did-fail-load event here).
          const detected = describeLoadFailure(next, requestedUrlRef.current)
          if (detected) setFailure(detected)
          else if (shouldClearFailure(next)) setFailure(null)
          // An error page's URL is not an address: keep showing what was asked
          // for, and never persist it as the next launch's start-up page.
          if (!isErrorPageUrl(next)) {
            requestedUrlRef.current = next
            setUrl(next)
            // The page owns the field only while the user does not: a redirect
            // landing mid-typing must not overwrite a half-typed address.
            setDraft((current) =>
              shouldSyncAddressDraft({ editing: editingRef.current, committed: next, draft: current })
                ? next
                : current,
            )
            persistUrl(next)
          }
          // Highlights belong to the document that just went away.
          dispatchFindRef.current({ type: "navigated" })
        }
        setLoading(false)
        setPaneLive(true)
        syncHistory(element)
      }
      const onDomReady = () => {
        injectGuard()
        setLoading(false)
        setPaneLive(true)
        syncHistory(element)
      }
      // The guarded page asked to close itself. There are no tabs and the pane
      // is never torn down, so the useful reading of "close me" is "go back to
      // whatever opened me" (the common case: an auth flow that ends on a
      // self-closing page). With no history to go back to, stay put.
      const onHostMessage = (event: CustomEvent) => {
        if (!isPageCloseRequest(event.detail)) return
        void element
          .canGoBack()
          .then((back) => {
            if (!back) return
            // Going back can only reach entries this pane already accepted on
            // the way in (every entry point is policy-checked), so there is no
            // URL to re-validate here — and the committed URL is checked again
            // by `onNavigate` when it arrives.
            setLoading(true)
            setFailure(null)
            element.goBack()
          })
          .catch(() => {
            // Nothing to do: the page stays where it is.
          })
      }
      // Links that ask for a new window stay in the pane; there is no tab UI.
      // The target comes from the page, so it is policy-checked like any other
      // programmatic navigation — a `javascript:`/`file:`/custom-scheme popup
      // target is refused with an inline note instead of being loaded.
      const onNewWindow = (event: CustomEvent) => {
        const next = urlFromDetail(event.detail)
        if (!next) return
        programmaticNavRef.current?.(next)
      }

      element.on("did-navigate", onNavigate)
      element.on("did-navigate-in-page", onNavigate)
      element.on("did-commit-navigation", onNavigate)
      element.on("dom-ready", onDomReady)
      element.on("new-window-open", onNewWindow)
      element.on("host-message", onHostMessage)

      // Into the stage — NOT into `host`, which React owns. `syncStage` has
      // already put the stage over the slot, and keeps it there.
      syncStage()
      if (element.parentElement !== getBrowserStage()) getBrowserStage().appendChild(element)
      liveWebview = element
      webviewRef.current = element

      if (reused) {
        // The page is already there: adopt its state instead of waiting for
        // lifecycle events that will not fire again for this document.
        const current = element.src
        if (current) {
          setUrl(current)
          setDraft(current)
        }
        const live = element.webviewId != null
        setLoading(!live)
        setPaneLive(live)
        if (live) {
          syncHistory(element)
          injectGuard()
        }
      }
      // The suppressor is created after an async round trip, so the pane may
      // already be closed by the time it exists: seed it from the ref that
      // tracks the latest `visible` rather than assuming an open pane.
      const suppressor = createSuppressor(element)
      suppressor.setClosed(!visibleRef.current)
      suppressorRef.current = suppressor
      const stopOverlayWatch = watchOverlays(host, suppressor)

      return () => {
        element.off("did-navigate", onNavigate)
        element.off("did-navigate-in-page", onNavigate)
        element.off("did-commit-navigation", onNavigate)
        element.off("dom-ready", onDomReady)
        element.off("new-window-open", onNewWindow)
        element.off("host-message", onHostMessage)
        stopOverlayWatch()
        if (suppressorRef.current === suppressor) suppressorRef.current = null
        if (webviewRef.current === element) webviewRef.current = null
        // Reached at app teardown, on a StrictMode double-invoke, and when the
        // root error boundary rebuilds the tree — closing the pane only hides
        // it, see note 5. The element itself survives all of these (it lives in
        // the stage); it is only forgotten when it was safe to remove.
        if (!destroyWebview(element, () => initStarted) && liveWebview === element) liveWebview = null
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
  }, [available, syncHistory, syncStage])

  /**
   * The single way anything gets loaded in this pane.
   *
   * Every caller — the address bar, `new-window-open`, the server's
   * `app.open_url`, a restored link — lands here, and nothing reaches
   * `loadURL` without having been through the policy first.
   */
  const load = useCallback(
    (nextUrl: string) => {
      requestedUrlRef.current = nextUrl
      setFailure(null)
      setAddressError(null)
      setUrl(nextUrl)
      setDraft(nextUrl)
      persistUrl(nextUrl)
      setLoading(true)
      webviewRef.current?.loadURL(nextUrl)
    },
    [],
  )

  /** Address-bar semantics: URLs load, bare terms search, bad schemes refuse. */
  const navigate = useCallback(
    (rawUrl: string) => {
      const resolved = resolveAddressInput(rawUrl)
      if (!resolved.ok) {
        flagAddressError(resolved.reason)
        return
      }
      load(resolved.url)
    },
    [flagAddressError, load],
  )

  /** Programmatic navigation: a URL or nothing — never a search. */
  const navigateProgrammatically = useCallback(
    (rawUrl: string) => {
      const resolved = resolveProgrammaticUrl(rawUrl)
      if (!resolved.ok) {
        flagAddressError(resolved.reason)
        return
      }
      load(resolved.url)
    },
    [flagAddressError, load],
  )

  programmaticNavRef.current = navigateProgrammatically

  /**
   * Run one find-bar transition and send the resulting command to the view.
   *
   * `findInPage`/`stopFindInPage` map to `CefBrowserHost::Find` /
   * `StopFinding` — real, and the only part of CEF's find API that reaches us
   * (no match counts, see `~/lib/browserFind`).
   */
  const dispatchFind = useCallback((event: FindEvent) => {
    if (event.type === "open") {
      // One keystroke can arrive twice (DOM keydown + the native menu's key
      // equivalent); a second `open` would re-issue the search and skip a match.
      const now = Date.now()
      if (isDuplicateFindOpen(lastFindOpenRef.current, now)) return
      lastFindOpenRef.current = now
    }
    // Deliberately NOT inside a `setFind` updater: React double-invokes
    // updaters in StrictMode, which would issue every Find twice — and a
    // repeated Find with the same text steps to the next match.
    const { state: next, command, focusInput } = findReducer(findRef.current, event)
    findRef.current = next
    setFind(next)
    const view = webviewRef.current
    if (command?.kind === "find") view?.findInPage(command.text, { forward: command.forward })
    else if (command?.kind === "stop") view?.stopFindInPage()
    if (focusInput) {
      // The input may be mounting in this very commit.
      requestAnimationFrame(() => {
        findInputRef.current?.focus()
        findInputRef.current?.select()
      })
    }
  }, [])
  const dispatchFindRef = useRef(dispatchFind)
  dispatchFindRef.current = dispatchFind

  /** Retry the page the error surface is about. */
  const retryFailedLoad = useCallback(() => {
    const target = failure?.url
    setFailure(null)
    setLoading(true)
    if (target && isAllowedPaneUrl(target)) {
      webviewRef.current?.loadURL(target)
      return
    }
    webviewRef.current?.reload()
  }, [failure])

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

  /**
   * ⌘F opens the find bar — but only for a pane the user is actually in.
   *
   * Following the app's Esc-to-stop convention (App.tsx): claim the key only
   * from the owning surface, never globally. "In the pane" is tracked from real
   * DOM interaction; note that while focus is inside the native view the host
   * WebView receives no key events at all, so ⌘F over the page itself cannot be
   * seen here — it works from the pane's chrome (address bar, toolbar, find
   * bar), which is where a keyboard user will be.
   */
  useEffect(() => {
    if (!available) return
    const insidePane = (target: EventTarget | null) =>
      target instanceof Node && paneRef.current?.contains(target) === true

    const onPointerDown = (event: PointerEvent) => {
      paneEngagedRef.current = insidePane(event.target)
    }
    const onFocusIn = (event: FocusEvent) => {
      paneEngagedRef.current = insidePane(event.target)
    }
    const onPaneEnter = () => {
      paneEngagedRef.current = true
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        !shouldClaimFindShortcut({
          key: event.key,
          metaKey: event.metaKey,
          ctrlKey: event.ctrlKey,
          altKey: event.altKey,
          defaultPrevented: event.defaultPrevented,
          paneVisible: visibleRef.current,
          paneEngaged: paneEngagedRef.current,
          // A dialog or the palette is a body-level overlay over the pane; the
          // overlay guard already knows about them.
          overlayOpen: lockedOverlaysCoverRect(
            paneRef.current?.getBoundingClientRect() ?? new DOMRect(0, 0, 0, 0),
          ),
        })
      ) {
        return
      }
      event.preventDefault()
      dispatchFindRef.current({ type: "open" })
    }

    const pane = paneRef.current
    window.addEventListener("pointerdown", onPointerDown, true)
    window.addEventListener("focusin", onFocusIn, true)
    pane?.addEventListener("pointerenter", onPaneEnter)
    window.addEventListener("keydown", onKeyDown)
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true)
      window.removeEventListener("focusin", onFocusIn, true)
      pane?.removeEventListener("pointerenter", onPaneEnter)
      window.removeEventListener("keydown", onKeyDown)
    }
  }, [available])

  /**
   * `Edit ▸ Find…` (⌘F) from the native menu.
   *
   * This is the route that works when focus is inside the native view, where
   * the renderer sees no keys at all. Engagement cannot be known in that case
   * (the click that focused the page never reached the DOM), so VISIBILITY is
   * the gate: a hidden pane ignores the item rather than popping open.
   */
  useEffect(() => {
    if (!available) return
    return onBrowserFindRequested(() => {
      const active = document.activeElement
      const editable =
        active instanceof HTMLElement &&
        (active instanceof HTMLInputElement ||
          active instanceof HTMLTextAreaElement ||
          active.isContentEditable)
      if (
        !shouldOpenFromMenuSignal({
          paneVisible: visibleRef.current,
          activeInsidePane: active instanceof Node && paneRef.current?.contains(active) === true,
          activeIsEditable: editable,
        })
      ) {
        return
      }
      dispatchFindRef.current({ type: "open" })
    })
  }, [available])

  // A hidden pane must not keep a find bar (or its highlights) alive.
  useEffect(() => {
    if (!visible && find.open) dispatchFind({ type: "close" })
  }, [visible, find.open, dispatchFind])

  // Navigation requests that arrive while the pane is already open.
  useEffect(
    () =>
      subscribeBrowserNavigation((next) => {
        // Clear the parked request so a later remount does not repeat it.
        takePendingBrowserUrl()
        // Server- and page-originated: policy-checked, never searched.
        navigateProgrammatically(next)
      }),
    [navigateProgrammatically],
  )

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setEditing(false)
    addressRef.current?.blur()
    navigate(draft)
  }

  /** Escape in the address bar: put the real URL back and leave the field. */
  const onAddressKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    const action = resolveAddressKey({ key: event.key, committed: url, draft })
    if (!action) return
    event.preventDefault()
    // Claim it so App's Esc handling (and AppKit's "exit fullscreen") does not
    // also act on this key.
    event.stopPropagation()
    if (action.type === "revert") setDraft(action.url)
    setAddressError(null)
    setEditing(false)
    event.currentTarget.blur()
  }

  return (
    <aside
      className={cn(
        "relative flex min-h-0 min-w-[20rem] flex-none flex-col border-border/70 border-l bg-background/70",
        // Closed, not unmounted: `display: none` takes it out of the layout and
        // paints nothing, while the element (and its native view) stays put.
        !visible && "hidden",
      )}
      style={{ width: paneWidth }}
      aria-label="Browser pane"
      aria-hidden={!visible}
      data-browser-pane=""
      ref={paneRef}
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
        <Button type="button" variant="ghost" size="icon-sm" disabled={!available || !canGoBack} onClick={() => { setLoading(true); setFailure(null); webviewRef.current?.goBack() }} aria-label="Back">
          <ArrowLeft />
        </Button>
        <Button type="button" variant="ghost" size="icon-sm" disabled={!available || !canGoForward} onClick={() => { setLoading(true); setFailure(null); webviewRef.current?.goForward() }} aria-label="Forward">
          <ArrowRight />
        </Button>
        <Button type="button" variant="ghost" size="icon-sm" disabled={!available} onClick={() => { setLoading(true); setFailure(null); webviewRef.current?.reload() }} aria-label="Reload">
          <RotateCw className={cn(loading && "animate-spin")} />
        </Button>
        <div className="relative min-w-0 flex-1">
          <Globe2 className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            ref={addressRef}
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value)
              setEditing(true)
              if (addressError) setAddressError(null)
            }}
            onKeyDown={onAddressKeyDown}
            onFocus={(event) => {
              // Every real browser selects the whole address on focus, however
              // the field was reached (click, Tab, ⌘L-style focus).
              setEditing(true)
              justFocusedRef.current = true
              event.currentTarget.select()
            }}
            onBlur={() => setEditing(false)}
            onMouseUp={(event) => {
              // A click that focused the field would otherwise collapse the
              // selection `onFocus` just made when the mouse comes back up.
              if (!justFocusedRef.current) return
              justFocusedRef.current = false
              event.preventDefault()
            }}
            placeholder="Search or enter URL"
            spellCheck={false}
            title={url}
            className={cn(
              "h-8 w-full rounded-lg border bg-muted/30 py-1 pl-8 pr-3 text-[12px] text-foreground outline-none placeholder:text-muted-foreground/70 focus:ring-[3px]",
              addressError
                ? "border-destructive ring-[3px] ring-destructive/20 focus:border-destructive focus:ring-destructive/25"
                : "border-input focus:border-ring focus:ring-ring/25",
            )}
            aria-label="Browser address"
            aria-invalid={addressError ? true : undefined}
          />
        </div>
        {/* Pane actions. Base UI menu, portaled to <body> — which is exactly
            what the native-view overlay guard scans, so the popup makes the
            page step aside while it overlaps and no further wiring is needed. */}
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              // `type="button"` matters here and not in the other menus in the
              // app: this trigger lives inside the address <form>, where the
              // default submit type would navigate on click.
              <Button type="button" variant="ghost" size="icon-sm" className={NO_DRAG_REGION} aria-label="Browser actions" />
            }
          >
            <MoreHorizontal />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              disabled={!isAllowedPaneUrl(url)}
              onClick={() => {
                // The shared helper only ever hands http(s) to the Bun process,
                // which spawns the OS handler with an argument array.
                openExternal(url)
              }}
            >
              <ExternalLink />
              Open in system browser
            </DropdownMenuItem>
            <DropdownMenuItem
              closeOnClick={false}
              disabled={!url}
              onClick={() => {
                void copyText(url).then((ok) => {
                  if (!ok) return
                  setCopied(true)
                  window.clearTimeout(copiedTimer.current)
                  copiedTimer.current = window.setTimeout(() => setCopied(false), 1_500)
                })
              }}
            >
              {copied ? <Check /> : <Copy />}
              {copied ? "Copied" : "Copy link"}
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={!available}
              onClick={() => dispatchFind({ type: "open" })}
            >
              <Search />
              Find in page
              <span className="ml-auto pl-4 font-mono text-[11px] text-muted-foreground">⌘F</span>
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={!available || !paneLive}
              onClick={() => webviewRef.current?.openDevTools()}
            >
              <SquareTerminal />
              Open DevTools
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Button type="button" variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close browser">
          <X />
        </Button>
      </form>

      {/* A refused address (`javascript:`, `file:`, a custom scheme, junk):
          inline and self-clearing, never a dialog. It sits in the toolbar
          column — above the native view's rect — so it needs no overlay lock. */}
      {addressError ? (
        <div
          role="status"
          aria-live="polite"
          className="shrink-0 border-border/70 border-b bg-destructive/5 px-3 py-1.5 text-[11.5px] text-destructive"
        >
          {addressError}
        </div>
      ) : null}

      {/* Find bar. Docked in the pane's CHROME COLUMN, above the slot — not
          floated over the page. That is deliberate: the native view is
          composited above all DOM and Electrobun's mask support clips paint
          without a `hitTest:` override, so a bar drawn over the page would be
          invisible, unclickable, or both. Sitting outside the native view's
          rect (the slot shrinks by this bar's height and `syncStage` follows)
          it is simply real DOM. No overlay lock: hiding the page to search it
          would be absurd. */}
      {find.open ? (
        <div
          className={cn(
            NO_DRAG_REGION,
            "flex h-9 shrink-0 items-center gap-1 border-border/70 border-b bg-muted/20 px-2",
          )}
          role="search"
        >
          <Search className="pointer-events-none ml-1 size-3.5 shrink-0 text-muted-foreground" />
          <input
            ref={findInputRef}
            value={find.query}
            onChange={(event) => dispatchFind({ type: "query", value: event.target.value })}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault()
                dispatchFind({ type: event.shiftKey ? "previous" : "next" })
              } else if (event.key === "Escape") {
                event.preventDefault()
                event.stopPropagation()
                dispatchFind({ type: "close" })
              }
            }}
            placeholder="Find in page"
            spellCheck={false}
            aria-label="Find in page"
            className="h-7 min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-1.5 text-[12px] text-foreground outline-none placeholder:text-muted-foreground/70 focus:border-ring focus:bg-muted/40"
          />
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            disabled={!find.query}
            onClick={() => dispatchFind({ type: "previous" })}
            aria-label="Previous match"
          >
            <ChevronUp />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            disabled={!find.query}
            onClick={() => dispatchFind({ type: "next" })}
            aria-label="Next match"
          >
            <ChevronDown />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            onClick={() => dispatchFind({ type: "close" })}
            aria-label="Close find bar"
          >
            <X />
          </Button>
        </div>
      ) : null}

      <div className="relative min-h-0 flex-1 overflow-hidden bg-muted/30">
        {available ? (
          // The pane SLOT. The webview element is not a child of this box — it
          // lives in the body-level stage, which is kept exactly over this rect
          // (`syncStage`) so the native view is composited here anyway. Keeping
          // it out of React's tree is what makes the pane survive an unmount of
          // the app (note 5 / AppErrorBoundary). This box must stay empty of
          // anything meant to be SEEN: the native view paints over it.
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
        {available && loading && !failure ? (
          <LoaderCircle className="pointer-events-none absolute right-3 top-3 size-4 animate-spin text-primary" aria-label="Loading" />
        ) : null}

        {/* Load failure. A DOM overlay cannot cover a natively composited view,
            so this is only visible AND clickable because `useOverlayLock`
            (above) makes the suppressor hide the native view for as long as
            `failure` is set — the same mechanism dialogs and the cookie card
            use. Sibling of the slot, not a child of it, for the same reason. */}
        {failure ? (
          <div
            role="alert"
            className={cn(NO_DRAG_REGION, "absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-background px-7 text-center")}
          >
            <div className="flex size-10 items-center justify-center rounded-xl border border-destructive/20 bg-destructive/10 text-destructive">
              <TriangleAlert className="size-5" />
            </div>
            <div className="min-w-0">
              <p className="truncate font-medium text-[13px] text-foreground">Couldn't load {failure.host}</p>
              <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">
                {failure.reason
                  ? `The page could not be reached (${failure.reason}).`
                  : "The page could not be reached. Check the address and your connection."}
              </p>
            </div>
            <Button size="sm" onClick={retryFailedLoad}>
              Retry
            </Button>
          </div>
        ) : null}

        {/* First-launch cookie offer. Deliberately a sibling of the webview
            host rather than a child of it, and it holds the overlay lock while
            it is up (see `useOverlayLock(cookiePrompt)` above), which is what
            makes this card both visible and clickable over the composited page.
            The card is far too small for `probeCovered`'s coarse grid to land
            on reliably, so the lock — not geometry — is what guarantees the
            native view steps aside. */}
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
      <CookieSyncModal
        open={cookieModal}
        onOpenChange={setCookieModal}
        onSynced={() => {
          // Synced cookies only apply to the next request, so reload the pane's
          // current page to pick up the freshly imported session.
          setLoading(true)
          setFailure(null)
          webviewRef.current?.reload()
        }}
      />
    </aside>
  )
}
