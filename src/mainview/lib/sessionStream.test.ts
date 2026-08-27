// The v2 (cursor) session stream, driven with SYNTHETIC frames — no server.
//
// The scenarios here are the ones that used to go wrong with the from-zero
// replay: a reconnect after backgrounding, a replay that dies half way, and a
// live overlay of raw tokens meeting the coalesced persisted delta.
//
// Run with: bun test src/mainview/lib/sessionStream.test.ts
import { describe, expect, test } from "bun:test"
import {
  encodeSessionEventCursor,
  type AgentEvent,
  type SessionEventCursor,
} from "@chunky/protocol"
import { initialState, reduce, type TranscriptState } from "./transcript"
import { rebuildTranscript, SessionCache } from "./sessionCache"
import { ReplayReconciler } from "./replayReconciler"
import { SessionStreamMachine, v2CacheNeedsLegacyRebuild, type SessionStreamFrame } from "./sessionStream"

const GEN = "g1"
const at = (nextSeq: number, generation = GEN): SessionEventCursor => ({ generation, nextSeq })

/** A durable `event` frame at `seq`; the cursor is the position AFTER it. */
function ev(seq: number, event: AgentEvent, generation = GEN): SessionStreamFrame {
  return { kind: "event", seq, cursor: at(seq + 1, generation), event }
}
const liveFrame = (event: AgentEvent): SessionStreamFrame => ({ kind: "live", event })
const end = (nextSeq: number, generation = GEN): SessionStreamFrame => ({ kind: "replay-end", cursor: at(nextSeq, generation) })

const history: AgentEvent[] = [
  { type: "message.user", text: "build it" },
  { type: "message.start", role: "assistant" },
  { type: "message.delta", text: "on it" },
  { type: "message.end" },
]

interface Screen {
  /** Everything the reader ever saw, oldest first. */
  frames: TranscriptState[]
  visible: TranscriptState
  committed: { durable: TranscriptState | null; cursor: string | null }
  resets: number
  legacy: AgentEvent[]
  commits: number
}

/**
 * Drive frames the way useAttachedSession does: reduce visible events, take the
 * committed projection at replay-end, and record every state the screen showed
 * so a regression (an older projection replacing a newer one) is detectable.
 */
function drive(machine: SessionStreamMachine, frames: SessionStreamFrame[], screen?: Screen): Screen {
  const out: Screen = screen ?? {
    frames: [machine.visible],
    visible: machine.visible,
    committed: { durable: null, cursor: null },
    resets: 0,
    legacy: [],
    commits: 0,
  }
  for (const frame of frames) {
    const step = machine.handle(frame)
    if (step.kind === "legacy") { out.legacy.push(step.event); continue }
    if (step.kind === "reset") { out.resets += 1; continue }
    if (step.kind === "durable") continue
    if (step.kind === "commit") {
      out.commits += 1
      out.committed = { durable: step.durable, cursor: step.cursor }
      out.visible = step.visible
      out.frames.push(step.visible)
      continue
    }
    out.visible = machine.reduceVisible(step.event)
    out.frames.push(out.visible)
  }
  return out
}

/** How many transcript items a projection renders. */
const size = (state: TranscriptState) => state.order.length

describe("v2 session stream: initial attach", () => {
  test("an empty cache renders the replayed history at replay-end", () => {
    const machine = new SessionStreamMachine()
    expect(machine.requestCursor).toBeNull()
    const screen = drive(machine, [
      ...history.map((event, i) => ev(i, event)),
      end(history.length),
    ])
    expect(screen.commits).toBe(1)
    expect(screen.visible).toEqual(rebuildTranscript(history))
    expect(screen.committed.durable).toEqual(rebuildTranscript(history))
    expect(screen.committed.cursor).toBe(encodeSessionEventCursor(at(4)))
    // Nothing was shown before the commit: the replay never flickered.
    expect(screen.frames.slice(0, -1).every((f) => f === initialState)).toBe(true)
  })

  test("a cached cursor without its durable shadow replays from zero", () => {
    const machine = new SessionStreamMachine({ cursor: encodeSessionEventCursor(at(4)), durable: null })
    expect(machine.requestCursor).toBeNull()
  })
})

