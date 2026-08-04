// The PR reviews view rules: counts behind the sidebar rows, the "waiting more
// than a day" threshold, compact ages, and card derivation. Run with:
//   bun test src/mainview/lib/prReviews.test.ts
import { describe, expect, test } from "bun:test"
import type { PrReviewsState, PrSummary } from "@chunky/protocol"
import {
  EMPTY_SUMMARY,
  WAITING_LONG_MS,
  elapsedMs,
  formatAge,
  formatFetchedAt,
  hasNewActivity,
  isWaitingLong,
  loadPrLastSeen,
  savePrLastSeen,
  sortMine,
  sortReviewQueue,
  summarize,
  toPrCard,
  type LastSeenStore,
} from "./prReviews"

/** A fixed instant, so every age assertion below is exact. */
const NOW = Date.parse("2026-03-10T12:00:00.000Z")
const ago = (ms: number) => new Date(NOW - ms).toISOString()

const HOUR = 3_600_000
const DAY = 24 * HOUR

function pr(over: Partial<PrSummary> = {}): PrSummary {
  return {
    id: over.id ?? "node1",
    number: over.number ?? 1,
    title: over.title ?? "A pull request",
    url: over.url ?? "https://github.com/acme/api-gateway/pull/1",
    repo: over.repo ?? "acme/api-gateway",
    headRef: over.headRef ?? "feature",
    author: over.author ?? "dana.k",
    isDraft: over.isDraft ?? false,
    ciStatus: over.ciStatus ?? "passing",
    reviewDecision: over.reviewDecision ?? "review_required",
    unresolvedThreads: over.unresolvedThreads ?? 0,
    labels: over.labels ?? [],
    createdAt: over.createdAt ?? ago(HOUR),
    updatedAt: over.updatedAt ?? ago(HOUR),
    ...(over.linkedSessionId ? { linkedSessionId: over.linkedSessionId } : {}),
  }
}

function state(over: Partial<PrReviewsState> = {}): PrReviewsState {
  return {
    org: over.org ?? "acme",
    configured: over.configured ?? true,
    mine: over.mine ?? [],
    reviewQueue: over.reviewQueue ?? [],
    fetchedAt: over.fetchedAt ?? NOW,
    ...(over.error ? { error: over.error } : {}),
  }
}

describe("elapsedMs", () => {
  test("measures back from the injected now", () => {
    expect(elapsedMs(ago(3 * HOUR), NOW)).toBe(3 * HOUR)
  })

  test("missing or unparseable timestamps are not a number", () => {
    expect(elapsedMs(undefined, NOW)).toBeNull()
    expect(elapsedMs("", NOW)).toBeNull()
    expect(elapsedMs("not a date", NOW)).toBeNull()
  })

  test("a clock skewed into the future reads as zero, never negative", () => {
    expect(elapsedMs(new Date(NOW + DAY).toISOString(), NOW)).toBe(0)
  })
})

describe("formatAge", () => {
  test("picks one unit and never wraps", () => {
    expect(formatAge(ago(4 * DAY), NOW)).toBe("4d")
    expect(formatAge(ago(5 * HOUR), NOW)).toBe("5h")
    expect(formatAge(ago(12 * 60_000), NOW)).toBe("12m")
    expect(formatAge(ago(30_000), NOW)).toBe("now")
  })

  test("rounds down, so 47 hours is still one day", () => {
    expect(formatAge(ago(47 * HOUR), NOW)).toBe("1d")
  })

  test("an unknown timestamp renders nothing at all", () => {
    expect(formatAge(undefined, NOW)).toBe("")
  })
})

describe("isWaitingLong", () => {
  test("the threshold is strictly more than a day", () => {
    expect(isWaitingLong(pr({ createdAt: ago(WAITING_LONG_MS) }), NOW)).toBe(false)
    expect(isWaitingLong(pr({ createdAt: ago(WAITING_LONG_MS + 1) }), NOW)).toBe(true)
  })

  test("a fresh PR is not waiting long", () => {
    expect(isWaitingLong(pr({ createdAt: ago(2 * HOUR) }), NOW)).toBe(false)
  })
})

