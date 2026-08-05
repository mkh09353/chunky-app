import { describe, expect, test } from "bun:test"
import type { SessionSummary } from "@chunky/protocol"
import {
  activityCounts,
  addUnreadSessions,
  buildRepoActivity,
  clearUnreadSession,
  sameRepoRows,
  type ActivityRepo,
} from "./repoActivity"

const NOW = 1_000_000_000

const row = (id: string, extra: Partial<SessionSummary> = {}): SessionSummary => ({
  sessionId: id,
  title: id,
  createdAt: 1,
  lastActivity: NOW,
  workspace: "/repo",
  ...extra,
})

const repos: ActivityRepo[] = [
  { id: "one", name: "One" },
  { id: "two", name: "Two" },
]

const rowsFor = (map: Record<string, SessionSummary[]>) =>
  new Map<string, readonly SessionSummary[]>(Object.entries(map))

describe("buildRepoActivity", () => {
  test("splits busy from settled, using the shared busy rule (delegates count)", () => {
    const list = buildRepoActivity(
      repos.slice(0, 1),
      rowsFor({
        one: [
          row("root-running", { running: true }),
          // Root stopped but a delegate is alive: still In Progress.
          row("delegate-only", { running: false, busy: true }),
          row("settled", { running: false, busy: false }),
        ],
      }),
      { now: NOW },
    )
    expect(list).toHaveLength(1)
    expect(list[0]!.inProgress.map((r) => r.sessionId).sort()).toEqual([
      "delegate-only",
      "root-running",
    ])
    expect(list[0]!.settled.map((r) => r.sessionId)).toEqual(["settled"])
  })

  test("omits repositories with nothing working and nothing recent", () => {
    const list = buildRepoActivity(
      repos,
      rowsFor({
        one: [row("a", { running: true })],
        // Long idle and never unread — silence, so repo two disappears.
        two: [row("old", { lastActivity: NOW - 48 * 60 * 60_000 })],
      }),
      { now: NOW },
    )
    expect(list.map((r) => r.repoId)).toEqual(["one"])
  })

  test("an unread session is shown however old it is, and sorts above recent ones", () => {
    const list = buildRepoActivity(
      repos.slice(0, 1),
      rowsFor({
        one: [
          row("recent", { lastActivity: NOW - 60_000 }),
          row("ancient-unread", { lastActivity: NOW - 90 * 60 * 60_000 }),
        ],
      }),
      { now: NOW, unread: new Set(["ancient-unread"]) },
    )
    expect(list[0]!.settled.map((r) => r.sessionId)).toEqual(["ancient-unread", "recent"])
    expect(list[0]!.settled[0]!.unread).toBe(true)
  })

  test("settled rows are newest-first within the unread and read halves", () => {
    const list = buildRepoActivity(
      repos.slice(0, 1),
      rowsFor({
        one: [
          row("read-old", { lastActivity: NOW - 3_000 }),
          row("unread-old", { lastActivity: NOW - 4_000 }),
          row("read-new", { lastActivity: NOW - 1_000 }),
          row("unread-new", { lastActivity: NOW - 2_000 }),
        ],
      }),
      { now: NOW, unread: new Set(["unread-old", "unread-new"]) },
    )
    expect(list[0]!.settled.map((r) => r.sessionId)).toEqual([
      "unread-new",
      "unread-old",
      "read-new",
      "read-old",
    ])
  })

  test("caps settled rows per repo and reports how many are hidden", () => {
    const many = Array.from({ length: 9 }, (_, i) =>
      row(`s${i}`, { lastActivity: NOW - i * 1_000 }),
    )
    const list = buildRepoActivity(repos.slice(0, 1), rowsFor({ one: many }), {
      now: NOW,
      settledLimit: 5,
    })
    expect(list[0]!.settled).toHaveLength(5)
    expect(list[0]!.settledHidden).toBe(4)
    // In Progress is never truncated — working sessions are the whole point.
    const busy = Array.from({ length: 9 }, (_, i) => row(`b${i}`, { busy: true }))
    const busyList = buildRepoActivity(repos.slice(0, 1), rowsFor({ one: busy }), {
      now: NOW,
      settledLimit: 5,
    })
    expect(busyList[0]!.inProgress).toHaveLength(9)
  })

  test("a busy session is never also listed as settled, even when unread", () => {
    const list = buildRepoActivity(
      repos.slice(0, 1),
      rowsFor({ one: [row("a", { busy: true })] }),
      { now: NOW, unread: new Set(["a"]) },
    )
    expect(list[0]!.inProgress.map((r) => r.sessionId)).toEqual(["a"])
    expect(list[0]!.settled).toEqual([])
  })

  test("a repo with no rows at all is simply absent", () => {
    expect(buildRepoActivity(repos, new Map(), { now: NOW })).toEqual([])
  })
})

describe("activityCounts", () => {
  test("totals working sessions and unread completions across repos", () => {
    const list = buildRepoActivity(
      repos,
      rowsFor({
        one: [row("a", { busy: true }), row("b")],
        two: [row("c", { busy: true }), row("d"), row("e")],
      }),
      { now: NOW, unread: new Set(["b", "d"]) },
    )
    expect(activityCounts(list)).toEqual({ working: 2, unread: 2, repos: 2 })
  })
})

describe("sameRepoRows", () => {
  test("spots the fields the overlay renders", () => {
    const a = rowsFor({ one: [row("a", { busy: true })] })
    expect(sameRepoRows(a, rowsFor({ one: [row("a", { busy: true })] }))).toBe(true)
    // busy flipping is exactly what must re-render.
    expect(sameRepoRows(a, rowsFor({ one: [row("a", { busy: false })] }))).toBe(false)
    expect(sameRepoRows(a, rowsFor({ one: [row("a", { busy: true, title: "x" })] }))).toBe(false)
    expect(sameRepoRows(a, rowsFor({ one: [] }))).toBe(false)
    expect(sameRepoRows(a, rowsFor({ one: [row("a", { busy: true })], two: [] }))).toBe(false)
  })
})

describe("unread bookkeeping", () => {
  test("adds ids and keeps set identity when nothing changed", () => {
    const start = new Set(["a"])
    const added = addUnreadSessions(start, ["b", "c"])
    expect([...added].sort()).toEqual(["a", "b", "c"])
    // Re-adding known ids must not produce a new set (no wasted React commit).
    expect(addUnreadSessions(added, ["a", "b"])).toBe(added)
    expect(addUnreadSessions(start, [])).toBe(start)
  })

  test("never marks the session the reader is watching", () => {
    const out = addUnreadSessions(new Set(), ["a", "b"], "a")
    expect([...out]).toEqual(["b"])
  })

  test("clearing is identity-stable when the id was not unread", () => {
    const start = new Set(["a", "b"])
    expect([...clearUnreadSession(start, "a")].sort()).toEqual(["b"])
    expect(clearUnreadSession(start, "zzz")).toBe(start)
  })
})
