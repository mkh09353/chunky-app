import { describe, expect, test } from "bun:test"
import type { AgentEvent, SessionHistoryResponse } from "@chunky/protocol"
import { rebuildTranscript } from "./sessionCache"
import {
  appendMonotonicHistoryRow,
  committedSessionSnapshot,
  projectSessionHistory,
  SessionHistoryPager,
} from "./sessionHistory"

const cursor = (nextSeq: number, generation = "g1") => ({ generation, nextSeq })
const rows = (start: number, events: AgentEvent[]) =>
  events.map((event, index) => ({ seq: start + index, event }))

describe("bounded session history projection", () => {
  test("cold tail projection is identical to replaying the same suffix", () => {
    const events: AgentEvent[] = [
      { type: "message.user", text: "build it" },
      { type: "tool.start", id: "t", name: "bash", input: { command: "pwd" } },
      { type: "tool.end", id: "t", ok: true, output: "/tmp" },
      { type: "message.user", text: "notice", from: "monitor" },
    ]
    const projected = projectSessionHistory(rows(20, events), cursor(24))
    expect(projected.transcript).toEqual(rebuildTranscript(events))
  })

  test("cursor-resume suffix includes events that arrived during tail fetch exactly once", () => {
    const tail: AgentEvent[] = [{ type: "message.user", text: "tail" }]
    const suffix: AgentEvent[] = [
      { type: "message.start", role: "assistant" },
      { type: "message.delta", text: "new" },
      { type: "message.end" },
    ]
    const seeded = projectSessionHistory(rows(4, tail), cursor(5))
    const complete = projectSessionHistory(rows(4, [...tail, ...suffix]), cursor(8))
    expect(seeded.cursor).not.toBe(complete.cursor)
    expect(complete.transcript).toEqual(rebuildTranscript([...tail, ...suffix]))
  })

  test("older pages prepend in sequence order and duplicate boundaries are ignored", async () => {
    const newer = rows(2, [
      { type: "message.user", text: "new" },
      { type: "message.delta", text: "answer" },
    ])
    const pager = new SessionHistoryPager(newer, { before: "older", hasMore: true })
    let committed: AgentEvent[] = []
    await pager.load(
      async (): Promise<SessionHistoryResponse> => ({
        events: [
          ...rows(0, [
          { type: "session.status", sessionId: "s", status: "idle" },
          { type: "message.user", text: "old" },
          ]),
          newer[0]!,
        ],
        cursor: cursor(4),
        before: null,
        hasMore: false,
        firstSeq: 0,
        lastSeq: 2,
      }),
      () => true,
      (merged) => { committed = merged.map((row) => row.event) },
    )
    expect(committed.map((event) => event.type)).toEqual([
      "session.status", "message.user", "message.user", "message.delta",
    ])
  })

  test("paging is idempotent in flight and stale settlement cannot commit", async () => {
    const pager = new SessionHistoryPager([], { before: "older", hasMore: true })
    let resolve!: (page: SessionHistoryResponse) => void
    let calls = 0
    let commits = 0
    let current = true
    const fetchPage = () => {
      calls += 1
      return new Promise<SessionHistoryResponse>((done) => { resolve = done })
    }
    const first = pager.load(fetchPage, () => current, () => { commits += 1 })
    await pager.load(fetchPage, () => current, () => { commits += 1 })
    current = false
    resolve({ events: [], cursor: cursor(0), before: null, hasMore: false, firstSeq: null, lastSeq: null })
    await first
    expect(calls).toBe(1)
    expect(commits).toBe(0)
  })

  test("a 10k live burst appends monotonically without scanning prior rows", () => {
    const history: ReturnType<typeof rows> = []
    let lastSeq = -1
    for (let seq = 0; seq < 10_000; seq++) {
      lastSeq = appendMonotonicHistoryRow(
        history,
        { seq, event: { type: "message.delta", text: String(seq) } },
        lastSeq,
      )
    }
    // Replayed/duplicate positions are rejected from the scalar boundary;
    // no Array.some/find/indexOf callback exists on this path.
    lastSeq = appendMonotonicHistoryRow(
      history,
      { seq: 5_000, event: { type: "message.delta", text: "duplicate" } },
      lastSeq,
    )
    expect(history).toHaveLength(10_000)
    expect(lastSeq).toBe(9_999)
  })

  test("snapshots require a committed projection and valid durable cursor", () => {
    const transcript = rebuildTranscript([{ type: "message.user", text: "committed" }])
    expect(committedSessionSnapshot(null, "cursor", null)).toBeNull()
    expect(committedSessionSnapshot(transcript, null, null)).toBeNull()
    expect(committedSessionSnapshot(transcript, "malformed", null)).toBeNull()
    expect(committedSessionSnapshot(
      transcript,
      projectSessionHistory(rows(0, [{ type: "message.user", text: "committed" }]), cursor(1)).cursor,
      { before: "older", hasMore: true },
      123,
    )).toEqual({
      version: 1,
      transcript,
      cursor: cursor(1),
      olderPage: { before: "older", hasMore: true },
      savedAt: 123,
    })
  })
})