describe("summarize", () => {
  test("no state yet is all zeroes, not a crash", () => {
    expect(summarize(null, NOW)).toEqual(EMPTY_SUMMARY)
  })

  test("counts open PRs, total unresolved comments, and failing builds", () => {
    const summary = summarize(
      state({
        mine: [
          pr({ unresolvedThreads: 5, ciStatus: "failing" }),
          pr({ unresolvedThreads: 2, ciStatus: "pending" }),
          pr({ unresolvedThreads: 1, ciStatus: "passing" }),
          pr({ unresolvedThreads: 0, ciStatus: "passing" }),
        ],
      }),
      NOW,
    )
    expect(summary.open).toBe(4)
    expect(summary.unresolved).toBe(8)
    expect(summary.ciFailing).toBe(1)
  })

  test("counts the review queue and how many have waited over a day", () => {
    const summary = summarize(
      state({
        reviewQueue: [
          pr({ createdAt: ago(4 * DAY) }),
          pr({ createdAt: ago(2 * DAY) }),
          pr({ createdAt: ago(DAY + 4 * HOUR) }),
          pr({ createdAt: ago(6 * HOUR) }),
          pr({ createdAt: ago(3 * HOUR) }),
        ],
      }),
      NOW,
    )
    expect(summary.ready).toBe(5)
    expect(summary.waitingLong).toBe(3)
  })
})

describe("sortReviewQueue", () => {
  test("oldest waiting first", () => {
    const sorted = sortReviewQueue(
      [
        pr({ number: 1, createdAt: ago(3 * HOUR) }),
        pr({ number: 2, createdAt: ago(4 * DAY) }),
        pr({ number: 3, createdAt: ago(2 * DAY) }),
      ],
      NOW,
    )
    expect(sorted.map((p) => p.number)).toEqual([2, 3, 1])
  })

  test("does not mutate the input", () => {
    const input = [pr({ number: 1, createdAt: ago(HOUR) }), pr({ number: 2, createdAt: ago(DAY) })]
    sortReviewQueue(input, NOW)
    expect(input.map((p) => p.number)).toEqual([1, 2])
  })
})

describe("sortMine", () => {
  test("unresolved comments outrank everything else", () => {
    const sorted = sortMine(
      [
        pr({ number: 1, unresolvedThreads: 0, ciStatus: "failing" }),
        pr({ number: 2, unresolvedThreads: 5 }),
        pr({ number: 3, unresolvedThreads: 1 }),
      ],
      NOW,
    )
    expect(sorted.map((p) => p.number)).toEqual([2, 3, 1])
  })

  test("with no comments either way, a failing build comes first", () => {
    const sorted = sortMine(
      [
        pr({ number: 1, unresolvedThreads: 0, ciStatus: "passing" }),
        pr({ number: 2, unresolvedThreads: 0, ciStatus: "failing" }),
      ],
      NOW,
    )
    expect(sorted.map((p) => p.number)).toEqual([2, 1])
  })

  test("otherwise most recently touched, and ties keep the server's order", () => {
    const sorted = sortMine(
      [
        pr({ number: 1, updatedAt: ago(5 * HOUR) }),
        pr({ number: 2, updatedAt: ago(HOUR) }),
        pr({ number: 3, updatedAt: ago(HOUR) }),
      ],
      NOW,
    )
    expect(sorted.map((p) => p.number)).toEqual([2, 3, 1])
  })
})

