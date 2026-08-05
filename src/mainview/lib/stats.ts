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
