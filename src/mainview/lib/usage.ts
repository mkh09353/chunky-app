// Derived arithmetic and chart geometry for the full-page Usage view.
//
// Everything here is pure: the view owns fetching and rendering, this file owns
// "what does the payload mean" and "where does the pixel go". That split is
// what makes the chart testable without a DOM — the SVG is hand-rolled (no
// chart dependency), so the scales and paths are ordinary functions.
//
// Wire shapes come from lib/stats.ts (see the GAP note there); this file
// assumes they have already been through the defensive parsers, so it can trust
// the fields to be finite numbers.
import type { UsageProviderRollup, UsageSeriesBucket } from "./stats"

/** Range presets offered by the header toggle. */
export const USAGE_RANGES = [7, 30, 90] as const
export type UsageRangeDays = (typeof USAGE_RANGES)[number]

/** Local-calendar YYYY-MM-DD (the server buckets by local day, not UTC). */
export function isoDay(d: Date): string {
  const year = d.getFullYear()
  const month = String(d.getMonth() + 1).padStart(2, "0")
  const day = String(d.getDate()).padStart(2, "0")
  return `${year}-${month}-${day}`
}

/** The inclusive [from, to] window a range toggle asks for: today back N-1 days. */
export function rangeFor(days: number, now: number): { from: string; to: string } {
  const to = new Date(now)
  const from = new Date(now)
  from.setDate(from.getDate() - (Math.max(1, days) - 1))
  return { from: isoDay(from), to: isoDay(to) }
}

/** "Aug 8" for an axis tick or tooltip heading; the raw string if unparseable. */
export function dayLabel(iso: string): string {
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  if (!parts) return iso
  const date = new Date(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]))
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" })
}

/** "Jul 10 – Aug 8" under the page title. */
export function rangeSubtitle(from: string, to: string): string {
  if (!from || !to) return ""
  return `${dayLabel(from)} – ${dayLabel(to)}`
}

/** Subscription-billed providers lead the provider list: they are the ones
 *  whose "cost" is a counterfactual rather than an invoice. */
export function isSubscription(billing: string | null): boolean {
  if (!billing) return false
  const b = billing.toLowerCase()
  return b === "subscription" || b === "included" || b === "plan" || b === "free"
}

/** Subscription first, then cost desc, then tokens desc, then name. */
export function orderProviders(providers: readonly UsageProviderRollup[]): UsageProviderRollup[] {
  return [...providers].sort((a, b) => {
    const subs = Number(isSubscription(b.billing)) - Number(isSubscription(a.billing))
    if (subs !== 0) return subs
    if (b.estimatedApiCost !== a.estimatedApiCost) return b.estimatedApiCost - a.estimatedApiCost
    if (b.tokens !== a.tokens) return b.tokens - a.tokens
    return a.provider.localeCompare(b.provider)
  })
}

/** Provider keys for the chart, in the same order the cards use. Falls back to
 *  whatever the series itself mentions when the rollup is empty (or when the
 *  two endpoints disagree — series is authoritative for the chart). */
export function chartProviderKeys(
  providers: readonly UsageProviderRollup[],
  buckets: readonly UsageSeriesBucket[],
): string[] {
  const seen = new Set<string>()
  const keys: string[] = []
  for (const p of orderProviders(providers)) {
    if (p.provider && !seen.has(p.provider)) {
      seen.add(p.provider)
      keys.push(p.provider)
    }
  }
  for (const bucket of buckets) {
    for (const slice of bucket.byProvider) {
      if (slice.provider && !seen.has(slice.provider)) {
        seen.add(slice.provider)
        keys.push(slice.provider)
      }
    }
  }
  return keys
}

export type UsageMetric = "cost" | "tokens"

export interface ChartPoint {
  date: string
  /** Per-provider value, parallel to the `keys` passed in. */
  values: number[]
  total: number
}

export interface ChartData {
  points: ChartPoint[]
  /** Largest daily total; 0 when every bucket is empty. */
  max: number
  /** True when nothing was recorded anywhere in the window. */
  allZero: boolean
}

