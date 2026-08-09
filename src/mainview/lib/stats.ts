// Wire shapes + formatting for the read-only /scoreboard and /usage surfaces.
//
// GAP: @chunky/protocol does not declare the /api/scoreboard or /api/usage
// payloads (they have no ROUTES entries either) — the TUI carries its own copy
// in ../chunky/packages/tui/src/stats.ts, which is the source of truth these
// types mirror field-for-field. Move both to the protocol package and this file
// becomes a re-export.
export interface ScoreboardRow {
  provider: string
  model: string
  effort: string | null
  kind: string
  /** Named sidekick seat (e.g. "websearch"); null/absent for the default seat and older servers. */
  seat?: string | null
  samples: number
  avgRating: number | null
  ratedCount: number
  reworkRate: number | null
  totalCost: number | null
  totalTokens: number
  ratingPerDollar: number | null
}

export interface ScoreboardResponse {
  rows: ScoreboardRow[]
}

export type UsageRole = "lead" | "sidekick" | "advisor" | "child"

export interface UsageRoleRow {
  role: UsageRole
  provider: string
  model: string
  effort: string | null
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  cost: number | null
  requests: number
}

export interface UsageResponse {
  roles: UsageRoleRow[]
  totals: {
    inputTokens: number
    outputTokens: number
    cost: number | null
  }
}

/**
 * GAP (same as above): /api/usage/series and /api/usage/breakdown are the
 * history + rollup endpoints the full-page Usage view renders from. These types
 * are the renderer's copy of the agreed contract, verbatim.
 *
 * The sibling protocol checkout has since grown the same declarations
 * (ROUTES.usageSeries / ROUTES.usageBreakdown and UsageSeriesResponse /
 * UsageBreakdownResponse in packages/protocol/src/index.ts), but that work is
 * not landed yet. Keeping the local copies means this build does not hard-fail
 * against an older protocol — a server without the routes degrades to the
 * "unsupported" state instead. Once the protocol change ships, delete the
 * interfaces below and re-export (the parsers below stay: types are not
 * validation).
 *
 * Old servers answer 404 — every consumer must degrade to the "server does not
 * support usage history" state rather than treating it as an error.
 */
export interface UsageSeriesBucket {
  date: string
  requests: number
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  estimatedApiCost: number
  unpricedRequests: number
  byProvider: { provider: string; billing: string | null; estimatedApiCost: number; tokens: number }[]
}

export interface UsageSeriesResponse {
  from: string
  to: string
  bucket: "day"
  buckets: UsageSeriesBucket[]
}

export interface UsageModelRow {
  provider: string
  model: string
  billing: string | null
  requests: number
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  estimatedApiCost: number
  priced: boolean
  avgRating: number | null
  ratedCount: number
  reworkRate: number | null
}

export interface UsageProviderRollup {
  provider: string
  billing: string | null
  estimatedApiCost: number
  tokens: number
  share: number
}

export interface UsageBreakdownResponse {
  rows: UsageModelRow[]
  totals: {
    estimatedApiCost: number
    totalTokens: number
    pricedShare: number
    cacheSavings: number
  }
  providers: UsageProviderRollup[]
}

/**
 * GAP (same story again): GET /api/provider-quotas reports how much of each
 * subscription window a provider has burned. The sibling protocol checkout has
 * `ROUTES.providerQuotas` and these interfaces in its working tree, but the
 * commit release CI pins does NOT (verified: zero matches at the pinned rev),
 * so importing them would break the release typecheck. Local copies until that
 * lands — then delete these and re-export, keeping the parser.
 *
 * A server without the route 404s; the Usage page hides the whole section.
 */
export type ProviderQuotaStatus =
  | "available"
  | "stale"
  | "not-authenticated"
  | "unsupported"
  | "error"
export type ProviderQuotaWindowKind = "five-hour" | "weekly" | "weekly-model" | "other"

export interface ProviderQuotaWindow {
  kind: ProviderQuotaWindowKind
  label: string
  /** 0..100. Null when the provider reports a window but not a level. */
  usedPercent: number | null
  /** Epoch ms when the window rolls over; null when the provider won't say. */
  resetAt: number | null
  windowMinutes?: number
  model?: string
}

