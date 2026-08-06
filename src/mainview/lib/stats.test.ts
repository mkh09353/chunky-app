import { describe, expect, test } from "bun:test"
import { asScoreboard, kindLabel } from "./stats"

describe("kindLabel", () => {
  test("named seat qualifies the kind", () => {
    expect(kindLabel({ kind: "sidekick", seat: "websearch" })).toBe("sidekick · websearch")
  })
  test("null or absent seat stays plain", () => {
    expect(kindLabel({ kind: "sidekick", seat: null })).toBe("sidekick")
    expect(kindLabel({ kind: "review" })).toBe("review")
  })
})

describe("asScoreboard", () => {
  test("tolerates rows without a seat field (older servers)", () => {
    const body = asScoreboard({ rows: [{ provider: "zen", model: "m", effort: null, kind: "sidekick", samples: 1, avgRating: 9, ratedCount: 1, reworkRate: 0, totalCost: null, totalTokens: 0, ratingPerDollar: null }] })
    expect(body.rows).toHaveLength(1)
    expect(kindLabel(body.rows[0]!)).toBe("sidekick")
  })
})