/** Per-day, per-provider values for the selected metric. Providers present in a
 *  bucket but not in `keys` are folded into the last key if there is one, so
 *  the stack total always equals the day's total. */
export function chartData(
  buckets: readonly UsageSeriesBucket[],
  keys: readonly string[],
  metric: UsageMetric,
): ChartData {
  const index = new Map(keys.map((key, i) => [key, i]))
  const points = buckets.map((bucket) => {
    const values = new Array<number>(keys.length).fill(0)
    let total = 0
    for (const slice of bucket.byProvider) {
      const value = metric === "cost" ? slice.estimatedApiCost : slice.tokens
      if (!(value > 0)) continue
      const at = index.get(slice.provider)
      if (at == null) {
        if (values.length > 0) values[values.length - 1]! += value
      } else {
        values[at]! += value
      }
      total += value
    }
    // Bucket totals are authoritative when byProvider is missing/partial.
    const declared =
      metric === "cost"
        ? bucket.estimatedApiCost
        : bucket.inputTokens +
          bucket.outputTokens +
          bucket.reasoningTokens +
          bucket.cacheReadTokens +
          bucket.cacheWriteTokens
    if (declared > total) {
      const remainder = declared - total
      if (values.length > 0) values[values.length - 1]! += remainder
      total = declared
    }
    return { date: bucket.date, values, total }
  })
  const max = points.reduce((acc, p) => Math.max(acc, p.total), 0)
  return { points, max, allZero: max <= 0 }
}

/** A round-ish upper bound plus its tick values, so the y-axis reads cleanly
 *  ("$0 / $2 / $4" rather than "$0 / $1.87 / $3.74"). */
export function axisScale(max: number, ticks = 4): { top: number; values: number[] } {
  if (!(max > 0)) return { top: 1, values: [0, 1] }
  const step = niceStep(max / Math.max(1, ticks))
  const top = Math.ceil(max / step) * step
  const values: number[] = []
  for (let v = 0; v <= top + step / 2; v += step) values.push(Number(v.toPrecision(12)))
  return { top, values }
}

/** 1, 2, 5 × 10^n — the classic human-readable step ladder. */
function niceStep(raw: number): number {
  if (!(raw > 0)) return 1
  const magnitude = 10 ** Math.floor(Math.log10(raw))
  const normalized = raw / magnitude
  const nice = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10
  return nice * magnitude
}

export interface ChartDims {
  width: number
  height: number
  padLeft: number
  padRight: number
  padTop: number
  padBottom: number
}

/** x centre of bucket `i`. A single bucket sits in the middle of the plot. */
export function scaleX(i: number, count: number, dims: ChartDims): number {
  const plot = Math.max(1, dims.width - dims.padLeft - dims.padRight)
  if (count <= 1) return dims.padLeft + plot / 2
  return dims.padLeft + (plot * i) / (count - 1)
}

export function scaleY(value: number, top: number, dims: ChartDims): number {
  const plot = Math.max(1, dims.height - dims.padTop - dims.padBottom)
  const ratio = top > 0 ? Math.min(1, Math.max(0, value / top)) : 0
  return dims.padTop + plot * (1 - ratio)
}

export interface StackedPaths {
  /** Filled band per provider, bottom-of-stack first. */
  areas: string[]
  /** The band's upper edge, for the brighter stroke. */
  lines: string[]
}

/** Stacked bands for the area chart. Index 0 is the bottom of the stack, which
 *  is also the order `keys` (and therefore the legend) is in. */
