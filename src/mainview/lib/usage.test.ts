import { describe, expect, test } from "bun:test"
import {
  asProviderQuotas,
  asUsageBreakdown,
  asUsageSeries,
  kindLabel,
  scoreLabel,
  shareLabel,
  type ProviderQuota,
  type ProviderQuotaWindow,
  type UsageProviderRollup,
} from "./stats"
import {
  axisScale,
  bucketAtX,
  chartData,
  chartProviderKeys,
  isSubscription,
  mergeProviderCards,
  orderProviders,
  quotaBarPercent,
  quotaHasMeters,
  quotaPercentLabel,
  quotaResetLabel,
  quotaTone,
  quotaWindowLabel,
  rangeFor,
  stackedPaths,
  tickIndexes,
  usageStrip,
  type ChartDims,
} from "./usage"

const bucket = (over: Partial<ReturnType<typeof baseBucket>> = {}) => ({ ...baseBucket(), ...over })
function baseBucket() {
  return {
    date: "2026-08-01",
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    estimatedApiCost: 0,
    unpricedRequests: 0,
    byProvider: [] as { provider: string; billing: string | null; estimatedApiCost: number; tokens: number }[],
  }
}

describe("rangeFor", () => {
  test("N days is inclusive of today", () => {
    const now = new Date(2026, 7, 8, 12).getTime()
    expect(rangeFor(7, now)).toEqual({ from: "2026-08-02", to: "2026-08-08" })
    expect(rangeFor(1, now)).toEqual({ from: "2026-08-08", to: "2026-08-08" })
  })
  test("crosses month and year boundaries", () => {
    expect(rangeFor(30, new Date(2026, 0, 5).getTime()).from).toBe("2025-12-07")
  })
})

describe("asUsageSeries", () => {
  test("404-shaped junk yields an empty, renderable payload", () => {
    expect(asUsageSeries(null).buckets).toEqual([])
    expect(asUsageSeries({ buckets: "nope" }).buckets).toEqual([])
    expect(asUsageSeries(undefined).bucket).toBe("day")
  })
  test("coerces missing fields and drops undated buckets", () => {
    const body = asUsageSeries({
      from: "2026-08-01",
      to: "2026-08-02",
      buckets: [
        { date: "2026-08-02", estimatedApiCost: "1.5", byProvider: [{ provider: "zen", tokens: 10 }] },
        { requests: 4 },
        { date: "2026-08-01" },
      ],
    })
    // Sorted ascending, undated dropped, strings coerced, defaults filled.
    expect(body.buckets.map((b) => b.date)).toEqual(["2026-08-01", "2026-08-02"])
    expect(body.buckets[1]!.estimatedApiCost).toBe(1.5)
    expect(body.buckets[1]!.inputTokens).toBe(0)
    expect(body.buckets[1]!.byProvider[0]).toEqual({
      provider: "zen",
      billing: null,
      estimatedApiCost: 0,
      tokens: 10,
    })
  })
})

describe("asUsageBreakdown", () => {
  test("sorts rows by cost desc and defaults totals", () => {
    const body = asUsageBreakdown({
      rows: [
        { provider: "a", model: "cheap", estimatedApiCost: 1 },
        { provider: "b", model: "dear", estimatedApiCost: 9 },
        { junk: true },
      ],
    })
    expect(body.rows.map((r) => r.model)).toEqual(["dear", "cheap"])
    expect(body.totals).toEqual({
      estimatedApiCost: 0,
      totalTokens: 0,
      pricedShare: 0,
      cacheSavings: 0,
    })
    expect(body.providers).toEqual([])
  })
  test("infers priced from cost when the server omits it", () => {
    const body = asUsageBreakdown({ rows: [{ provider: "a", model: "m", estimatedApiCost: 2 }] })
    expect(body.rows[0]!.priced).toBe(true)
  })
  test("keeps scoreBySeat in server order and coerces its fields", () => {
    const body = asUsageBreakdown({
      rows: [
        {
          provider: "a",
          model: "m",
          scoreBySeat: [
            {
              kind: "sidekick",
              seat: null,
              avgRating: 9.46,
              ratedCount: 198,
              reworkRate: 0.05,
              samples: 200,
            },
            { kind: "sidekick", seat: "websearch", avgRating: "8", ratedCount: "3" },
            { kind: "thread", avgRating: null, junk: true },
          ],
        },
      ],
    })
    const scores = body.rows[0]!.scoreBySeat!
    expect(scores.map((s) => kindLabel(s))).toEqual([
      "sidekick",
      "sidekick · websearch",
      "thread",
    ])
    expect(scores.map((s) => scoreLabel(s))).toEqual(["9.5 (198)", "8.0 (3)", "—"])
    expect(scores[1]).toEqual({
      kind: "sidekick",
      seat: "websearch",
      avgRating: 8,
      ratedCount: 3,
      reworkRate: null,
      samples: 0,
    })
  })
  test("missing or malformed scoreBySeat leaves it undefined", () => {
    const rows = asUsageBreakdown({
      rows: [
        { provider: "a", model: "none" },
        { provider: "a", model: "empty", scoreBySeat: [] },
        { provider: "a", model: "junk", scoreBySeat: [{ seat: "x" }, null, 7, "nope"] },
        { provider: "a", model: "notarray", scoreBySeat: { kind: "sidekick" } },
      ],
    }).rows
    for (const row of rows) expect(row.scoreBySeat).toBeUndefined()
  })
})