describe("v2 session stream: reconnect from a cursor", () => {
  test("replays only the suffix and the screen never regresses", () => {
    const durable = rebuildTranscript(history)
    const cursor = encodeSessionEventCursor(at(4))
    const machine = new SessionStreamMachine({ visible: durable, durable, cursor })
    expect(machine.requestCursor).toBe(cursor)

    const suffix: AgentEvent[] = [
      { type: "message.user", text: "and tests" },
      { type: "message.start", role: "assistant" },
      { type: "message.delta", text: "done" },
      { type: "message.end" },
    ]
    const screen = drive(machine, [
      ...suffix.map((event, i) => ev(4 + i, event)),
      end(8),
    ])
    expect(screen.visible).toEqual(rebuildTranscript([...history, ...suffix]))
    expect(screen.committed.cursor).toBe(encodeSessionEventCursor(at(8)))
    // Monotonic: every projection the reader saw was at least as big as the one before.
    const sizes = screen.frames.map(size)
    expect(sizes).toEqual([...sizes].sort((a, b) => a - b))
    expect(sizes[0]).toBe(size(durable))
  })
})

describe("v2 session stream: an interrupted replay", () => {
  test("a disconnect after replay-reset keeps the old screen and cursor, and the retry commits", () => {
    const durable = rebuildTranscript(history)
    const cursor = encodeSessionEventCursor(at(4))
    const cache = new SessionCache()
    cache.set("s1", { transcript: durable, goal: null, repoId: null, events: [], durable, cursor })

    // Attempt 1: server rewrote history, then the connection dies mid-rebuild.
    const first = new SessionStreamMachine({ visible: durable, durable, cursor })
    const rewritten: AgentEvent[] = [
      { type: "message.user", text: "build it (edited)" },
      { type: "message.start", role: "assistant" },
    ]
    const screen = drive(first, [
      { kind: "replay-reset", reason: "history-rewritten", cursor: at(0, "g2") },
      ...rewritten.map((event, i) => ev(i, event, "g2")),
      // …and then nothing: no replay-end.
    ])
    expect(screen.resets).toBe(1)
    expect(screen.commits).toBe(0)
    // The screen is untouched, and so is the committed cursor in the cache.
    expect(screen.visible).toEqual(durable)
    expect(cache.get("s1")?.transcript).toEqual(durable)
    expect(cache.get("s1")?.cursor).toBe(cursor)

    // Attempt 2: built from the SAME committed state, resumes from the same cursor.
    const second = new SessionStreamMachine({
      visible: cache.get("s1")!.transcript,
      durable: cache.get("s1")!.durable,
      cursor: cache.get("s1")!.cursor,
    })
    expect(second.requestCursor).toBe(cursor)
    const retry = drive(second, [
      { kind: "replay-reset", reason: "history-rewritten", cursor: at(0, "g2") },
      ...rewritten.map((event, i) => ev(i, event, "g2")),
      end(2, "g2"),
    ])
    expect(retry.commits).toBe(1)
    expect(retry.visible).toEqual(rebuildTranscript(rewritten))
    cache.commitCursor("s1", {
      transcript: retry.visible,
      durable: retry.committed.durable!,
      cursor: retry.committed.cursor!,
      goal: null,
      repoId: null,
    })
    expect(cache.get("s1")?.cursor).toBe(encodeSessionEventCursor(at(2, "g2")))
    expect(cache.get("s1")?.events).toEqual([])
  })

  test("replay-reset rebuilds from scratch but swaps the screen only at replay-end", () => {
    const durable = rebuildTranscript(history)
    const machine = new SessionStreamMachine({ visible: durable, durable, cursor: encodeSessionEventCursor(at(4)) })
    const rebuilt: AgentEvent[] = [
      { type: "message.user", text: "fresh" },
      { type: "message.start", role: "assistant" },
      { type: "message.delta", text: "rebuilt" },
      { type: "message.end" },
    ]
    const frames: SessionStreamFrame[] = [
      { kind: "replay-reset", reason: "history-rewritten", cursor: at(0, "g2") },
      ...rebuilt.map((event, i) => ev(i, event, "g2")),
    ]
    const screen = drive(machine, frames)
    // Mid-rebuild the reader still sees the OLD history, not a half-built one.
    expect(screen.visible).toEqual(durable)
    drive(machine, [end(4, "g2")], screen)
    expect(screen.visible).toEqual(rebuildTranscript(rebuilt))
    expect(screen.committed.cursor).toBe(encodeSessionEventCursor(at(4, "g2")))
  })
})