describe("toPrCard", () => {
  test("labels CI and review state with a tone the panel can paint", () => {
    const card = toPrCard(pr({ ciStatus: "failing", reviewDecision: "changes_requested" }), {
      now: NOW,
    })
    expect(card.ciLabel).toBe("CI failing")
    expect(card.ciTone).toBe("bad")
    expect(card.reviewLabel).toBe("changes requested")
    expect(card.reviewTone).toBe("bad")
  })

  test("a draft says so instead of its review decision", () => {
    const card = toPrCard(pr({ isDraft: true, reviewDecision: "approved" }), { now: NOW })
    expect(card.reviewLabel).toBe("draft")
  })

  test("Resolve Comments is offered only when there is something to resolve", () => {
    expect(toPrCard(pr({ unresolvedThreads: 3 }), { now: NOW }).showResolve).toBe(true)
    expect(toPrCard(pr({ unresolvedThreads: 3 }), { now: NOW }).unresolvedLabel).toBe(
      "3 unresolved",
    )
    const clean = toPrCard(pr({ unresolvedThreads: 0 }), { now: NOW })
    expect(clean.showResolve).toBe(false)
    expect(clean.unresolvedLabel).toBe("")
  })

  test("queue cards age from creation and turn amber past a day", () => {
    const card = toPrCard(pr({ createdAt: ago(2 * DAY), updatedAt: ago(HOUR) }), {
      now: NOW,
      queue: true,
    })
    expect(card.ageLabel).toBe("2d")
    expect(card.ageTone).toBe("warn")
  })

  test("my own cards age from the last update and stay muted", () => {
    const card = toPrCard(pr({ createdAt: ago(9 * DAY), updatedAt: ago(3 * HOUR) }), { now: NOW })
    expect(card.ageLabel).toBe("3h")
    expect(card.ageTone).toBe("muted")
  })

  test("a linked session runs only when the injected lookup says so", () => {
    const linked = pr({ linkedSessionId: "sess-1" })
    expect(toPrCard(linked, { now: NOW, isSessionBusy: () => true }).sessionRunning).toBe(true)
    expect(toPrCard(linked, { now: NOW, isSessionBusy: () => false }).sessionRunning).toBe(false)
    // No lookup, or no linked session at all, is never "running".
    expect(toPrCard(linked, { now: NOW }).sessionRunning).toBe(false)
    expect(toPrCard(pr(), { now: NOW, isSessionBusy: () => true }).sessionRunning).toBe(false)
  })

  test("repo and number are carried ready to render in mono", () => {
    const card = toPrCard(pr({ repo: "acme/web-console", number: 918 }), { now: NOW })
    expect(card.repo).toBe("acme/web-console")
    expect(card.number).toBe("#918")
  })
})

describe("formatFetchedAt", () => {
  test("reads as a sentence in the panel header", () => {
    expect(formatFetchedAt(NOW - 30_000, NOW)).toBe("updated just now")
    expect(formatFetchedAt(NOW - 2 * 60_000, NOW)).toBe("updated 2m ago")
    expect(formatFetchedAt(NOW - 3 * HOUR, NOW)).toBe("updated 3h ago")
    expect(formatFetchedAt(NOW - 2 * DAY, NOW)).toBe("updated 2d ago")
  })

  test("never fetched says so rather than pretending", () => {
    expect(formatFetchedAt(null, NOW)).toBe("not fetched yet")
  })
})

describe("hasNewActivity", () => {
  test("only a fetch newer than the last look counts", () => {
    expect(hasNewActivity(NOW, NOW - 1)).toBe(true)
    expect(hasNewActivity(NOW, NOW)).toBe(false)
    expect(hasNewActivity(NOW - 1, NOW)).toBe(false)
  })

  test("a first run marks nothing unread", () => {
    expect(hasNewActivity(NOW, null)).toBe(false)
    expect(hasNewActivity(null, NOW)).toBe(false)
  })
})

describe("last seen storage", () => {
  function fakeStore(initial: Record<string, string> = {}) {
    const data = { ...initial }
    const store: LastSeenStore = {
      getItem: (k) => data[k] ?? null,
      setItem: (k, v) => {
        data[k] = v
      },
    }
    return { store, data }
  }

  test("round-trips the timestamp", () => {
    const { store } = fakeStore()
    savePrLastSeen(1234, store)
    expect(loadPrLastSeen(store)).toBe(1234)
  })

  test("absent, corrupt, or storage-less reads are just null", () => {
    expect(loadPrLastSeen(fakeStore().store)).toBeNull()
    expect(loadPrLastSeen(fakeStore({ "chunky.prReviews.lastSeen": "nope" }).store)).toBeNull()
    expect(loadPrLastSeen(null)).toBeNull()
  })

  test("a throwing store never takes the caller down", () => {
    const hostile: LastSeenStore = {
      getItem: () => {
        throw new Error("blocked")
      },
      setItem: () => {
        throw new Error("quota")
      },
    }
    expect(loadPrLastSeen(hostile)).toBeNull()
    expect(() => savePrLastSeen(1, hostile)).not.toThrow()
  })
})
