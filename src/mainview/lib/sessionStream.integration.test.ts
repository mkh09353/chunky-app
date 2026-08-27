// The v2 cursor stream against the REAL Chunky server.
//
// The unit tests next door drive `SessionStreamMachine` with synthetic frames;
// this one drives it with frames a real server actually emitted, which is the
// only way to catch a framing mismatch (names, ordering, the ": ready" preamble,
// where the cursor sits relative to a seq) between the two repos.
//
// It spawns `packages/server/src/index.ts` from the sibling chunky checkout with
// isolated CHUNKY_DB / CHUNKY_SETTINGS / CHUNKY_AUTH temp paths, and SKIPS
// ITSELF with a clear message when that checkout is absent (CI has only this
// repo). Point CHUNKY_REPO at the checkout to override the default sibling path.
//
// Run with: bun test src/mainview/lib/sessionStream.integration.test.ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AgentEvent } from "@chunky/protocol"
import { openSessionEventStream } from "./api"
import { SessionStreamMachine, type SessionStreamFrame } from "./sessionStream"
import { rebuildTranscript } from "./sessionCache"
import type { TranscriptState } from "./transcript"

const serverRepo = process.env.CHUNKY_REPO ?? join(import.meta.dir, "../../../../chunky")
const serverEntry = join(serverRepo, "packages/server/src/index.ts")
const haveServer = existsSync(serverEntry)

if (!haveServer) {
  // eslint-disable-next-line no-console
  console.warn(
    `[skip] sessionStream integration: no Chunky server checkout at ${serverRepo}. ` +
    "Clone the server repo beside this one (or set CHUNKY_REPO) to run it.",
  )
}

const describeIntegration = haveServer ? describe : describe.skip