export interface ProviderQuota {
  provider: string
  billing: "subscription" | "api-key" | null
  status: ProviderQuotaStatus
  source: "codex-usage" | "response-headers" | "anthropic-sdk" | null
  fetchedAt: number | null
  windows: ProviderQuotaWindow[]
  error?: string
}

export interface ProviderQuotasResponse {
  fetchedAt: number
  providers: ProviderQuota[]
}

/** Compact token count: 1234 → "1.2k", 1_500_000 → "1.5M" (TUI parity). */
export function compactTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0"
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`
  if (n >= 10_000) return `${Math.round(n / 1000)}k`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(Math.round(n))
}

/** provider/model@effort — the identity every stats row is keyed by. */
export function modelLabel(row: { provider: string; model: string; effort: string | null }): string {
  return `${row.provider}/${row.model}${row.effort ? `@${row.effort}` : ""}`
}

/** "sidekick · websearch" for named seats; plain kind otherwise. */
export function kindLabel(row: { kind: string; seat?: string | null }): string {
  return row.seat ? `${row.kind} · ${row.seat}` : row.kind
}

export const money = (v: number | null): string => (v == null ? "—" : `$${v.toFixed(2)}`)
export const rating = (v: number | null): string => (v == null ? "—" : v.toFixed(1))
/** The contract sends a rate (0..1); tolerate a server that already scaled it. */
export const percent = (v: number | null): string =>
  v == null ? "—" : `${Math.round(v > 1 ? v : v * 100)}%`

/** avgRating desc, nulls last; ties broken by sample count so the busier row wins. */
export function sortScoreboard(rows: ScoreboardRow[]): ScoreboardRow[] {
  return [...rows].sort((a, b) => {
    if (a.avgRating == null && b.avgRating == null) return b.samples - a.samples
    if (a.avgRating == null) return 1
    if (b.avgRating == null) return -1
    if (b.avgRating !== a.avgRating) return b.avgRating - a.avgRating
    return b.samples - a.samples
  })
}

/** One-line roll-up under the usage table. */
export function usageTotalsLine(totals: UsageResponse["totals"]): string {
  return `Total: ${compactTokens(totals.inputTokens)} in · ${compactTokens(totals.outputTokens)} out · ${money(totals.cost)}`
}

/** Defensive parsers — these endpoints are untyped on the wire (see GAP above). */
export function asScoreboard(data: unknown): ScoreboardResponse {
  const rows = (data as { rows?: unknown })?.rows
  return { rows: Array.isArray(rows) ? (rows as ScoreboardRow[]) : [] }
}

export function asUsage(data: unknown): UsageResponse {
  const body = (data ?? {}) as Partial<UsageResponse>
  return {
    roles: Array.isArray(body.roles) ? body.roles : [],
    totals: body.totals ?? { inputTokens: 0, outputTokens: 0, cost: null },
  }
}

/* ---------------------------------------------------------------------------
 * Series / breakdown parsers.
 *
 * These read a payload the renderer cannot typecheck at build time (untyped
 * wire, and a server that may be older or newer than this build). Every field
 * is coerced: a missing number becomes 0, a missing array becomes [], a
 * non-finite becomes 0/null. The page must render *something* for any body the
 * server can produce, and must never throw on one.
 * ------------------------------------------------------------------------- */

/** Finite number or `fallback` — strings are tolerated (JSON from loose servers). */
function num(v: unknown, fallback = 0): number {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : Number.NaN
  return Number.isFinite(n) ? n : fallback
}

/** Finite number or null — for the genuinely-nullable fields (ratings, rates). */
function numOrNull(v: unknown): number | null {
  if (v == null) return null
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : Number.NaN
  return Number.isFinite(n) ? n : null
}

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback
}

function strOrNull(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null
}

function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : []
}

/** ISO date (YYYY-MM-DD) as sent; anything else is dropped by the caller. */
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function asProviderSlice(data: unknown): UsageSeriesBucket["byProvider"][number] | null {
  const row = (data ?? {}) as Record<string, unknown>
  const provider = str(row.provider)
  if (!provider) return null
  return {
    provider,
    billing: strOrNull(row.billing),
    estimatedApiCost: num(row.estimatedApiCost),
    tokens: num(row.tokens),
  }
}

function asSeriesBucket(data: unknown): UsageSeriesBucket | null {
  const row = (data ?? {}) as Record<string, unknown>
  const date = str(row.date)
  // A bucket without a usable date has nowhere to sit on the x-axis.
  if (!ISO_DATE_RE.test(date)) return null
  return {
    date,
    requests: num(row.requests),
    inputTokens: num(row.inputTokens),
    outputTokens: num(row.outputTokens),
    reasoningTokens: num(row.reasoningTokens),
    cacheReadTokens: num(row.cacheReadTokens),
    cacheWriteTokens: num(row.cacheWriteTokens),
    estimatedApiCost: num(row.estimatedApiCost),
    unpricedRequests: num(row.unpricedRequests),
    byProvider: arr(row.byProvider)
      .map(asProviderSlice)
      .filter((slice): slice is UsageSeriesBucket["byProvider"][number] => slice !== null),
  }
}

export function asUsageSeries(data: unknown): UsageSeriesResponse {
  const body = (data ?? {}) as Record<string, unknown>
  const buckets = arr(body.buckets)
    .map(asSeriesBucket)
    .filter((bucket): bucket is UsageSeriesBucket => bucket !== null)
    // The chart assumes ascending days; don't trust the server's ordering.
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
  return {
    from: str(body.from, buckets[0]?.date ?? ""),
    to: str(body.to, buckets[buckets.length - 1]?.date ?? ""),
    bucket: "day",
    buckets,
  }
}

function asModelRow(data: unknown): UsageModelRow | null {
  const row = (data ?? {}) as Record<string, unknown>
  const provider = str(row.provider)
  const model = str(row.model)
  if (!provider && !model) return null
  return {
    provider,
    model,
    billing: strOrNull(row.billing),
    requests: num(row.requests),
    inputTokens: num(row.inputTokens),
    outputTokens: num(row.outputTokens),
    reasoningTokens: num(row.reasoningTokens),
    cacheReadTokens: num(row.cacheReadTokens),
    cacheWriteTokens: num(row.cacheWriteTokens),
    estimatedApiCost: num(row.estimatedApiCost),
    // Absent `priced` is inferred from cost so an older shape still sorts right.
    priced: typeof row.priced === "boolean" ? row.priced : num(row.estimatedApiCost) > 0,
    avgRating: numOrNull(row.avgRating),
    ratedCount: num(row.ratedCount),
    reworkRate: numOrNull(row.reworkRate),
  }
}

function asProviderRollup(data: unknown): UsageProviderRollup | null {
  const row = (data ?? {}) as Record<string, unknown>
  const provider = str(row.provider)
  if (!provider) return null
  return {
    provider,
    billing: strOrNull(row.billing),
    estimatedApiCost: num(row.estimatedApiCost),
    tokens: num(row.tokens),
    share: num(row.share),
  }
}

export function asUsageBreakdown(data: unknown): UsageBreakdownResponse {
  const body = (data ?? {}) as Record<string, unknown>
  const totals = (body.totals ?? {}) as Record<string, unknown>
  return {
    rows: arr(body.rows)
      .map(asModelRow)
      .filter((row): row is UsageModelRow => row !== null)
      // Cost desc is the table's contract; ties fall back to token volume.
      .sort((a, b) =>
        b.estimatedApiCost !== a.estimatedApiCost
          ? b.estimatedApiCost - a.estimatedApiCost
          : modelTokens(b) - modelTokens(a),
      ),
    totals: {
      estimatedApiCost: num(totals.estimatedApiCost),
      totalTokens: num(totals.totalTokens),
      pricedShare: num(totals.pricedShare),
      cacheSavings: num(totals.cacheSavings),
    },
    providers: arr(body.providers)
      .map(asProviderRollup)
      .filter((row): row is UsageProviderRollup => row !== null),
  }
}

/** Every token a model row accounts for (the table's Tokens column). */
export function modelTokens(row: UsageModelRow): number {
  return (
    row.inputTokens +
    row.outputTokens +
    row.reasoningTokens +
    row.cacheReadTokens +
    row.cacheWriteTokens
  )
}

/** provider/model for the breakdown table (no effort in this contract). */
export function modelRowLabel(row: UsageModelRow): string {
  if (!row.provider) return row.model || "unknown"
  if (!row.model) return row.provider
  return `${row.provider}/${row.model}`
}

/** Cost with enough precision to be honest about cents-scale spend. */
export function costLabel(v: number): string {
  if (!Number.isFinite(v) || v <= 0) return "$0.00"
  if (v < 0.01) return "<$0.01"
  if (v < 100) return `$${v.toFixed(2)}`
  return `$${Math.round(v).toLocaleString()}`
}

/** Big hero number: "$1,284.10". Same rounding rules, thousands separated. */
export function bigCostLabel(v: number): string {
  if (!Number.isFinite(v) || v <= 0) return "$0.00"
  return `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