export function stackedPaths(
  points: readonly ChartPoint[],
  keyCount: number,
  top: number,
  dims: ChartDims,
): StackedPaths {
  const areas: string[] = []
  const lines: string[] = []
  if (points.length === 0 || keyCount === 0) return { areas, lines }
  const running = new Array<number>(points.length).fill(0)
  for (let k = 0; k < keyCount; k++) {
    const lower: string[] = []
    const upper: string[] = []
    points.forEach((point, i) => {
      const x = scaleX(i, points.length, dims)
      const base = running[i]!
      const value = point.values[k] ?? 0
      lower.push(`${round(x)},${round(scaleY(base, top, dims))}`)
      upper.push(`${round(x)},${round(scaleY(base + value, top, dims))}`)
      running[i] = base + value
    })
    lines.push(`M${upper.join(" L")}`)
    areas.push(`M${upper.join(" L")} L${[...lower].reverse().join(" L")} Z`)
  }
  return { areas, lines }
}

function round(n: number): number {
  return Math.round(n * 100) / 100
}

/** Which bucket the pointer is over, given an x in SVG user units.
 *
 *  The hit zone is the whole chart box, not just the plotted span: the right
 *  margin is only a dozen pixels, so treating it as a dead zone would make the
 *  most recent day — the one people reach for — hard to hover. Anything inside
 *  the box snaps to the nearest bucket; outside it (never sent by the view,
 *  which also clears on pointer-leave) reports nothing. */
export function bucketAtX(x: number, count: number, dims: ChartDims): number | null {
  if (count <= 0) return null
  if (!(x >= 0) || x > dims.width) return null
  if (count === 1) return 0
  const plot = Math.max(1, dims.width - dims.padLeft - dims.padRight)
  const ratio = (x - dims.padLeft) / plot
  const i = Math.round(Math.min(1, Math.max(0, ratio)) * (count - 1))
  return Math.min(count - 1, Math.max(0, i))
}

/** Evenly spaced x-tick indexes (always including first and last). */
export function tickIndexes(count: number, wanted = 5): number[] {
  if (count <= 0) return []
  if (count <= wanted) return Array.from({ length: count }, (_, i) => i)
  const step = (count - 1) / (wanted - 1)
  const out = new Set<number>()
  for (let i = 0; i < wanted; i++) out.add(Math.round(i * step))
  return [...out].sort((a, b) => a - b)
}

export interface UsageStrip {
  processedTokens: number
  activeDays: number
  perActiveDay: number
  cachedInput: number
  uncachedInput: number
  observedInput: number
  /** cachedInput / observedInput, 0..1; 0 when nothing was observed. */
  cachedShare: number
  outputTokens: number
  reasoningTokens: number
  requests: number
  unpricedRequests: number
}

/** The stat strip's numbers, rolled up from the daily series. */
export function usageStrip(buckets: readonly UsageSeriesBucket[]): UsageStrip {
  const strip: UsageStrip = {
    processedTokens: 0,
    activeDays: 0,
    perActiveDay: 0,
    cachedInput: 0,
    uncachedInput: 0,
    observedInput: 0,
    cachedShare: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    requests: 0,
    unpricedRequests: 0,
  }
  for (const bucket of buckets) {
    const processed = bucket.inputTokens + bucket.outputTokens + bucket.reasoningTokens
    strip.processedTokens += processed
    strip.cachedInput += bucket.cacheReadTokens
    strip.uncachedInput += bucket.inputTokens
    strip.outputTokens += bucket.outputTokens
    strip.reasoningTokens += bucket.reasoningTokens
    strip.requests += bucket.requests
    strip.unpricedRequests += bucket.unpricedRequests
    // "Active" means the day did something, not that it cost something.
    if (bucket.requests > 0 || processed > 0 || bucket.cacheReadTokens > 0) strip.activeDays += 1
  }
  strip.observedInput = strip.cachedInput + strip.uncachedInput
  strip.cachedShare = strip.observedInput > 0 ? strip.cachedInput / strip.observedInput : 0
  strip.perActiveDay = strip.activeDays > 0 ? strip.processedTokens / strip.activeDays : 0
  return strip
}

/** Total estimated cost across the window (the hero number). */
export function seriesCost(buckets: readonly UsageSeriesBucket[]): number {
  return buckets.reduce((acc, b) => acc + b.estimatedApiCost, 0)
}
