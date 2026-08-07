import { describe, expect, test } from "bun:test"
import type { GoalSnapshot, SessionSummary } from "@chunky/protocol"
import {
  buildHomeFeed,
  homeFeedCounts,
  homeGoalCandidates,
  RECENT_SETTLED_MS,
  SETTLED_LIMIT,
  updateBusySince,
  type FeedRepo,
} from "./homeFeed"

const NOW = 1_000_000_000
const MINUTE = 60_000

const row = (id: string, extra: Partial<SessionSummary> = {}): SessionSummary => ({
  sessionId: id,
  title: id,
  createdAt: 1,
  lastActivity: NOW,
  workspace: "/repo",
  ...extra,
})

const repos: FeedRepo[] = [
  { id: "app", name: "chunky-app" },
  { id: "core", name: "chunky" },
  { id: "zoo", name: "zoo" },
]

const rowsFor = (map: Record<string, SessionSummary[]>) =>
  new Map<string, readonly SessionSummary[]>(Object.entries(map))

const goal = (status: GoalSnapshot["status"], objective = "ship the thing"): GoalSnapshot => ({
  objective,
  status,
  turns: 1,
  maxTurns: 10,
})

describe("buildHomeFeed — section assignment", () => {
  test("busy → running, blocked goal → needs you, the rest → settled", () => {
    const feed = buildHomeFeed(
      repos,
      rowsFor({
        app: [row("running", { running: true }), row("idle")],
        core: [row("blocked")],
        zoo: [],
      }),
      { now: NOW, goals: new Map([["blocked", goal("blocked")]]) },
    )
    expect(feed.running.map((r) => r.sessionId)).toEqual(["running"])
    expect(feed.needsYou.map((r) => r.sessionId)).toEqual(["blocked"])
    expect(feed.settled.map((r) => r.sessionId)).toEqual(["idle"])
  })

  test("the shared busy rule applies: a live delegate keeps a row running", () => {
    const feed = buildHomeFeed(
      repos.slice(0, 1),
      rowsFor({ app: [row("delegate-only", { running: false, busy: true })] }),
      { now: NOW },
    )
    expect(feed.running.map((r) => r.sessionId)).toEqual(["delegate-only"])
    expect(feed.settled).toHaveLength(0)
  })

  test("busy wins over a blocked goal — something is working, so it is not waiting on you", () => {
    const feed = buildHomeFeed(
      repos.slice(0, 1),
      rowsFor({ app: [row("both", { busy: true })] }),
      { now: NOW, goals: new Map([["both", goal("blocked")]]) },
    )
    expect(feed.running.map((r) => r.sessionId)).toEqual(["both"])
    expect(feed.needsYou).toHaveLength(0)
  })

  test("only `blocked` goals qualify; active/paused/complete are ordinary rows", () => {
    const feed = buildHomeFeed(
      repos.slice(0, 1),
      rowsFor({ app: [row("a"), row("b"), row("c"), row("d")] }),
      {
        now: NOW,
        goals: new Map([
          ["a", goal("active")],
          ["b", goal("paused")],
          ["c", goal("complete")],
          ["d", null],
        ]),
      },
    )
    expect(feed.needsYou).toHaveLength(0)
    expect(feed.settled.map((r) => r.sessionId).sort()).toEqual(["a", "b", "c", "d"])
  })

  test("a blocked row carries the goal objective and how long it has waited", () => {
    const feed = buildHomeFeed(
      repos.slice(0, 1),
      rowsFor({ app: [row("blocked", { lastActivity: NOW - 5 * MINUTE })] }),
      { now: NOW, goals: new Map([["blocked", goal("blocked", "get prod credentials")]]) },
    )
    expect(feed.needsYou[0]!.reason).toBe("get prod credentials")
    expect(feed.needsYou[0]!.waitingMs).toBe(5 * MINUTE)
  })

  test("no goals fetched (or every fetch failed) degrades to an empty Needs You", () => {
    const feed = buildHomeFeed(repos.slice(0, 1), rowsFor({ app: [row("idle")] }), { now: NOW })
    expect(feed.needsYou).toEqual([])
    expect(feed.settled.map((r) => r.sessionId)).toEqual(["idle"])
  })
})