/** A 0..1 share as a percentage; "—" when there is nothing to take a share of. */
export function shareLabel(v: number | null): string {
  if (v == null || !Number.isFinite(v)) return "—"
  const pct = (v > 1 ? v : v * 100)
  if (pct > 0 && pct < 0.1) return "<0.1%"
  return `${pct.toFixed(pct >= 10 ? 0 : 1)}%`
}

const QUOTA_STATUSES: readonly ProviderQuotaStatus[] = [
  "available",
  "stale",
  "not-authenticated",
  "unsupported",
  "error",
]
const QUOTA_KINDS: readonly ProviderQuotaWindowKind[] = [
  "five-hour",
  "weekly",
  "weekly-model",
  "other",
]

function asQuotaWindow(data: unknown): ProviderQuotaWindow | null {
  const row = (data ?? {}) as Record<string, unknown>
  const kindRaw = str(row.kind)
  const kind = (QUOTA_KINDS as readonly string[]).includes(kindRaw)
    ? (kindRaw as ProviderQuotaWindowKind)
    : "other"
  const model = strOrNull(row.model)
  const label = str(row.label)
  // A window with nothing to name itself by is noise, not a meter.
  if (!label && !model && kind === "other") return null
  const percent = numOrNull(row.usedPercent)
  const reset = numOrNull(row.resetAt)
  return {
    kind,
    label,
    // The bar cannot render a negative or >100 fill, and a server that reports
    // a rate (0..1) instead of a percentage is still shown, just at the bottom.
    usedPercent: percent == null ? null : Math.min(100, Math.max(0, percent)),
    // A non-positive epoch is "no reset", not 1970.
    resetAt: reset != null && reset > 0 ? reset : null,
    ...(numOrNull(row.windowMinutes) != null ? { windowMinutes: num(row.windowMinutes) } : {}),
    ...(model ? { model } : {}),
  }
}

