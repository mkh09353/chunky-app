import { expect, test } from "bun:test"
import { createAppBrowserAnnouncer, type AppBrowserTarget } from "./appBrowser"

const NATIVE: AppBrowserTarget = { cdpPort: 54321, renderer: "native", debuggable: false }
const CEF: AppBrowserTarget = { cdpPort: 9223, renderer: "cef", debuggable: true }

function harness(targets: (AppBrowserTarget | null)[] | (AppBrowserTarget | null)) {
  const posts: { baseUrl: string; target: AppBrowserTarget }[] = []
  const queue = Array.isArray(targets) ? [...targets] : null
  const announcer = createAppBrowserAnnouncer({
    resolveTarget: async () => (queue ? (queue.length > 1 ? queue.shift()! : queue[0]!) : (targets as AppBrowserTarget | null)),
    post: async (baseUrl, target) => {
      posts.push({ baseUrl, target })
    },
  })
  return { announcer, posts }
}

test("announces once to a live server and dedupes identical payloads", async () => {
  const { announcer, posts } = harness(NATIVE)
  await announcer.announce("http://localhost:4620")
  await announcer.announce("http://localhost:4620")
  expect(posts).toEqual([{ baseUrl: "http://localhost:4620", target: NATIVE }])
})

test("StrictMode's double mount cannot race two announces", async () => {
  const { announcer, posts } = harness(NATIVE)
  // Both calls happen in the same tick, before either resolves.
  await Promise.all([announcer.announce("http://localhost:4620"), announcer.announce("http://localhost:4620")])
  expect(posts.length).toBe(1)
})

test("never announces without a live server", async () => {
  const { announcer, posts } = harness(NATIVE)
  await announcer.announce(null)
  await announcer.announce("")
  await announcer.announce(undefined)
  expect(posts).toEqual([])
})

test("browser-only dev has no pane to announce", async () => {
  const { announcer, posts } = harness(null)
  await announcer.announce("http://localhost:4620")
  expect(posts).toEqual([])
})

test("a reconnect re-announces because the server forgot", async () => {
  const { announcer, posts } = harness(NATIVE)
  await announcer.announce("http://localhost:4620")
  announcer.reset()
  await announcer.announce("http://localhost:4620")
  expect(posts.length).toBe(2)
})

test("a new server (different port) is announced to as well", async () => {
  const { announcer, posts } = harness(NATIVE)
  await announcer.announce("http://localhost:4620")
  await announcer.announce("http://localhost:4700")
  expect(posts.map((p) => p.baseUrl)).toEqual(["http://localhost:4620", "http://localhost:4700"])
})

test("the pane becoming CDP-drivable is announced as an update", async () => {
  const { announcer, posts } = harness([NATIVE, CEF])
  await announcer.announce("http://localhost:4620")
  await announcer.announce("http://localhost:4620", "https://duckduckgo.com/")
  expect(posts.map((p) => p.target)).toEqual([NATIVE, CEF])
})

test("a malformed target from the bun process is ignored", async () => {
  const posts: unknown[] = []
  const announcer = createAppBrowserAnnouncer({
    resolveTarget: async () => ({ cdpPort: 0, renderer: "cef", debuggable: true }) as AppBrowserTarget,
    post: async (baseUrl, target) => {
      posts.push({ baseUrl, target })
    },
  })
  await announcer.announce("http://localhost:4620")
  expect(posts).toEqual([])
})

test("a failed POST is swallowed and retried on the next announce", async () => {
  let attempts = 0
  const announcer = createAppBrowserAnnouncer({
    resolveTarget: async () => NATIVE,
    post: async () => {
      attempts += 1
      if (attempts === 1) throw new Error("server restarting")
    },
  })
  await announcer.announce("http://localhost:4620")
  await announcer.announce("http://localhost:4620")
  expect(attempts).toBe(2)
})
