// The zoo announcer's rules: announce once per (server, port, token), forget on
// disconnect, stay silent when the capability is missing, and never leak the
// token into the dedupe memo. Run with:
//   bun test src/mainview/lib/appZoo.test.ts
import { expect, test } from "bun:test"
import { createAppZooAnnouncer, type AppZooTarget } from "./appZoo"

const TARGET: AppZooTarget = { port: 4711, token: "zoo_secret_token_value" }
const ROTATED: AppZooTarget = { port: 4711, token: "zoo_rotated_token_value" }

function harness(targets: (AppZooTarget | null)[] | (AppZooTarget | null)) {
  const posts: { baseUrl: string; target: AppZooTarget }[] = []
  const queue = Array.isArray(targets) ? [...targets] : null
  const announcer = createAppZooAnnouncer({
    resolveTarget: async () =>
      queue ? (queue.length > 1 ? queue.shift()! : queue[0]!) : (targets as AppZooTarget | null),
    post: async (baseUrl, target) => {
      posts.push({ baseUrl, target })
    },
  })
  return { announcer, posts }
}

test("announces once to a live server and dedupes an unchanged target", async () => {
  const { announcer, posts } = harness(TARGET)
  await announcer.announce("http://localhost:4620")
  await announcer.announce("http://localhost:4620")
  expect(posts).toEqual([{ baseUrl: "http://localhost:4620", target: TARGET }])
})

test("StrictMode's double mount cannot race two announces", async () => {
  const { announcer, posts } = harness(TARGET)
  await Promise.all([
    announcer.announce("http://localhost:4620"),
    announcer.announce("http://localhost:4620"),
  ])
  expect(posts.length).toBe(1)
})

test("never announces without a live server", async () => {
  const { announcer, posts } = harness(TARGET)
  await announcer.announce(null)
  await announcer.announce("")
  await announcer.announce(undefined)
  expect(posts).toEqual([])
})

test("a reconnect re-announces because the server forgot", async () => {
  const { announcer, posts } = harness(TARGET)
  await announcer.announce("http://localhost:4620")
  announcer.reset()
  await announcer.announce("http://localhost:4620")
  expect(posts.length).toBe(2)
})

test("a new server is announced to as well", async () => {
  const { announcer, posts } = harness(TARGET)
  await announcer.announce("http://localhost:4620")
  await announcer.announce("http://localhost:4700")
  expect(posts.map((p) => p.baseUrl)).toEqual(["http://localhost:4620", "http://localhost:4700"])
})

test("a rotated token re-announces even though the port is unchanged", async () => {
  const { announcer, posts } = harness([TARGET, ROTATED])
  await announcer.announce("http://localhost:4620")
  await announcer.announce("http://localhost:4620")
  expect(posts.map((p) => p.target.token)).toEqual([TARGET.token, ROTATED.token])
})

test("a token that differs only past the fingerprint prefix still re-announces on length change", async () => {
  const short: AppZooTarget = { port: 4711, token: "abcdefgh" }
  const long: AppZooTarget = { port: 4711, token: "abcdefgh-more" }
  const { announcer, posts } = harness([short, long])
  await announcer.announce("http://localhost:4620")
  await announcer.announce("http://localhost:4620")
  expect(posts.length).toBe(2)
})

test("a changed port re-announces", async () => {
  const { announcer, posts } = harness([TARGET, { port: 4712, token: TARGET.token }])
  await announcer.announce("http://localhost:4620")
  await announcer.announce("http://localhost:4620")
  expect(posts.map((p) => p.target.port)).toEqual([4711, 4712])
})

test("no zoo service (browser-only dev, or the RPC method not registered yet) announces nothing", async () => {
  const { announcer, posts } = harness(null)
  await announcer.announce("http://localhost:4620")
  expect(posts).toEqual([])
})

test("a malformed or failed target from the bun process is treated as unavailable", async () => {
  const malformed: unknown[] = [
    { ok: false, error: "zoo service is not running" },
    { port: 0, token: "t" },
    { port: 4711, token: "" },
    { port: 70_000, token: "t" },
    { port: 4711.5, token: "t" },
    { port: "4711", token: "t" },
    { port: 4711 },
    {},
    null,
    "nope",
  ]
  for (const value of malformed) {
    const posts: unknown[] = []
    const announcer = createAppZooAnnouncer({
      resolveTarget: async () => value as AppZooTarget | null,
      post: async (baseUrl, target) => {
        posts.push({ baseUrl, target })
      },
    })
    await announcer.announce("http://localhost:4620")
    expect(posts).toEqual([])
  }
})

test("a failed POST is swallowed and retried on the next announce", async () => {
  let attempts = 0
  const announcer = createAppZooAnnouncer({
    resolveTarget: async () => TARGET,
    post: async () => {
      attempts += 1
      if (attempts === 1) throw new Error("server restarting")
    },
  })
  await announcer.announce("http://localhost:4620")
  await announcer.announce("http://localhost:4620")
  expect(attempts).toBe(2)
})

test("the memo holds a fingerprint, not the token", async () => {
  // Observable consequence of storing only length + first 8 chars: two tokens
  // that share both are indistinguishable to the memo, so the second one does
  // NOT re-announce. That is the accepted cost of never retaining the secret;
  // a real rotation changes the suffix length or the prefix and does announce
  // (see the rotated-token tests above).
  const a: AppZooTarget = { port: 4711, token: "abcdefgh-1111" }
  const b: AppZooTarget = { port: 4711, token: "abcdefgh-2222" }
  const { announcer, posts } = harness([a, b])
  await announcer.announce("http://localhost:4620")
  await announcer.announce("http://localhost:4620")
  expect(posts.map((p) => p.target.token)).toEqual([a.token])
})