describe("v2 session stream: live phase", () => {
  test("raw tokens render, and the coalesced persisted delta only advances the cursor", () => {
    const machine = new SessionStreamMachine()
    const screen = drive(machine, [
      ev(0, { type: "message.user", text: "hi" }),
      end(1),
      // Live phase: message.start persists once, tokens arrive raw.
      ev(1, { type: "message.start", role: "assistant" }),
      liveFrame({ type: "message.delta", text: "hel" }),
      liveFrame({ type: "message.delta", text: "lo" }),
      // …and later the SAME text arrives coalesced and persisted.
      ev(2, { type: "message.delta", text: "hello" }),
      ev(3, { type: "message.end" }),
    ])
    const expected = rebuildTranscript([
      { type: "message.user", text: "hi" },
      { type: "message.start", role: "assistant" },
      { type: "message.delta", text: "hello" },
      { type: "message.end" },
    ])
    // No duplicate "hello": the coalesced delta never touched the screen.
    expect(screen.visible).toEqual(expected)
    // …but the durable shadow has it, at the advanced cursor.
    expect(machine.durable).toEqual(expected)
    expect(machine.cursor).toBe(encodeSessionEventCursor(at(4)))
  })

  test("live-only frames stay out of the durable shadow", () => {
    const machine = new SessionStreamMachine()
    drive(machine, [ev(0, { type: "message.user", text: "hi" }), end(1)])
    const durableBefore = machine.durable
    const cursorBefore = machine.cursor
    drive(machine, [liveFrame({ type: "ports.changed", ports: [] } as unknown as AgentEvent)])
    expect(machine.durable).toBe(durableBefore)
    expect(machine.cursor).toBe(cursorBefore)
  })
})