describeIntegration("v2 session stream against the real server", () => {
  const root = mkdtempSync(join(tmpdir(), "chunky-app-v2-"))
  const token = "app-v2-integration-token"
  const dbPath = join(root, "chunky.db")
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } })
  const port = listener.port
  listener.stop()
  const base = `http://127.0.0.1:${port}`
  const auth = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }

  let proc: Bun.Subprocess | null = null
  let db: Database | null = null
  const realFetch = globalThis.fetch

  async function request(path: string, init: RequestInit = {}): Promise<Response> {
    let error: unknown
    for (let i = 0; i < 200; i++) {
      try { return await realFetch(base + path, init) } catch (cause) { error = cause; await Bun.sleep(25) }
    }
    throw error
  }

  beforeAll(async () => {
    writeFileSync(join(root, "settings.json"), JSON.stringify({
      serverToken: token,
      provider: "faux",
      selections: { faux: { model: "faux-model" } },
      // Never contacted: this test appends history directly and never sends a turn.
      customProviders: [{ id: "faux", label: "Faux", baseURL: "http://127.0.0.1:1/v1", billing: "metered", defaultModel: "faux-model" }],
    }))
    writeFileSync(join(root, "auth.json"), JSON.stringify({ faux: { type: "api", key: "faux-key" } }))
    proc = Bun.spawn([process.execPath, "run", serverEntry], {
      cwd: serverRepo,
      env: {
        ...process.env,
        CHUNKY_PORT: String(port),
        CHUNKY_SETTINGS: join(root, "settings.json"),
        CHUNKY_AUTH: join(root, "auth.json"),
        CHUNKY_DB: dbPath,
        CHUNKY_GRAPH_DB: join(root, "graph.db"),
        CHUNKY_MODELS_CACHE: join(root, "nonexistent-models.json"),
        CHUNKY_RELAY: "0",
        CHUNKY_WORKSPACE: root,
      },
      stdout: "ignore", stderr: "ignore",
    })
    await request("/api/info", { headers: auth })
    db = new Database(dbPath)
    // The App attaches its bearer token with a global fetch wrapper it installs
    // from the resolved config (api.ts installAuthFetch, not exported). The
    // stream client under test therefore calls plain `fetch` — so the test wears
    // the same wrapper rather than reaching around the client.
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      if (!headers.has("Authorization")) headers.set("Authorization", `Bearer ${token}`)
      return realFetch(input, { ...init, headers })
    }) as typeof fetch
  })

  afterAll(async () => {
    globalThis.fetch = realFetch
    db?.close()
    try { proc?.kill("SIGTERM") } catch {}
    await proc?.exited
    rmSync(root, { recursive: true, force: true })
  })

  async function createSession(): Promise<string> {
    const response = await request("/api/sessions", { method: "POST", headers: auth, body: "{}" })
    expect(response.ok).toBe(true)
    return (await response.json() as { sessionId: string }).sessionId
  }

  const generation = (id: string) =>
    (db!.query("SELECT history_generation generation FROM sessions WHERE id=?").get(id) as { generation: string }).generation

  /** Append durable history exactly as the server's own tests do. */
  function append(id: string, events: AgentEvent[]): void {
    const next = db!.query("SELECT COALESCE(MAX(seq),-1)+1 n FROM events WHERE session_id=?")
    const insert = db!.query("INSERT INTO events (session_id,seq,json) VALUES (?,?,?)")
    for (const event of events) insert.run(id, (next.get(id) as { n: number }).n, JSON.stringify(event))
  }

  interface Attempt {
    /** Every projection the reader would have seen, oldest first. */
    frames: TranscriptState[]
    visible: TranscriptState
    cursor: string | null
    committed: boolean
    resets: string[]
    replayed: number[]
    legacy: number
  }

  /**
   * One connection attempt, wired exactly like useAttachedSession: visible
   * events reduce onto the screen, replay reduces the shadow, and the commit at
   * replay-end is the only moment the screen is swapped. Disconnects right
   * after the commit (`until: "commit"`) or after `frames` frames.
   */
  async function attach(id: string, machine: SessionStreamMachine, until: "commit" | number): Promise<Attempt> {
    const out: Attempt = {
      frames: [machine.visible], visible: machine.visible, cursor: machine.cursor,
      committed: false, resets: [], replayed: [], legacy: 0,
    }
    const ac = new AbortController()
    let seen = 0
    const onFrame = (frame: SessionStreamFrame) => {
      seen += 1
      const step = machine.handle(frame)
      if (step.kind === "legacy") out.legacy += 1
      else if (step.kind === "reset") out.resets.push(step.reason)
      else if (step.kind === "commit") {
        out.committed = true
        out.visible = step.visible
        out.cursor = step.cursor
        out.frames.push(step.visible)
      } else if (step.kind === "visible") {
        out.visible = machine.reduceVisible(step.event)
        out.frames.push(out.visible)
      } else if (step.phase === "replay" && frame.kind === "event") {
        out.replayed.push(frame.seq)
      }
      if (until === "commit" ? out.committed : seen >= until) ac.abort()
    }
    try {
      await Promise.race([
        openSessionEventStream(base, id, onFrame, { cursor: machine.requestCursor, signal: ac.signal }),
        Bun.sleep(10_000).then(() => { throw new Error("timed out waiting for the v2 stream") }),
      ])
    } catch (err) {
      if (!ac.signal.aborted) throw err
    }
    return out
  }

  const size = (state: TranscriptState) => state.order.length

  test("attach, disconnect, resume from the cursor, and rebuild after a rewrite", async () => {
    const id = await createSession()
    const first: AgentEvent[] = [
      { type: "message.user", text: "build it" },
      { type: "message.start", role: "assistant" },
      { type: "message.delta", text: "on it" },
      { type: "message.end" },
    ]
    append(id, first)

    // 1) Attach from an EMPTY cache: nothing on screen until replay-end.
    const attach1 = new SessionStreamMachine()
    expect(attach1.requestCursor).toBeNull()
    const run1 = await attach(id, attach1, "commit")
    expect(run1.committed).toBe(true)
    expect(run1.replayed).toEqual([0, 1, 2, 3])
    expect(run1.visible).toEqual(rebuildTranscript(first))
    expect(run1.frames.length).toBe(2) // initial (empty) → committed
    const cursor1 = run1.cursor!
    expect(cursor1).toBeString()

    // 2) Disconnected. The session moves on while we are away.
    const second: AgentEvent[] = [
      { type: "message.user", text: "and tests" },
      { type: "message.start", role: "assistant" },
      { type: "message.delta", text: "done" },
      { type: "message.end" },
    ]
    append(id, second)

    // 3) Reattach WITH the committed cursor: only the suffix replays.
    const attach2 = new SessionStreamMachine({ visible: run1.visible, durable: run1.visible, cursor: cursor1 })
    expect(attach2.requestCursor).toBe(cursor1)
    const run2 = await attach(id, attach2, "commit")
    expect(run2.replayed).toEqual([4, 5, 6, 7])
    expect(run2.visible).toEqual(rebuildTranscript([...first, ...second]))
    expect(run2.cursor).not.toBe(cursor1)
    // The screen never got smaller at any point across both attempts.
    const sizes = [...run1.frames, ...run2.frames].map(size)
    expect(sizes).toEqual([...sizes].sort((a, b) => a - b))

    // 4) History rewritten under us (what a rewind does to the event log):
    //    the old cursor is refused, and the rebuild lands only at replay-end.
    const rewritten: AgentEvent[] = [
      { type: "message.user", text: "build it" },
      { type: "message.start", role: "assistant" },
      { type: "message.delta", text: "restarted" },
      { type: "message.end" },
    ]
    db!.transaction(() => {
      db!.query("DELETE FROM events WHERE session_id=?").run(id)
      db!.query("UPDATE sessions SET history_generation=? WHERE id=?").run(crypto.randomUUID(), id)
      append(id, rewritten)
    })()
    expect(generation(id)).toBeString()

    const attach3 = new SessionStreamMachine({ visible: run2.visible, durable: run2.visible, cursor: run2.cursor })
    // Mid-rebuild the reader still sees the OLD transcript…
    const partial = await attach(id, attach3, 3)
    expect(partial.resets).toEqual(["history-rewritten"])
    expect(partial.committed).toBe(false)
    expect(partial.visible).toEqual(run2.visible)

    // …and a full retry from the SAME committed cursor commits the rebuild.
    const attach4 = new SessionStreamMachine({ visible: run2.visible, durable: run2.visible, cursor: run2.cursor })
    const run4 = await attach(id, attach4, "commit")
    expect(run4.resets).toEqual(["history-rewritten"])
    expect(run4.replayed).toEqual([0, 1, 2, 3])
    expect(run4.visible).toEqual(rebuildTranscript(rewritten))
    expect(run4.frames.length).toBe(2)
    expect(run4.legacy).toBe(0)
  }, 60_000)
})
