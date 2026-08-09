import { describe, expect, test } from "bun:test"
import { asUsageBreakdown, asUsageSeries, scoreLabel, shareLabel } from "./stats"
import {
  axisScale,
  bucketAtX,
  chartData,
  chartProviderKeys,
  isSubscription,
  orderProviders,
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