describe("legacy servers", () => {
  test("v2CacheNeedsLegacyRebuild is true only for a cursor/durable cache", () => {
    expect(v2CacheNeedsLegacyRebuild(null)).toBe(false)
    expect(v2CacheNeedsLegacyRebuild({})).toBe(false)
    expect(v2CacheNeedsLegacyRebuild({ cursor: null, durable: null })).toBe(false)
    expect(v2CacheNeedsLegacyRebuild({ cursor: encodeSessionEventCursor(at(4)), durable: rebuildTranscript(history) })).toBe(true)
    expect(v2CacheNeedsLegacyRebuild({ cursor: encodeSessionEventCursor(at(4)), durable: null })).toBe(true)
    expect(v2CacheNeedsLegacyRebuild({ cursor: null, durable: rebuildTranscript(history) })).toBe(true)
  })

  /**
   * Drive a from-zero legacy replay the way useAttachedSession.onFrame does on
   * the first unnamed frame: if the cache is v2-shaped, drop cursor/durable and
   * rebuild from event zero instead of appending onto the visible transcript.
   */
  function legacyFallbackReplay(opts: {
    cached: {
      transcript: TranscriptState
      events: AgentEvent[]
      durable?: TranscriptState | null
      cursor?: string | null
    }
    incoming: AgentEvent[]
  }) {
    let replay = new ReplayReconciler(opts.cached.events)
    let committedDurable = opts.cached.durable ?? null
    let committedCursor = opts.cached.cursor ?? null
    let state = opts.cached.transcript
    let rebuiltFromZero = false
    if (v2CacheNeedsLegacyRebuild({ cursor: committedCursor, durable: committedDurable })) {
      replay = new ReplayReconciler()
      committedDurable = null
      committedCursor = null
      state = initialState
      rebuiltFromZero = true
    }
    for (const event of opts.incoming) {
      const decision = replay.next(event)
      if (decision.kind === "skip") continue
      if (decision.kind === "rebuild") state = rebuildTranscript(decision.prefix)
      state = reduce(state, event)
    }
    return { state, rebuiltFromZero, committedCursor, committedDurable }
  }

  test("a v2-cached session falling back to legacy does not duplicate history", () => {
    const durable = rebuildTranscript(history)
    const cursor = encodeSessionEventCursor(at(4))
    const cache = new SessionCache()
    cache.commitCursor("s1", {
      transcript: durable,
      durable,
      cursor,
      goal: null,
      repoId: null,
    })
    const cached = cache.get("s1")!
    expect(cached.events).toEqual([])
    expect(v2CacheNeedsLegacyRebuild(cached)).toBe(true)

    // The bug: an empty events prefix makes ReplayReconciler accept every
    // from-zero event onto the already-visible projection, doubling it.
    const items = (state: TranscriptState) => state.threads.main!.items.length
    const naive = history.reduce(reduce, cached.transcript)
    expect(items(naive)).toBe(items(durable) * 2)

    const result = legacyFallbackReplay({ cached, incoming: history })
    expect(result.rebuiltFromZero).toBe(true)
    expect(result.committedCursor).toBeNull()
    expect(result.committedDurable).toBeNull()
    expect(result.state).toEqual(durable)
    expect(items(result.state)).toBe(items(durable))
  })

  test("a v2-cached fallback still picks up history that arrived while detached", () => {
    const durable = rebuildTranscript(history)
    const suffix: AgentEvent[] = [
      { type: "message.user", text: "and tests" },
      { type: "message.start", role: "assistant" },
      { type: "message.delta", text: "done" },
      { type: "message.end" },
    ]
    const incoming = [...history, ...suffix]
    const result = legacyFallbackReplay({
      cached: { transcript: durable, events: [], durable, cursor: encodeSessionEventCursor(at(4)) },
      incoming,
    })
    expect(result.rebuiltFromZero).toBe(true)
    expect(result.state).toEqual(rebuildTranscript(incoming))
    const items = (state: TranscriptState) => state.threads.main!.items.length
    expect(items(result.state)).toBe(items(durable) + items(rebuildTranscript(suffix)))
  })

  test("a legacy events-prefix cache still skips its own past", () => {
    const cached = {
      transcript: rebuildTranscript(history),
      events: history,
      durable: null as TranscriptState | null,
      cursor: null as string | null,
    }
    const extra: AgentEvent = { type: "message.user", text: "and tests" }
    const result = legacyFallbackReplay({ cached, incoming: [...history, extra] })
    expect(result.rebuiltFromZero).toBe(false)
    expect(result.state).toEqual(rebuildTranscript([...history, extra]))
  })

  test("legacy frames bypass the machine and feed the full-replay reconciler", () => {
    const machine = new SessionStreamMachine({
      visible: rebuildTranscript(history),
      durable: rebuildTranscript(history),
      cursor: encodeSessionEventCursor(at(4)),
    })
    const screen = drive(machine, history.map((event) => ({ kind: "legacy", event }) as SessionStreamFrame))
    // Nothing was committed or rendered by the machine…
    expect(screen.commits).toBe(0)
    expect(screen.legacy).toEqual(history)
    expect(machine.phase).toBe("replay")

    // …and the reconciler recognises the cached prefix exactly as it always did.
    const reconciler = new ReplayReconciler(history)
    let state = rebuildTranscript(history)
    let completed = false
    for (const event of screen.legacy) {
      const decision = reconciler.next(event)
      if (decision.kind === "skip") { completed ||= decision.complete; continue }
      if (decision.kind === "rebuild") state = rebuildTranscript(decision.prefix)
    }
    expect(completed).toBe(true)
    expect(state).toEqual(rebuildTranscript(history))
  })
})