function asProviderQuota(data: unknown): ProviderQuota | null {
  const row = (data ?? {}) as Record<string, unknown>
  const provider = str(row.provider)
  if (!provider) return null
  const windows = arr(row.windows)
    .map(asQuotaWindow)
    .filter((w): w is ProviderQuotaWindow => w !== null)
  const statusRaw = str(row.status)
  const status: ProviderQuotaStatus = (QUOTA_STATUSES as readonly string[]).includes(statusRaw)
    ? (statusRaw as ProviderQuotaStatus)
    // No usable status: having windows is itself evidence the read worked.
    : windows.length > 0
      ? "available"
      : "unsupported"
  const billingRaw = str(row.billing)
  const sourceRaw = str(row.source)
  const error = strOrNull(row.error)
  return {
    provider,
    billing: billingRaw === "subscription" || billingRaw === "api-key" ? billingRaw : null,
    status,
    source:
      sourceRaw === "codex-usage" || sourceRaw === "response-headers" || sourceRaw === "anthropic-sdk"
        ? sourceRaw
        : null,
    fetchedAt: numOrNull(row.fetchedAt),
    windows,
    ...(error ? { error } : {}),
  }
}

export function asProviderQuotas(data: unknown): ProviderQuotasResponse {
  const body = (data ?? {}) as Record<string, unknown>
  return {
    fetchedAt: num(body.fetchedAt),
    providers: arr(body.providers)
      .map(asProviderQuota)
      .filter((row): row is ProviderQuota => row !== null),
  }
}

/** "8.4 (12)" — average plus the sample count that earned it; "—" when unrated. */
export function scoreLabel(row: { avgRating: number | null; ratedCount: number }): string {
  if (row.avgRating == null || row.ratedCount <= 0) return "—"
  return `${row.avgRating.toFixed(1)} (${row.ratedCount})`
}
