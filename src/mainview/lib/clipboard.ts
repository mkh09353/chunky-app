// One place the renderer copies text from.
//
// The packaged app runs in a WKWebView, where `navigator.clipboard.writeText`
// is not always available (and rejects outside a user gesture). Every copy
// therefore falls back to the legacy hidden-textarea + `document.execCommand`
// path, which WebKit still honours. Both halves are injectable so the policy
// can be tested without a DOM.

/** A legacy copy that has been set up but not yet executed. */
export interface LegacyCopyHandle {
  /** Run `document.execCommand("copy")` on the already-selected text. */
  commit: () => boolean
  /** Tear down without copying. */
  cancel: () => void
}

export interface ClipboardDeps {
  /** Async Clipboard API write; omitted/absent → straight to the fallback. */
  writeText?: (text: string) => Promise<void>
  /** Legacy synchronous copy; returns false when it didn't take. */
  exec?: (text: string) => boolean
  /**
   * Optional: arm the legacy path BEFORE any await, so the selection happens
   * while the user gesture is still live (see `armLegacyCopy`). Omitted →
   * `exec` is used on its own, exactly as before.
   */
  prepare?: (text: string) => LegacyCopyHandle | null
}

/** Bind to the live globals lazily — modules load before the DOM exists. */
function defaultDeps(): ClipboardDeps {
  const clip =
    typeof navigator !== "undefined"
      ? (navigator as Navigator & { clipboard?: Clipboard }).clipboard
      : undefined
  return {
    writeText: clip?.writeText ? (text: string) => clip.writeText(text) : undefined,
    exec: execCopy,
    prepare: armLegacyCopy,
  }
}

/** The off-screen, selectable textarea both legacy paths copy from. */
function mountCopySource(text: string): HTMLTextAreaElement | null {
  if (typeof document === "undefined" || !document.body) return null
  const el = document.createElement("textarea")
  el.value = text
  // Off-screen but focusable: `display:none` / `hidden` cannot be selected.
  el.setAttribute("readonly", "")
  el.setAttribute("aria-hidden", "true")
  el.style.position = "fixed"
  el.style.top = "-1000px"
  el.style.left = "-1000px"
  el.style.opacity = "0"
  document.body.appendChild(el)
  return el
}

/** Put focus and the caret back where the user had them. */
function restore(
  el: HTMLTextAreaElement,
  previousRange: Range | null,
  previousFocus: Element | null,
): void {
  el.remove()
  const selection = typeof document !== "undefined" ? document.getSelection() : null
  if (previousRange && selection) {
    selection.removeAllRanges()
    selection.addRange(previousRange)
  }
  if (previousFocus instanceof HTMLElement) previousFocus.focus({ preventScroll: true })
}

/**
 * Select the text NOW and hand back a commit/cancel pair.
 *
 * WebKit honours `execCommand("copy")` only while the gesture that triggered
 * it is still current. `copyText` awaits the async Clipboard API first, so by
 * the time a rejection comes back the gesture may be spent and a from-scratch
 * fallback would silently fail — exactly the packaged-app case this fallback
 * exists for. Selecting inside the gesture and committing later keeps the copy
 * eligible. Returns null when there is no DOM.
 */
export function armLegacyCopy(text: string): LegacyCopyHandle | null {
  const previousFocus = typeof document !== "undefined" ? document.activeElement : null
  const el = mountCopySource(text)
  if (!el) return null
  const selection = document.getSelection()
  const previousRange = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null
  try {
    el.select()
    el.setSelectionRange(0, el.value.length)
  } catch {
    restore(el, previousRange, previousFocus)
    return null
  }
  let settled = false
  return {
    commit: () => {
      if (settled) return false
      settled = true
      let ok = false
      try {
        ok = document.execCommand("copy")
      } catch {
        ok = false
      } finally {
        restore(el, previousRange, previousFocus)
      }
      return ok
    },
    cancel: () => {
      if (settled) return
      settled = true
      restore(el, previousRange, previousFocus)
    },
  }
}

/**
 * Legacy copy in one shot: mount, select, copy, clean up. Deprecated in the
 * spec, still the only thing that works in some WKWebView contexts. Returns
 * false when there is no DOM or the command was refused.
 */
export function execCopy(text: string): boolean {
  const armed = armLegacyCopy(text)
  return armed ? armed.commit() : false
}

/**
 * Copy `text`, preferring the async Clipboard API and falling back to
 * `execCommand`. Resolves true only when a write actually succeeded, so the
 * caller can decide whether to show its confirmation.
 *
 * Call it synchronously from the event handler: the fallback is armed before
 * the first await so it stays inside the user gesture.
 */
export async function copyText(text: string, deps: ClipboardDeps = defaultDeps()): Promise<boolean> {
  if (typeof text !== "string" || !text) return false

  // Armed first, awaited second — order matters (see armLegacyCopy).
  const armed = deps.prepare?.(text) ?? null

  if (deps.writeText) {
    try {
      await deps.writeText(text)
      armed?.cancel()
      return true
    } catch {
      // Permission denied / not a user gesture → commit the armed selection,
      // which was made while the gesture was still live.
      if (armed) {
        try {
          if (armed.commit()) return true
        } catch {
          /* fall through to a fresh attempt below */
        }
      }
    }
  } else if (armed) {
    try {
      if (armed.commit()) return true
    } catch {
      /* fall through */
    }
  }

  armed?.cancel()
  try {
    return deps.exec?.(text) ?? false
  } catch {
    return false
  }
}