describe("providers", () => {
  test("subscription providers lead, then cost desc", () => {
    const order = orderProviders([
      { provider: "api", billing: "usage", estimatedApiCost: 10, tokens: 1, share: 1 },
      { provider: "sub", billing: "subscription", estimatedApiCost: 1, tokens: 1, share: 0 },
    ]).map((p) => p.provider)
    expect(order).toEqual(["sub", "api"])
    expect(isSubscription(null)).toBe(false)
  })
  test("chart keys fall back to providers only the series mentions", () => {
    const keys = chartProviderKeys(
      [{ provider: "zen", billing: null, estimatedApiCost: 1, tokens: 1, share: 1 }],
      [bucket({ byProvider: [{ provider: "grok", billing: null, estimatedApiCost: 1, tokens: 2 }] })],
    )
    expect(keys).toEqual(["zen", "grok"])
  })
})

describe("chartData", () => {
  test("stacks per provider and reports all-zero", () => {
    const data = chartData(
      [
        bucket({
          date: "2026-08-01",
          estimatedApiCost: 3,
          byProvider: [
            { provider: "a", billing: null, estimatedApiCost: 1, tokens: 5 },
            { provider: "b", billing: null, estimatedApiCost: 2, tokens: 7 },
          ],
        }),
      ],
      ["a", "b"],
      "cost",
    )
    expect(data.points[0]!.values).toEqual([1, 2])
    expect(data.max).toBe(3)
    expect(data.allZero).toBe(false)
    expect(chartData([bucket()], ["a"], "cost").allZero).toBe(true)
  })
  test("a bucket total larger than its provider slices keeps the total", () => {
    const data = chartData(
      [bucket({ estimatedApiCost: 5, byProvider: [{ provider: "a", billing: null, estimatedApiCost: 2, tokens: 0 }] })],
      ["a"],
      "cost",
    )
    expect(data.points[0]!.total).toBe(5)
    expect(data.points[0]!.values[0]).toBe(5)
  })
})

const DIMS: ChartDims = { width: 300, height: 100, padLeft: 40, padRight: 10, padTop: 10, padBottom: 20 }

describe("chart geometry", () => {
  test("axis scale gives round ticks and survives zero", () => {
    expect(axisScale(0)).toEqual({ top: 1, values: [0, 1] })
    const scale = axisScale(3.7)
    expect(scale.top).toBe(4)
    expect(scale.values[0]).toBe(0)
    expect(scale.values.at(-1)).toBe(4)
  })
  test("stacked paths are produced per key and never NaN", () => {
    const { points } = chartData(
      [
        bucket({ date: "2026-08-01", estimatedApiCost: 1, byProvider: [{ provider: "a", billing: null, estimatedApiCost: 1, tokens: 0 }] }),
        bucket({ date: "2026-08-02", estimatedApiCost: 2, byProvider: [{ provider: "a", billing: null, estimatedApiCost: 2, tokens: 0 }] }),
      ],
      ["a"],
      "cost",
    )
    const paths = stackedPaths(points, 1, 2, DIMS)
    expect(paths.areas).toHaveLength(1)
    expect(paths.areas[0]).not.toContain("NaN")
    expect(stackedPaths([], 1, 1, DIMS).areas).toEqual([])
  })
  test("bucketAtX snaps anywhere in the box to the nearest bucket", () => {
    expect(bucketAtX(40, 3, DIMS)).toBe(0)
    expect(bucketAtX(290, 3, DIMS)).toBe(2)
    // The axis gutter and the right margin snap to the ends rather than going
    // dead — the newest day sits 10px from the edge.
    expect(bucketAtX(0, 3, DIMS)).toBe(0)
    expect(bucketAtX(299, 3, DIMS)).toBe(2)
    expect(bucketAtX(5, 1, DIMS)).toBe(0)
    // Outside the box entirely: nothing.
    expect(bucketAtX(-4, 3, DIMS)).toBe(null)
    expect(bucketAtX(420, 3, DIMS)).toBe(null)
    expect(bucketAtX(10, 0, DIMS)).toBe(null)
  })
  test("tick indexes always include both ends", () => {
    expect(tickIndexes(3)).toEqual([0, 1, 2])
    const ticks = tickIndexes(90)
    expect(ticks[0]).toBe(0)
    expect(ticks.at(-1)).toBe(89)
  })
})

