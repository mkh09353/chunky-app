// The guest-page guard: window.close() in the pane must become a host message
// instead of a process exit.
// Run with: bun test src/mainview/lib/browserGuest.test.ts
import { describe, expect, test } from "bun:test"
import {
  GUEST_GUARD_SCRIPT,
  PAGE_CLOSE_REQUEST,
  PAGE_THEME_COLOR,
  isPageCloseRequest,
  readThemeColorMessage,
} from "./browserGuest"

/** Minimal stand-in for the guest page's globals. */
function fakeWindow(options: {
  metas?: { content?: string; media?: string }[]
  matches?: (query: string) => boolean
} = {}) {
  const posted: unknown[] = []
  const observers: { target: unknown; callback: () => void }[] = []
  const timers: (() => void)[] = []
  const metas = options.metas ?? []
  const win: Record<string, unknown> = {
    __electrobunWebviewId: 1,
    __electrobunEventBridge: { postMessage: (msg: string) => posted.push(JSON.parse(msg)) },
    location: { href: "https://example.test/" },
    document: {
      readyState: "complete",
      head: { id: "head" },
      addEventListener: () => {},
      querySelectorAll: () =>
        metas.map((meta) => ({
          getAttribute: (name: string) =>
            name === "content" ? meta.content ?? null : name === "media" ? meta.media ?? null : null,
        })),
    },
    addEventListener: () => {},
    matchMedia: (query: string) => ({
      matches: options.matches ? options.matches(query) : false,
      addEventListener: () => {},
    }),
    MutationObserver: class {
      constructor(private readonly callback: () => void) {}
      observe(target: unknown) {
        observers.push({ target, callback: () => this.callback() })
      }
    },
    setTimeout: (fn: () => void) => {
      timers.push(fn)
      return timers.length
    },
  }
  return { win, posted, observers, timers }
}

/** Payloads the guard posted, unwrapped from the Electrobun event envelope. */
function details(posted: unknown[]): Record<string, unknown>[] {
  return posted.map((entry) =>
    JSON.parse((entry as { payload: { detail: string } }).payload.detail),
  )
}

describe("GUEST_GUARD_SCRIPT", () => {
  test("is a self-contained, statically known IIFE", () => {
    expect(GUEST_GUARD_SCRIPT.startsWith("(function(){")).toBe(true)
    expect(GUEST_GUARD_SCRIPT.trimEnd().endsWith("})();")).toBe(true)
    // Nothing derived from page content or credentials may be interpolated.
    expect(GUEST_GUARD_SCRIPT).not.toContain("${")
  })

  test("overrides window.close and leaves navigation alone", () => {
    expect(GUEST_GUARD_SCRIPT).toContain('"close"')
    expect(GUEST_GUARD_SCRIPT).toContain(PAGE_CLOSE_REQUEST)
    // Our own chrome drives the view over RPC; the guest's window.open stays
    // native (popups are blocked upstream and surface as new-window-open).
    expect(GUEST_GUARD_SCRIPT).not.toContain("window.open =")
  })

  test("is idempotent so preload + re-injection cannot double-apply", () => {
    expect(GUEST_GUARD_SCRIPT).toContain("__chunkyGuestGuard")
  })

  test("actually replaces window.close when evaluated", () => {
    const posted: string[] = []
    const win: Record<string, unknown> = {
      __electrobunWebviewId: 3,
      __electrobunEventBridge: { postMessage: (msg: string) => posted.push(msg) },
      location: { href: "https://example.test/page" },
      close: () => {
        throw new Error("real window.close must not run")
      },
    }
    // Evaluate the script with `window` bound to the fake global.
    new Function("window", `${GUEST_GUARD_SCRIPT}`)(win)

    expect(typeof win.close).toBe("function")
    ;(win.close as () => void)()

    // The guard also reports theme-color on injection; this test is about close.
    const closeEnvelopes = posted.filter((raw) => raw.includes(PAGE_CLOSE_REQUEST))
    expect(closeEnvelopes).toHaveLength(1)
    const envelope = JSON.parse(closeEnvelopes[0]!) as {
      id: string
      payload: { id: number; eventName: string; detail: string }
    }
    expect(envelope.id).toBe("webviewEvent")
    expect(envelope.payload.eventName).toBe("host-message")
    expect(envelope.payload.id).toBe(3)
    expect(isPageCloseRequest(envelope.payload.detail)).toBe(true)
    expect(JSON.parse(envelope.payload.detail).url).toBe("https://example.test/page")
  })

  test("does nothing a second time, and survives a missing bridge", () => {
    const win: Record<string, unknown> = { __chunkyGuestGuard: true, close: "untouched" }
    new Function("window", GUEST_GUARD_SCRIPT)(win)
    expect(win.close).toBe("untouched")

    const bridgeless: Record<string, unknown> = { location: { href: "https://example.test/" } }
    new Function("window", GUEST_GUARD_SCRIPT)(bridgeless)
    expect(() => (bridgeless.close as () => void)()).not.toThrow()
  })
})

