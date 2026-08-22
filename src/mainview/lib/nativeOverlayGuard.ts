// Overlay lock for the native browser pane.
//
// The pane's `<electrobun-webview>` is a native view composited ABOVE the host
// DOM, so anything React paints over it (dialogs, popovers, menus, drawers) is
// both invisible and dead to clicks while the native view is up. BrowserPane
// already guesses at this geometrically (`paneCovered`), but that heuristic
// only fires when an overlay's rect overlaps the pane's rect and can miss small
// or freshly-moved popups — which is exactly why the first-run cookie card
// needed a full-pane scrim to be noticed.
//
// This module is the explicit half of that answer: overlays register themselves
// while they are on screen, and BrowserPane asks whether any of them covers the
// pane. Two modes, because overlays are not all the same shape:
//
// - "always": a modal surface with a backdrop over the whole window (dialogs,
//   the PR panel, onboarding, the pane's own first-run card). The pane must
//   step aside even with no overlap, or it stands out un-dimmed and eats the
//   backdrop-dismiss clicks aimed at it.
// - "intersect": bare floating surfaces with no backdrop (popovers, menus).
//   Hiding the pane for a dropdown on the far side of the window would blank
//   the page for nothing, so these only count while they actually overlap.
//
// The geometric probe in BrowserPane stays as the fallback for overlays that
// take no lock at all (in-tree toasts, drawers, anything hand-rolled).
//
// Deliberately not React context: the lock is taken from portaled popups that
// live outside the pane's tree (and from Base UI primitives that must stay
// provider-free), and read from an imperative watcher inside BrowserPane.
import { createElement, useEffect, useRef, type ReactElement } from "react"
import { rectsIntersect, type ViewportRect } from "./browserOverlay"

/** How a held lock decides whether it covers a given rect. */
export type OverlayLockMode = "always" | "intersect"

export interface OverlayLockOptions {
  /** Defaults to "always": unconditional, the safe answer for modal surfaces. */
  mode?: OverlayLockMode
  /**
   * Resolves the overlay's element for "intersect" locks. Called on every
   * evaluation (not captured once) so a popup that moves, re-parents, or goes
   * away is measured as it is right now.
   */
  element?: () => Element | null | undefined
}

interface LockEntry {
  mode: OverlayLockMode
  element?: () => Element | null | undefined
}

const locks = new Set<LockEntry>()
const listeners = new Set<(locked: boolean) => void>()

function notify() {
  const locked = locks.size > 0
  // Every acquire/release is announced, not just 0↔1 transitions: a second
  // popup opening changes which rects are covered even though the count was
  // already non-zero, and the watcher's evaluation is idempotent.
  for (const listener of Array.from(listeners)) listener(locked)
}

/**
 * Claim the lock while an overlay is up.
 *
 * @returns an idempotent release — calling it twice (StrictMode re-running a
 *   cleanup, a component releasing in both an effect teardown and an unmount
 *   path) must not drop someone else's lock.
 */
export function acquireOverlayLock(options: OverlayLockOptions = {}): () => void {
  // A fresh object per acquire, so two overlays with identical options are two
  // independent entries in the set.
  const entry: LockEntry = { mode: options.mode ?? "always", element: options.element }
  locks.add(entry)
  notify()

  let released = false
  return () => {
    if (released) return
    released = true
    locks.delete(entry)
    notify()
  }
}

/** Is any DOM overlay currently holding a lock, whatever its mode? */
export function isOverlayLocked(): boolean {
  return locks.size > 0
}

/** Number of live locks. Exposed for tests and debugging only. */
export function overlayLockCount(): number {
  return locks.size
}

/** Measure a registered overlay, tolerating a detached or missing element. */
function lockRect(entry: LockEntry): ViewportRect | null {
  if (!entry.element) return null
  let node: Element | null | undefined
  try {
    node = entry.element()
  } catch {
    // A resolver that throws (a ref read during teardown) means "no element".
    return null
  }
  if (!node || typeof node.getBoundingClientRect !== "function") return null
  // A detached node measures as all-zero anyway; skipping it early keeps the
  // common case cheap and makes the intent explicit.
  if ("isConnected" in node && node.isConnected === false) return null
  const rect = node.getBoundingClientRect()
  // Zero-area (unmounted, collapsed, or mid-animation) covers nothing.
  if (rect.width < 1 || rect.height < 1) return null
  return rect
}

/**
 * Does any held lock cover `rect`?
 *
 * `true` as soon as an "always" lock exists; otherwise each "intersect" lock is
 * measured and compared. Cheap by construction: at most a handful of locks are
 * ever held at once, and the "always" scan short-circuits before any layout is
 * read.
 */
export function lockedOverlaysCoverRect(rect: ViewportRect): boolean {
  if (locks.size === 0) return false
  for (const entry of locks) {
    if (entry.mode === "always") return true
  }
  if (rect.width < 1 || rect.height < 1) return false
  for (const entry of locks) {
    const other = lockRect(entry)
    if (other && rectsIntersect(other, rect)) return true
  }
  return false
}

/**
 * Observe lock changes. The callback runs synchronously inside acquire and
 * release, so a watcher can hide the native view in the same tick a popup
 * mounts rather than waiting for a poll.
 */
export function subscribeOverlayLock(listener: (locked: boolean) => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * Hold a lock for as long as this component is mounted (and `active`).
 *
 * StrictMode double-invokes effects, so the mount/cleanup pair must be
 * symmetric: each acquire is released exactly once by its own teardown.
 *
 * `element` is only consulted in "intersect" mode; pass a getter (not a node)
 * so the overlay is measured where it is at evaluation time.
 */
export function useOverlayLock(
  active = true,
  mode: OverlayLockMode = "always",
  element?: () => Element | null | undefined,
): void {
  // Kept in a ref so a resolver defined inline at the call site does not
  // re-acquire the lock on every render.
  const elementRef = useRef(element)
  elementRef.current = element

  useEffect(() => {
    if (!active) return
    return acquireOverlayLock({
      mode,
      element: elementRef.current ? () => elementRef.current?.() : undefined,
    })
  }, [active, mode])
}

/**
 * Renderless holder for the lock: mounted ⇒ locked, unmounted ⇒ released.
 *
 * Base UI popup wrappers are rendered unconditionally by their call sites (the
 * `open` prop lives on the Root), so a hook at the wrapper's top level would
 * hold the lock forever. Rendering this INSIDE the popup subtree ties the lock
 * to the popup's own mount, which is what actually tracks "is it on screen".
 *
 * In "intersect" mode the overlay it measures is its own parent element — the
 * popup it was rendered into — resolved fresh on every evaluation. It renders a
 * `display: none` span purely as that anchor; it paints nothing and takes no
 * space. (`createElement` rather than JSX so this module stays a plain .ts.)
 */
export function OverlayLock({ mode = "always" }: { mode?: OverlayLockMode }): ReactElement {
  const anchorRef = useRef<HTMLSpanElement | null>(null)
  useOverlayLock(true, mode, () => anchorRef.current?.parentElement ?? null)
  return createElement("span", {
    ref: anchorRef,
    "aria-hidden": true,
    style: { display: "none" },
  })
}

/** Test-only: drop every lock and listener so cases cannot leak into each other. */
export function __resetOverlayLockForTests(): void {
  locks.clear()
  listeners.clear()
}
