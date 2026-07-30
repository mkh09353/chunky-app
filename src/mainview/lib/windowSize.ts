// "Is this window effectively full-screen?" — the gate for the agent-gutter
// layout. The gutter only earns its space on a maximized/fullscreen window; in
// any smaller window the chat renders full width and agent cards fall inline.
//
// Two runtimes to satisfy, and they report window size differently:
//
//   Chrome/Safari  outerWidth/Height = the whole browser window (chrome
//                  included), innerHeight is ~100px smaller. Maximized →
//                  outerHeight ≈ screen.availHeight.
//   Electrobun     WKWebView reports outerWidth/Height as **0 x 0** (measured
//                  with a native WKWebView harness, not assumed), so an
//                  outer-only check would say "never maximized" forever.
//                  inner* is the real signal there, and screen.avail* IS
//                  reported correctly (1710x1008 on a 1710x1107 display).
//
// Taking max(outer, inner) satisfies both without branching on the runtime.
// Measured slack when maximized in WKWebView: width 0, height 32 (title bar).
import { useEffect, useState } from "react"

export interface WindowMetrics {
  innerWidth: number
  innerHeight: number
  outerWidth: number
  outerHeight: number
  availWidth: number
  availHeight: number
  /** True while the Fullscreen API is engaged. */
  fullscreen: boolean
}

/** Width slack: a maximized window matches the available width almost exactly. */
const WIDTH_TOLERANCE = 8
/** Height slack: enough to forgive a native title bar, not a half-height window. */
const HEIGHT_TOLERANCE = 48

/** Fallback for when the screen metrics are missing entirely: treat a
 *  generously large window as full-size rather than never engaging. */
const FALLBACK_MIN_WIDTH = 1440
const FALLBACK_MIN_HEIGHT = 820

/** Only genuinely absent metrics are unusable. A window LARGER than the
 *  available area is not a lie — it is native fullscreen, which covers the menu
 *  bar; the comparison below handles that as a negative difference. */
function screenMetricsUsable(m: WindowMetrics): boolean {
  return m.availWidth > 0 && m.availHeight > 0
}

/** Pure predicate — the whole point of splitting this out is that it is testable
 *  without a DOM. */
export function isFullSizeWindow(m: WindowMetrics): boolean {
  if (m.fullscreen) return true
  const w = Math.max(m.outerWidth, m.innerWidth)
  const h = Math.max(m.outerHeight, m.innerHeight)
  if (!screenMetricsUsable(m)) {
    return w >= FALLBACK_MIN_WIDTH && h >= FALLBACK_MIN_HEIGHT
  }
  return m.availWidth - w <= WIDTH_TOLERANCE && m.availHeight - h <= HEIGHT_TOLERANCE
}

export function readWindowMetrics(): WindowMetrics {
  if (typeof window === "undefined") {
    return {
      innerWidth: 0,
      innerHeight: 0,
      outerWidth: 0,
      outerHeight: 0,
      availWidth: 0,
      availHeight: 0,
      fullscreen: false,
    }
  }
  const screen = window.screen as Screen | undefined
  return {
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    outerWidth: window.outerWidth,
    outerHeight: window.outerHeight,
    availWidth: screen?.availWidth ?? 0,
    availHeight: screen?.availHeight ?? 0,
    fullscreen: !!document.fullscreenElement,
  }
}

/** Live "window is maximized / fullscreen" flag.
 *
 *  Updates are rAF-coalesced, and state is only set when the answer actually
 *  flips, so dragging a window edge can't spin the transcript layout. */
export function useFullSizeWindow(): boolean {
  const [full, setFull] = useState(() => isFullSizeWindow(readWindowMetrics()))

  useEffect(() => {
    let frame: number | null = null
    const update = () => {
      frame = null
      const next = isFullSizeWindow(readWindowMetrics())
      setFull((prev) => (prev === next ? prev : next))
    }
    const schedule = () => {
      if (frame != null) return
      frame = requestAnimationFrame(update)
    }

    update()
    window.addEventListener("resize", schedule)
    document.addEventListener("fullscreenchange", schedule)
    return () => {
      window.removeEventListener("resize", schedule)
      document.removeEventListener("fullscreenchange", schedule)
      if (frame != null) cancelAnimationFrame(frame)
    }
  }, [])

  return full
}
