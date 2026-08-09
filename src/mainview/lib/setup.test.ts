import { expect, test } from "bun:test"
import { parseCredentialList, parseCredentialResult, parseSetupSessions, startSetupSessionWithDeps, type SetupStartDeps } from "./setup"

const session = { sessionId: "session-1", title: "Setup", createdAt: 1, lastActivityAt: 1 }
const deps = (overrides: Partial<SetupStartDeps> = {}): SetupStartDeps => ({
  ensure: async () => ({ ok: true }),
  create: async () => ({ sessionId: "session-1" }),
  send: async () => null,
  record: async () => ({ ok: true, session }),
  ...overrides,
})

test("strictly parses setup metadata and strips any credential value", () => {
  expect(parseSetupSessions({ ok: true, sessions: [{ sessionId: "x" }] })).toMatchObject({ ok: false })
  expect(parseCredentialList({ ok: true, credentials: [{ name: "token", createdAt: "bad" }] })).toMatchObject({ ok: false })
  expect(parseCredentialResult({ ok: true, credential: { name: "token", createdAt: 1, value: "never-return" } })).toEqual({ ok: true, credential: { name: "token", createdAt: 1 } })
})

test("disconnected, repository-less, and blank setup short-circuit", async () => {
  let created = false
  const guarded = deps({ create: async () => { created = true; return { sessionId: "x" } } })
  expect(await startSetupSessionWithDeps(null, "repo", "hello", guarded)).toMatchObject({ ok: false })
  expect(await startSetupSessionWithDeps("http://chunky", null, "hello", guarded)).toMatchObject({ ok: false, error: expect.stringContaining("repository") })
  expect(await startSetupSessionWithDeps("http://chunky", "repo", "   ", guarded)).toMatchObject({ ok: false })
  expect(created).toBe(false)
})

test("installs skill, creates repository session, and sends first turn with zoo-ledger", async () => {
  const calls: string[] = []
  const result = await startSetupSessionWithDeps("http://chunky", "repo-1", "Set up transcripts", deps({
    ensure: async () => { calls.push("ensure"); return { ok: true } },
    create: async (_url, repo) => { calls.push(`create:${repo}`); return { sessionId: "real" } },
    send: async (_url, id, text, options) => { calls.push(`send:${id}:${text}:${options.skill}`); return null },
    record: async ({ sessionId, title }) => { calls.push(`record:${sessionId}:${title}`); return { ok: false, error: "index unavailable" } },
  }))
  expect(result).toEqual({ ok: true, sessionId: "real" })
  expect(calls).toEqual(["ensure", "create:repo-1", "send:real:Set up transcripts:zoo-ledger", "record:real:Set up transcripts"])
})

test("skill, create, and send failures are redacted and metadata is not recorded", async () => {
  const secretLikeText = "connect token super-secret"
  const collision = await startSetupSessionWithDeps("http://chunky", "repo", secretLikeText, deps({ ensure: async () => ({ ok: false, error: "A non-app-owned zoo-ledger skill already exists. Rename or remove it, then retry." }) }))
  expect(collision).toMatchObject({ ok: false, error: expect.stringContaining("non-app-owned") })
  let recorded = false
  const failed = await startSetupSessionWithDeps("http://chunky", "repo", secretLikeText, deps({ send: async () => { throw new Error(secretLikeText) }, record: async () => { recorded = true; return { ok: true, session } } }))
  expect(failed).toMatchObject({ ok: false, error: expect.not.stringContaining("super-secret") })
  expect(recorded).toBe(false)
})

test("metadata exceptions remain best-effort after successful send", async () => {
  expect(await startSetupSessionWithDeps("http://chunky", "repo", "hello", deps({ record: async () => { throw new Error("bridge closed") } }))).toEqual({ ok: true, sessionId: "session-1" })
})
