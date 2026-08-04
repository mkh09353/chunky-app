// Width of the in-app browser side pane.
//
// This is a disposable renderer preference — it describes how one window is
// arranged right now, not anything the server or another client needs to know —
// so it lives in `localStorage` rather than in Bun-managed desktop settings.
// Losing it costs the user one drag.

const WIDTH_KEY = "chunky.browser.paneWidth"

/** Never narrower than this; agrees with the pane's own `min-w-[20rem]`. */
export const MIN_PANE_WIDTH = 320

/** The chat side of the split has to stay usable, so the pane stops at 70%. */
export const MAX_PANE_FRACTION = 0.7

/** What the pane opens at before the user has ever dragged it. */
export const DEFAULT_PANE_FRACTION = 0.44

/**
 * The widest the pane may be in a window this wide.
 *
 * A very narrow window can push the fraction under {@link MIN_PANE_WIDTH}; the
 * minimum wins there, so the pane stays usable and simply covers more of the
 * window (which is the honest outcome — there is no width that satisfies both).
 */
export function maxPaneWidth(windowWidth: number): number {
  if (!Number.isFinite(windowWidth) || windowWidth <= 0) return MIN_PANE_WIDTH
  return Math.max(MIN_PANE_WIDTH, Math.round(windowWidth * MAX_PANE_FRACTION))
}

/** Snap any candidate width into the range allowed by this window width. */
export function clampPaneWidth(width: number, windowWidth: number): number {
  const max = maxPaneWidth(windowWidth)
  if (!Number.isFinite(width)) return Math.min(defaultPaneWidth(windowWidth), max)
  return Math.min(max, Math.max(MIN_PANE_WIDTH, Math.round(width)))
}

/** The first-run width: today's `basis-[44%]`, frozen into pixels. */
export function defaultPaneWidth(windowWidth: number): number {
  if (!Number.isFinite(windowWidth) || windowWidth <= 0) return MIN_PANE_WIDTH
  return Math.max(MIN_PANE_WIDTH, Math.round(windowWidth * DEFAULT_PANE_FRACTION))
}

/**
 * The width the user last chose, ignoring what fits right now.
 *
 * Kept separate from {@link readPaneWidth} so a spell in a small window cannot
 * quietly shrink the preference: the pane is clamped to what fits, but the
 * chosen width is what it returns to once there is room again.
 */
export function readPreferredPaneWidth(windowWidth: number): number {
  let stored: string | null = null
  try {
    stored = localStorage.getItem(WIDTH_KEY)
  } catch {
    // Storage may be unavailable in private/locked-down contexts.
  }
  const parsed = stored == null ? Number.NaN : Number.parseFloat(stored)
  if (!Number.isFinite(parsed) || parsed <= 0) return defaultPaneWidth(windowWidth)
  return Math.max(MIN_PANE_WIDTH, Math.round(parsed))
}

/**
 * Stored width for this window size, or the default when nothing usable is
 * stored. Always clamped: the window may well have been resized (or moved to
 * another display) since the width was written.
 */
export function readPaneWidth(windowWidth: number): number {
  return clampPaneWidth(readPreferredPaneWidth(windowWidth), windowWidth)
}

/** Remember a width the user chose. Best effort; failure is not worth surfacing. */
export function persistPaneWidth(width: number) {
  try {
    localStorage.setItem(WIDTH_KEY, String(Math.round(width)))
  } catch {
    // Storage may be unavailable in private/locked-down contexts.
  }
}