describe("usageStrip", () => {
  test("rolls up processed tokens, active days and cache share", () => {
    const strip = usageStrip([
      bucket({ date: "2026-08-01", requests: 2, inputTokens: 100, outputTokens: 50, reasoningTokens: 10, cacheReadTokens: 300 }),
      bucket({ date: "2026-08-02" }),
    ])
    expect(strip.processedTokens).toBe(160)
    expect(strip.activeDays).toBe(1)
    expect(strip.perActiveDay).toBe(160)
    expect(strip.observedInput).toBe(400)
    expect(strip.cachedShare).toBeCloseTo(0.75)
  })
  test("an empty range divides by nothing", () => {
    const strip = usageStrip([])
    expect(strip.perActiveDay).toBe(0)
    expect(strip.cachedShare).toBe(0)
  })
})

describe("labels", () => {
  test("score reads as average plus sample count, em-dash when unrated", () => {
    expect(scoreLabel({ avgRating: 8.42, ratedCount: 12 })).toBe("8.4 (12)")
    expect(scoreLabel({ avgRating: null, ratedCount: 0 })).toBe("—")
    expect(scoreLabel({ avgRating: 9, ratedCount: 0 })).toBe("—")
  })
  test("share tolerates both rates and percentages", () => {
    expect(shareLabel(0.5)).toBe("50%")
    expect(shareLabel(42)).toBe("42%")
    expect(shareLabel(0.0002)).toBe("<0.1%")
    expect(shareLabel(null)).toBe("—")
  })
})

/* --- subscription quota meters ------------------------------------------- */

const quotaWindow = (over: Partial<ProviderQuotaWindow> = {}): ProviderQuotaWindow => ({
  kind: "five-hour",
  label: "5 hour",
  usedPercent: 10,
  resetAt: null,
  ...over,
})
const quotaRow = (over: Partial<ProviderQuota> = {}): ProviderQuota => ({
  provider: "codex",
  billing: "subscription",
  status: "available",
  source: "codex-usage",
  fetchedAt: 1,
  windows: [quotaWindow()],
  ...over,
})

describe("asProviderQuotas", () => {
  test("a 404-shaped or junk body yields nothing to render", () => {
    expect(asProviderQuotas(null).providers).toEqual([])
    expect(asProviderQuotas({ providers: "nope" }).providers).toEqual([])
    expect(asProviderQuotas(undefined).fetchedAt).toBe(0)
  })
  test("drops rows without a provider and windows with no identity", () => {
    const body = asProviderQuotas({
      fetchedAt: 5,
      providers: [
        { status: "available" },
        { provider: "codex", windows: [{ kind: "other" }, { kind: "five-hour", label: "5h" }] },
      ],
    })
    expect(body.providers).toHaveLength(1)
    expect(body.providers[0]!.windows).toHaveLength(1)
    expect(body.providers[0]!.windows[0]!.kind).toBe("five-hour")
  })
  test("clamps percentages into 0-100 and rejects impossible resets", () => {
    const body = asProviderQuotas({
      providers: [
        { provider: "a", status: "available", windows: [
          { kind: "weekly", label: "w", usedPercent: 143, resetAt: 0 },
          { kind: "five-hour", label: "5h", usedPercent: -8, resetAt: 1000 },
          { kind: "weekly", label: "w2", usedPercent: "62.5", resetAt: "2000" },
          { kind: "weekly", label: "w3", usedPercent: "not a number" },
        ] },
      ],
    })
    const w = body.providers[0]!.windows
    expect(w.map((x) => x.usedPercent)).toEqual([100, 0, 62.5, null])
    expect(w[0]!.resetAt).toBe(null)
    expect(w[2]!.resetAt).toBe(2000)
  })
  test("unknown status/billing/source degrade instead of leaking through", () => {
    const body = asProviderQuotas({
      providers: [
        { provider: "a", status: "weird", billing: "invoice", source: "mystery", windows: [{ kind: "weekly", label: "w" }] },
        { provider: "b", status: "weird", windows: [] },
      ],
    })
    expect(body.providers[0]!.status).toBe("available")
    expect(body.providers[0]!.billing).toBe(null)
    expect(body.providers[0]!.source).toBe(null)
    // Nothing to show and no usable status: not something we claim works.
    expect(body.providers[1]!.status).toBe("unsupported")
  })
})

