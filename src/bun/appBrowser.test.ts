import { expect, test } from "bun:test"
import {
  CDP_FIRST_PORT,
  createAppBrowserResolver,
  sameTarget,
  sanitizePaneUrl,
  type AppBrowserDeps,
} from "./appBrowser"

const PANE_URL = "https://duckduckgo.com/"

/** A fake CDP endpoint: `hosts` maps port -> target list. */
function cdp(hosts: Record<number, { url: string; webSocketDebuggerUrl?: string }[]>, calls: string[] = []) {
  return (async (input: RequestInfo | URL) => {
    const url = new URL(input.toString())
    calls.push(url.toString())
    if (url.hostname !== "127.0.0.1") throw new Error("only loopback may be probed")
    const targets = hosts[Number(url.port)]
    if (!targets) throw new Error("connection refused")
    return new Response(
      JSON.stringify(
        targets.map((t) => ({
          url: t.url,
          webSocketDebuggerUrl: t.webSocketDebuggerUrl ?? `ws://127.0.0.1:${url.port}/devtools/page/x`,
        })),
      ),
      { status: 200 },
    )
  }) as typeof fetch
}

function deps(over: Partial<AppBrowserDeps> = {}): AppBrowserDeps {
  return {
    availableRenderers: async () => ["native"],
    fetch: cdp({}),
    freePort: async () => 54321,
    probeTimeoutMs: 20,
    ...over,
  }
}

test("system-webview build announces a free loopback port and is not debuggable", async () => {
  const calls: string[] = []
  const resolve = createAppBrowserResolver(deps({ fetch: cdp({ 9222: [{ url: PANE_URL }] }, calls) }))
  expect(await resolve(PANE_URL)).toEqual({ cdpPort: 54321, renderer: "native", debuggable: false })
  // No CEF -> nothing to discover; never touch the network.
  expect(calls).toEqual([])
})

test("CEF build discovers the port whose CDP listener owns the pane", async () => {
  const resolve = createAppBrowserResolver(
    deps({
      availableRenderers: async () => ["native", "cef"],
      fetch: cdp({ 9222: [{ url: "https://someone-elses-chrome.example/" }], 9224: [{ url: PANE_URL }] }),
    }),
  )
  expect(await resolve(PANE_URL)).toEqual({ cdpPort: 9224, renderer: "cef", debuggable: true })
})

test("a foreign CDP listener is never announced as ours", async () => {
  const resolve = createAppBrowserResolver(
    deps({
      availableRenderers: async () => ["native", "cef"],
      fetch: cdp({ [CDP_FIRST_PORT]: [{ url: "https://not-our-pane.example/" }] }),
    }),
  )
  expect(await resolve(PANE_URL)).toEqual({ cdpPort: 54321, renderer: "cef", debuggable: false })
})

test("without a pane URL there is nothing to verify, so no probe happens", async () => {
  const calls: string[] = []
  const resolve = createAppBrowserResolver(
    deps({ availableRenderers: async () => ["native", "cef"], fetch: cdp({ 9222: [{ url: PANE_URL }] }, calls) }),
  )
  expect(await resolve()).toEqual({ cdpPort: 54321, renderer: "cef", debuggable: false })
  expect(calls).toEqual([])
})

test("a discovered port is cached: later announcements do not re-probe", async () => {
  const calls: string[] = []
  const resolve = createAppBrowserResolver(
    deps({ availableRenderers: async () => ["cef"], fetch: cdp({ 9223: [{ url: PANE_URL }] }, calls) }),
  )
  expect(await resolve(PANE_URL)).toMatchObject({ cdpPort: 9223, debuggable: true })
  const first = calls.length
  expect(first).toBeGreaterThan(0)
  expect(await resolve("https://example.com/")).toMatchObject({ cdpPort: 9223, debuggable: true })
  expect(calls.length).toBe(first)
})

test("a broken build.json read degrades to the native announcement", async () => {
  const resolve = createAppBrowserResolver(
    deps({
      availableRenderers: async () => {
        throw new Error("no build.json")
      },
    }),
  )
  expect(await resolve(PANE_URL)).toMatchObject({ renderer: "native", debuggable: false })
})

test("target matching accepts redirects within the origin, rejects other sites", () => {
  expect(sameTarget(PANE_URL, PANE_URL)).toBe(true)
  expect(sameTarget("https://duckduckgo.com/?q=cats", PANE_URL)).toBe(true)
  expect(sameTarget("https://evil.example/", PANE_URL)).toBe(false)
  expect(sameTarget("about:blank", PANE_URL)).toBe(false)
  expect(sameTarget("not a url", PANE_URL)).toBe(false)
})

test("pane URLs are restricted to bounded http(s)", () => {
  expect(sanitizePaneUrl(" https://a.dev/x ")).toBe("https://a.dev/x")
  expect(sanitizePaneUrl("http://localhost:4620/")).toBe("http://localhost:4620/")
  expect(sanitizePaneUrl("file:///etc/passwd")).toBeUndefined()
  expect(sanitizePaneUrl("javascript:alert(1)")).toBeUndefined()
  expect(sanitizePaneUrl(`https://a.dev/${"x".repeat(5000)}`)).toBeUndefined()
  expect(sanitizePaneUrl("https://a.dev/\0")).toBeUndefined()
  expect(sanitizePaneUrl(42)).toBeUndefined()
})
