// Geometry for the browser pane's React-independent stage.
//
// The `<electrobun-webview>` element does NOT live inside the React tree. It
// lives in a body-level "stage" div created imperatively, because ANY
// disconnection of that element — including React removing one of its ancestors
// while unwinding from an uncaught render error — sends `webviewTagRemove`,
// which closes a `SetAsChild` CEF browser, which closes the app's main window,
// which exits the process (see `browserGuest.ts` for the full chain).
//
// The price of hosting it outside React is that its rect no longer follows the
// pane slot automatically, and the rect is not cosmetic: Electrobun's
// `OverlaySyncController` reads `element.getBoundingClientRect()` and that rect
// is exactly where the native view is composited. So the stage is kept exactly
// over the pane slot, and this module owns the rule for when to write a new
// rect — deliberately pure, so the interesting cases are testable without a DOM.

export interface PaneRect {
  x: number
  y: number
  width: number
  height: number
}

/** Sub-pixel equality: layout jitter must not cost a native resize round trip. */
export function rectsEqual(a: PaneRect | null, b: PaneRect | null, epsilon = 0.5): boolean {
  if (!a || !b) return a === b
  return (
    Math.abs(a.x - b.x) <= epsilon &&
    Math.abs(a.y - b.y) <= epsilon &&
    Math.abs(a.width - b.width) <= epsilon &&
    Math.abs(a.height - b.height) <= epsilon
  )
}

export interface StageRectInput {
  /** The pane slot's current rect, or null when there is no slot element. */
  slot: PaneRect | null
  /** Is the pane open? A closed pane is `display: none`, so its rect is 0x0. */
  visible: boolean
  /** The rect currently applied to the stage. */
  previous: PaneRect | null
}

/**
 * The rect to write to the stage, or null for "leave it exactly as it is".
 *
 * Why a hidden pane keeps its last rect instead of collapsing to 0x0 or being
 * parked off-screen: resizing the native view reflows the guest page and loses
 * its scroll position, and Electrobun's sync ignores 0x0 rects anyway. Closing
 * the pane is a visibility change (`toggleHidden` + passthrough, owned by the
 * suppressor), so the geometry is simply frozen until it is shown again.
 */
export function resolveStageRect({ slot, visible, previous }: StageRectInput): PaneRect | null {
  if (!visible) return null
  if (!slot || slot.width < 1 || slot.height < 1) return null
  if (rectsEqual(previous, slot)) return null
  return { x: slot.x, y: slot.y, width: slot.width, height: slot.height }
}

/**
 * Is `node` part of the pane's own machinery (the slot or the stage), rather
 * than an overlay painted on top of it?
 *
 * The overlay guard hides the native view whenever something covers the pane.
 * Moving the webview to a body-level stage puts a new element *above* the slot
 * in both the layer scan and `elementFromPoint`, and without this the guard
 * would read the pane's own stage as an overlay covering the pane and hide the
 * page forever.
 */
export function isPaneOwnedNode(
  node: Node | null,
  host: { contains: (node: Node | null) => boolean } | null,
  stage: { contains: (node: Node | null) => boolean } | null,
): boolean {
  if (!node) return false
  if (host && (node === (host as unknown as Node) || host.contains(node))) return true
  if (stage && (node === (stage as unknown as Node) || stage.contains(node))) return true
  return false
}