describe("quota labels and tone", () => {
  test("window labels are short, and per-model caps name the model", () => {
    expect(quotaWindowLabel(quotaWindow({ kind: "five-hour" }))).toBe("5h")
    expect(quotaWindowLabel(quotaWindow({ kind: "weekly" }))).toBe("Week")
    expect(quotaWindowLabel(quotaWindow({ kind: "weekly-model", model: "gpt-5-codex" }))).toBe("gpt-5-codex")
    expect(quotaWindowLabel(quotaWindow({ kind: "weekly-model", model: undefined, label: "Weekly (Opus)" }))).toBe("Weekly (Opus)")
    expect(quotaWindowLabel(quotaWindow({ kind: "other", label: "" }))).toBe("Window")
  })
  test("tone only escalates past 75% and 90%", () => {
    expect(quotaTone(0)).toBe("calm")
    expect(quotaTone(75)).toBe("calm")
    expect(quotaTone(75.1)).toBe("warn")
    expect(quotaTone(90)).toBe("warn")
    expect(quotaTone(92)).toBe("danger")
    expect(quotaTone(null)).toBe("calm")
  })
  test("bar width and percent text never invent a level", () => {
    expect(quotaBarPercent(null)).toBe(0)
    expect(quotaBarPercent(140)).toBe(100)
    expect(quotaBarPercent(-3)).toBe(0)
    expect(quotaPercentLabel(null)).toBe("—")
    expect(quotaPercentLabel(62.4)).toBe("62%")
  })
})

describe("quotaResetLabel", () => {
  const now = 1_000_000_000_000
  test("formats hours, minutes and days", () => {
    expect(quotaResetLabel(now + 4 * 3600_000 + 12 * 60_000, now)).toBe("resets in 4h 12m")
    expect(quotaResetLabel(now + 8 * 60_000, now)).toBe("resets in 8m")
    expect(quotaResetLabel(now + 26 * 3600_000, now)).toBe("resets in 1d 2h")
    expect(quotaResetLabel(now + 3600_000 + 60_000 * 5, now)).toBe("resets in 1h 05m")
  })
  test("past, imminent and absent resets never show a negative countdown", () => {
    expect(quotaResetLabel(now - 5000, now)).toBe("resetting now")
    expect(quotaResetLabel(now + 30_000, now)).toBe("resetting now")
    expect(quotaResetLabel(null, now)).toBe(null)
    expect(quotaResetLabel(Number.NaN, now)).toBe(null)
  })
})

describe("quotaHasMeters", () => {
  test("only available/stale rows with windows draw bars", () => {
    expect(quotaHasMeters(quotaRow())).toBe(true)
    expect(quotaHasMeters(quotaRow({ status: "stale" }))).toBe(true)
    expect(quotaHasMeters(quotaRow({ status: "error" }))).toBe(false)
    expect(quotaHasMeters(quotaRow({ windows: [] }))).toBe(false)
    expect(quotaHasMeters(null)).toBe(false)
  })
})

describe("mergeProviderCards", () => {
  const rollup = (provider: string, billing: string | null, cost: number): UsageProviderRollup => ({
    provider, billing, estimatedApiCost: cost, tokens: 1, share: 0.5,
  })
  test("spending providers keep rollup order and pick up their quota", () => {
    const { spending, quotaOnly } = mergeProviderCards(
      [rollup("zen", "usage", 10), rollup("codex", "subscription", 1)],
      [quotaRow({ provider: "codex" })],
    )
    // Subscription first (orderProviders), each carrying its own quota row.
    expect(spending.map((c) => c.provider)).toEqual(["codex", "zen"])
    expect(spending[0]!.quota?.provider).toBe("codex")
    expect(spending[1]!.quota).toBe(null)
    expect(quotaOnly).toEqual([])
  })
  test("subscriptions with no spend become quota-only cards at the end", () => {
    const { spending, quotaOnly } = mergeProviderCards(
      [rollup("zen", "usage", 10)],
      [quotaRow({ provider: "anthropic" }), quotaRow({ provider: "codex", status: "not-authenticated", windows: [] })],
    )
    expect(spending.map((c) => c.provider)).toEqual(["zen"])
    expect(quotaOnly.map((c) => c.provider)).toEqual(["anthropic", "codex"])
    expect(quotaOnly[0]!.rollup).toBe(null)
  })
  test("api-key providers with no spend are not promoted, and silence is not a card", () => {
    const { quotaOnly } = mergeProviderCards(
      [],
      [
        quotaRow({ provider: "openai", billing: "api-key" }),
        quotaRow({ provider: "quiet", windows: [], status: "unsupported" }),
      ],
    )
    expect(quotaOnly).toEqual([])
  })
  test("a duplicated provider row is used once", () => {
    const { spending } = mergeProviderCards(
      [rollup("codex", "subscription", 1)],
      [quotaRow({ provider: "codex", status: "available" }), quotaRow({ provider: "codex", status: "error" })],
    )
    expect(spending).toHaveLength(1)
    expect(spending[0]!.quota?.status).toBe("available")
  })
})