describe("buildHomeFeed — rows, repos and sorting", () => {
  test("every row carries its own repo identity", () => {
    const feed = buildHomeFeed(repos, rowsFor({ core: [row("s")] }), { now: NOW })
    expect(feed.settled[0]).toMatchObject({ repoId: "core", repoName: "chunky", title: "s" })
  })

  test("each section is flat and newest-first across repositories", () => {
    const feed = buildHomeFeed(
      repos,
      rowsFor({
        app: [row("old", { lastActivity: NOW - 30 * MINUTE })],
        core: [row("new", { lastActivity: NOW - MINUTE })],
        zoo: [row("mid", { lastActivity: NOW - 10 * MINUTE })],
      }),
      { now: NOW },
    )
    expect(feed.settled.map((r) => r.sessionId)).toEqual(["new", "mid", "old"])
  })

  test("needs-you and running are sorted the same way", () => {
    const feed = buildHomeFeed(
      repos,
      rowsFor({
        app: [
          row("run-old", { busy: true, lastActivity: NOW - 9 * MINUTE }),
          row("block-old", { lastActivity: NOW - 9 * MINUTE }),
        ],
        core: [
          row("run-new", { busy: true, lastActivity: NOW - MINUTE }),
          row("block-new", { lastActivity: NOW - MINUTE }),
        ],
      }),
      {
        now: NOW,
        goals: new Map([
          ["block-old", goal("blocked")],
          ["block-new", goal("blocked")],
        ]),
      },
    )
    expect(feed.running.map((r) => r.sessionId)).toEqual(["run-new", "run-old"])
    expect(feed.needsYou.map((r) => r.sessionId)).toEqual(["block-new", "block-old"])
  })

  test("a session listed under two repositories is kept once, under the first", () => {
    const shared = row("shared")
    const feed = buildHomeFeed(repos, rowsFor({ app: [shared], core: [shared] }), { now: NOW })
    expect(feed.settled).toHaveLength(1)
    expect(feed.settled[0]!.repoId).toBe("app")
  })

  test("repositories with no rows contribute nothing and do not throw", () => {
    const feed = buildHomeFeed(repos, rowsFor({}), { now: NOW })
    expect(feed).toEqual({ needsYou: [], running: [], settled: [], settledHidden: 0 })
  })
})

describe("buildHomeFeed — unread and the settled window", () => {
  test("unread is read from the provided set", () => {
    const feed = buildHomeFeed(repos.slice(0, 1), rowsFor({ app: [row("a"), row("b")] }), {
      now: NOW,
      unread: new Set(["a"]),
    })
    expect(feed.settled.find((r) => r.sessionId === "a")!.unread).toBe(true)
    expect(feed.settled.find((r) => r.sessionId === "b")!.unread).toBe(false)
  })

  test("an unread session shows however old it is; a read one falls out of the window", () => {
    const ancient = { lastActivity: NOW - RECENT_SETTLED_MS - MINUTE }
    const feed = buildHomeFeed(
      repos.slice(0, 1),
      rowsFor({ app: [row("ancient-unread", ancient), row("ancient-read", ancient)] }),
      { now: NOW, unread: new Set(["ancient-unread"]) },
    )
    expect(feed.settled.map((r) => r.sessionId)).toEqual(["ancient-unread"])
  })

  test("unread does NOT jump the queue — the settled list stays purely chronological", () => {
    const feed = buildHomeFeed(
      repos.slice(0, 1),
      rowsFor({
        app: [
          row("old-unread", { lastActivity: NOW - 20 * MINUTE }),
          row("new-read", { lastActivity: NOW - MINUTE }),
        ],
      }),
      { now: NOW, unread: new Set(["old-unread"]) },
    )
    expect(feed.settled.map((r) => r.sessionId)).toEqual(["new-read", "old-unread"])
  })

  test("a busy row is never filtered by the recency window", () => {
    const feed = buildHomeFeed(
      repos.slice(0, 1),
      rowsFor({
        app: [row("long-runner", { busy: true, lastActivity: NOW - 5 * RECENT_SETTLED_MS })],
      }),
      { now: NOW },
    )
    expect(feed.running.map((r) => r.sessionId)).toEqual(["long-runner"])
  })
})

describe("buildHomeFeed — settled cap", () => {
  const many = Array.from({ length: SETTLED_LIMIT + 5 }, (_, i) =>
    row(`s${i}`, { lastActivity: NOW - i * MINUTE }),
  )

  test("caps the settled list and reports what it withheld", () => {
    const feed = buildHomeFeed(repos.slice(0, 1), rowsFor({ app: many }), { now: NOW })
    expect(feed.settled).toHaveLength(SETTLED_LIMIT)
    expect(feed.settledHidden).toBe(5)
    // The newest survive the cut.
    expect(feed.settled[0]!.sessionId).toBe("s0")
    expect(feed.settled.at(-1)!.sessionId).toBe(`s${SETTLED_LIMIT - 1}`)
  })

  test("the cap is configurable and nothing is hidden below it", () => {
    const feed = buildHomeFeed(repos.slice(0, 1), rowsFor({ app: many.slice(0, 3) }), {
      now: NOW,
      settledLimit: 5,
    })
    expect(feed.settled).toHaveLength(3)
    expect(feed.settledHidden).toBe(0)
  })
})