describe("isPageCloseRequest", () => {
  test("accepts the parsed object and the raw JSON string", () => {
    expect(isPageCloseRequest({ type: PAGE_CLOSE_REQUEST })).toBe(true)
    expect(isPageCloseRequest(JSON.stringify({ type: PAGE_CLOSE_REQUEST, url: "x" }))).toBe(true)
  })

  test("rejects everything else", () => {
    expect(isPageCloseRequest(null)).toBe(false)
    expect(isPageCloseRequest(undefined)).toBe(false)
    expect(isPageCloseRequest("not json")).toBe(false)
    expect(isPageCloseRequest({ type: "other" })).toBe(false)
    expect(isPageCloseRequest(JSON.stringify({ type: "other" }))).toBe(false)
    expect(isPageCloseRequest(42)).toBe(false)
  })
})

describe("theme-color reporting", () => {
  test("reports the page's theme colour on injection", () => {
    const { win, posted } = fakeWindow({ metas: [{ content: "#7c4ddb" }] })
    new Function("window", GUEST_GUARD_SCRIPT)(win)
    const themed = details(posted).filter((d) => d.type === PAGE_THEME_COLOR)
    expect(themed).toHaveLength(1)
    expect(themed[0]!.color).toBe("#7c4ddb")
  })

  test("prefers the media variant that currently matches", () => {
    const { win, posted } = fakeWindow({
      metas: [
        { content: "#ffffff", media: "(prefers-color-scheme: light)" },
        { content: "#101014", media: "(prefers-color-scheme: dark)" },
        { content: "#888888" },
      ],
      matches: (query) => query.includes("dark"),
    })
    new Function("window", GUEST_GUARD_SCRIPT)(win)
    expect(details(posted).find((d) => d.type === PAGE_THEME_COLOR)!.color).toBe("#101014")
  })

  test("falls back to the unscoped meta when no media query matches", () => {
    const { win, posted } = fakeWindow({
      metas: [{ content: "#101014", media: "(prefers-color-scheme: dark)" }, { content: "#888888" }],
    })
    new Function("window", GUEST_GUARD_SCRIPT)(win)
    expect(details(posted).find((d) => d.type === PAGE_THEME_COLOR)!.color).toBe("#888888")
  })

  test("reports null when the page has no theme colour", () => {
    const { win, posted } = fakeWindow()
    new Function("window", GUEST_GUARD_SCRIPT)(win)
    const themed = details(posted).find((d) => d.type === PAGE_THEME_COLOR)!
    expect(themed.color).toBeNull()
  })

  test("observes <head> once, and re-injection cannot stack observers", () => {
    const { win, observers } = fakeWindow({ metas: [{ content: "#123456" }] })
    new Function("window", GUEST_GUARD_SCRIPT)(win)
    new Function("window", GUEST_GUARD_SCRIPT)(win)
    new Function("window", GUEST_GUARD_SCRIPT)(win)
    expect(observers).toHaveLength(1)
  })

  test("head changes are throttled and only reported when the colour changed", () => {
    const state = { content: "#111111" }
    const { win, posted, observers, timers } = fakeWindow({ metas: [state] })
    new Function("window", GUEST_GUARD_SCRIPT)(win)
    const before = details(posted).filter((d) => d.type === PAGE_THEME_COLOR).length

    // Several mutations in a row schedule exactly one re-read.
    observers[0]!.callback()
    observers[0]!.callback()
    observers[0]!.callback()
    expect(timers).toHaveLength(1)

    // Unchanged colour: nothing new is posted.
    timers[0]!()
    expect(details(posted).filter((d) => d.type === PAGE_THEME_COLOR)).toHaveLength(before)

    // Changed colour: one report.
    state.content = "#222222"
    observers[0]!.callback()
    timers[timers.length - 1]!()
    const themed = details(posted).filter((d) => d.type === PAGE_THEME_COLOR)
    expect(themed).toHaveLength(before + 1)
    expect(themed[themed.length - 1]!.color).toBe("#222222")
  })

  test("the close guard still works alongside the observer", () => {
    const { win, posted } = fakeWindow({ metas: [{ content: "#7c4ddb" }] })
    new Function("window", GUEST_GUARD_SCRIPT)(win)
    ;(win.close as () => void)()
    expect(details(posted).some((d) => d.type === PAGE_CLOSE_REQUEST)).toBe(true)
  })
})

describe("readThemeColorMessage", () => {
  test("reads a report, as object or JSON string", () => {
    expect(readThemeColorMessage({ type: PAGE_THEME_COLOR, color: "#fff" })).toEqual({
      matched: true,
      color: "#fff",
    })
    expect(readThemeColorMessage(JSON.stringify({ type: PAGE_THEME_COLOR, color: null }))).toEqual({
      matched: true,
      color: null,
    })
  })

  test("does not match other messages or junk", () => {
    expect(readThemeColorMessage({ type: PAGE_CLOSE_REQUEST })).toEqual({ matched: false, color: null })
    expect(readThemeColorMessage("nope")).toEqual({ matched: false, color: null })
    expect(readThemeColorMessage(null)).toEqual({ matched: false, color: null })
  })

  test("a non-string colour is treated as absent, not passed through", () => {
    expect(readThemeColorMessage({ type: PAGE_THEME_COLOR, color: { evil: true } })).toEqual({
      matched: true,
      color: null,
    })
  })
})