describe("buildHomeFeed — elapsed from busy-since", () => {
  test("elapsed is derived from the first-seen-busy timestamp", () => {
    const feed = buildHomeFeed(repos.slice(0, 1), rowsFor({ app: [row("r", { busy: true })] }), {
      now: NOW,
      busySince: new Map([["r", NOW - 3 * MINUTE]]),
    })
    expect(feed.running[0]!.elapsedMs).toBe(3 * MINUTE)
  })

  test("a session with no busy-since omits elapsed rather than faking one", () => {
    const feed = buildHomeFeed(repos.slice(0, 1), rowsFor({ app: [row("r", { busy: true })] }), {
      now: NOW,
    })
    expect(feed.running[0]!.elapsedMs).toBeUndefined()
    expect("elapsedMs" in feed.running[0]!).toBe(false)
  })

  test("a clock that went backwards clamps to zero instead of going negative", () => {
    const feed = buildHomeFeed(repos.slice(0, 1), rowsFor({ app: [row("r", { busy: true })] }), {
      now: NOW,
      busySince: new Map([["r", NOW + MINUTE]]),
    })
    expect(feed.running[0]!.elapsedMs).toBe(0)
  })
})

describe("updateBusySince", () => {
  test("records the first time a session is seen busy and keeps it stable", () => {
    const first = updateBusySince(new Map(), [{ sessionId: "a", busy: true }], NOW)
    expect(first.get("a")).toBe(NOW)
    const later = updateBusySince(first, [{ sessionId: "a", busy: true }], NOW + MINUTE)
    expect(later.get("a")).toBe(NOW)
    // Nothing changed, so the caller can skip the commit.
    expect(later).toBe(first)
  })

  test("forgets a session when it stops — the next run is a new run", () => {
    const started = updateBusySince(new Map(), [{ sessionId: "a", busy: true }], NOW)
    const stopped = updateBusySince(started, [{ sessionId: "a", busy: false }], NOW + MINUTE)
    expect(stopped.has("a")).toBe(false)
    const restarted = updateBusySince(stopped, [{ sessionId: "a", busy: true }], NOW + 2 * MINUTE)
    expect(restarted.get("a")).toBe(NOW + 2 * MINUTE)
  })

  test("returns the same map when nothing moved", () => {
    const start = updateBusySince(new Map(), [{ sessionId: "a", busy: false }], NOW)
    expect(start.size).toBe(0)
    expect(updateBusySince(start, [], NOW)).toBe(start)
  })

  test("sessions absent from the batch keep their bookkeeping", () => {
    const both = updateBusySince(
      new Map(),
      [
        { sessionId: "a", busy: true },
        { sessionId: "b", busy: true },
      ],
      NOW,
    )
    const next = updateBusySince(both, [{ sessionId: "a", busy: false }], NOW + MINUTE)
    expect(next.has("a")).toBe(false)
    expect(next.get("b")).toBe(NOW)
  })
})

describe("homeGoalCandidates", () => {
  test("asks only about idle sessions inside the settled window", () => {
    const candidates = homeGoalCandidates(
      repos,
      rowsFor({
        app: [
          row("busy", { busy: true }),
          row("idle"),
          row("ancient", { lastActivity: NOW - RECENT_SETTLED_MS - MINUTE }),
        ],
      }),
      { now: NOW },
    )
    expect(candidates).toEqual([{ repoId: "app", sessionId: "idle" }])
  })

  test("caps how many sessions each repository contributes", () => {
    const list = Array.from({ length: 20 }, (_, i) => row(`s${i}`))
    const candidates = homeGoalCandidates(repos, rowsFor({ app: list }), {
      now: NOW,
      perRepoLimit: 3,
    })
    expect(candidates.map((c) => c.sessionId)).toEqual(["s0", "s1", "s2"])
  })

  test("a duplicate row does not spend the next repository's budget", () => {
    const list = Array.from({ length: 20 }, (_, i) => row(`s${i}`))
    const candidates = homeGoalCandidates(repos, rowsFor({ app: list, core: list }), {
      now: NOW,
      perRepoLimit: 3,
    })
    // Each repository still gets three FRESH candidates: rows already claimed
    // by an earlier repo are skipped without consuming the later repo's cap.
    expect(candidates.map((c) => c.sessionId)).toEqual(["s0", "s1", "s2", "s3", "s4", "s5"])
    expect(candidates.filter((c) => c.repoId === "core").map((c) => c.sessionId)).toEqual([
      "s3",
      "s4",
      "s5",
    ])
  })

  test("covers every repository, not just the first", () => {
    const candidates = homeGoalCandidates(
      repos,
      rowsFor({ app: [row("a")], core: [row("b")], zoo: [row("c")] }),
      { now: NOW },
    )
    expect(candidates).toEqual([
      { repoId: "app", sessionId: "a" },
      { repoId: "core", sessionId: "b" },
      { repoId: "zoo", sessionId: "c" },
    ])
  })
})

describe("homeFeedCounts", () => {
  test("counts sections and the distinct repositories represented", () => {
    const feed = buildHomeFeed(
      repos,
      rowsFor({
        app: [row("r", { busy: true }), row("s")],
        core: [row("b")],
      }),
      { now: NOW, goals: new Map([["b", goal("blocked")]]) },
    )
    expect(homeFeedCounts(feed)).toEqual({ needsYou: 1, running: 1, repos: 2 })
  })
})
