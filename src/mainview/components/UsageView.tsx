// Usage — the full-page spend view.
//
// It answers "where did the money go, and was it worth it", which the old
// Usage & Scoreboard dialog could only gesture at: the dialog shows this
// session's roles right now, this page shows a window of days, split by
// provider, with the ratings each model earned alongside its cost.
//
// Two endpoints back it (/api/usage/series and /api/usage/breakdown, see the
// GAP note in lib/stats.ts). They are newer than some servers this app talks
// to, so "unsupported" is a first-class state rather than an error banner — the
// page explains itself and stops, and nothing here throws on a body it doesn't
// recognise (lib/stats.ts coerces every field).
//
// All arithmetic and chart geometry lives in lib/usage.ts; this file fetches,
// arranges, and formats.
import { BarChart3, Loader2, RefreshCw } from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  getUsageBreakdown,
  getUsageSeries,
  type UsageFetch,
  type UsageQuery,
} from "~/lib/api"
import { cn } from "~/lib/cn"
import {
  asUsageBreakdown,
  asUsageSeries,
  bigCostLabel,
  compactTokens,
  costLabel,
  modelRowLabel,
  modelTokens,
  percent,
  scoreLabel,
  shareLabel,
  type UsageBreakdownResponse,
  type UsageModelRow,
  type UsageSeriesResponse,
} from "~/lib/stats"
import {
  chartProviderKeys,
  isSubscription,
  orderProviders,
  rangeFor,
  rangeSubtitle,
  seriesCost,
  usageStrip,
  USAGE_RANGES,
  type UsageMetric,
  type UsageRangeDays,
} from "~/lib/usage"
import { seriesColor, UsageChart } from "./UsageChart"
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip"

type Scope = "all" | "session"

interface LoadState {
  series: UsageSeriesResponse | null
  breakdown: UsageBreakdownResponse | null
  /** Both endpoints answered 404/501 — this server has no usage history. */
  unsupported: boolean
  /** First error message from either endpoint, if any survived.  */
  error: string | null
}

const EMPTY: LoadState = { series: null, breakdown: null, unsupported: false, error: null }
/** Stable identity so the chart's hover-reset effect doesn't fire every render. */
const NO_BUCKETS: UsageSeriesResponse["buckets"] = []

/** Fold the two independent fetches into one page state. One endpoint failing
 *  must not blank the other, so each contributes whatever it managed. */
function foldResults(series: UsageFetch, breakdown: UsageFetch): LoadState {
  const unsupported = series.status === "unsupported" && breakdown.status === "unsupported"
  const error =
    series.status === "error"
      ? series.message
      : breakdown.status === "error"
        ? breakdown.message
        : null
  return {
    series: series.status === "ok" ? asUsageSeries(series.body) : null,
    breakdown: breakdown.status === "ok" ? asUsageBreakdown(breakdown.body) : null,
    unsupported,
    error,
  }
}

export function UsageView({
  baseUrl,
  sessionId,
}: {
  /** Server base URL; null/empty in demo or offline shells. */
  baseUrl: string | null
  /** The attached session, when there is one — enables the "This session" scope. */
  sessionId: string | null
}) {
  const [days, setDays] = useState<UsageRangeDays>(30)
  const [metric, setMetric] = useState<UsageMetric>("cost")
  const [scope, setScope] = useState<Scope>("all")
  const [state, setState] = useState<LoadState>(EMPTY)
  const [loading, setLoading] = useState(false)
  const [loadedOnce, setLoadedOnce] = useState(false)
  // Bumped by the refresh button; also the effect's re-run trigger.
  const [nonce, setNonce] = useState(0)
  // Only the newest request may write state (range toggles can outrun each other).
  const requestRef = useRef(0)

  // The window is computed once per load, not per render, so a load in flight
  // and the header subtitle always name the same days.
  const [range, setRange] = useState(() => rangeFor(30, Date.now()))

  // Scope falls back to "all" the moment the session goes away.
  const effectiveScope: Scope = scope === "session" && sessionId ? "session" : "all"

  useEffect(() => {
    if (!sessionId && scope === "session") setScope("all")
  }, [sessionId, scope])

  useEffect(() => {
    if (!baseUrl) {
      setState(EMPTY)
      setLoadedOnce(true)
      return
    }
    const id = ++requestRef.current
    const window = rangeFor(days, Date.now())
    const query: UsageQuery = {
      scope: effectiveScope,
      session: effectiveScope === "session" ? sessionId : null,
      from: window.from,
      to: window.to,
    }
    setRange(window)
    setLoading(true)
    void Promise.all([getUsageSeries(baseUrl, query), getUsageBreakdown(baseUrl, query)]).then(
      ([series, breakdown]) => {
        if (requestRef.current !== id) return
        setState(foldResults(series, breakdown))
        setLoading(false)
        setLoadedOnce(true)
      },
    )
  }, [baseUrl, days, effectiveScope, sessionId, nonce])

  const buckets = useMemo(() => state.series?.buckets ?? NO_BUCKETS, [state.series])
  const providers = useMemo(
    () => orderProviders(state.breakdown?.providers ?? []),
    [state.breakdown],
  )
  const keys = useMemo(() => chartProviderKeys(providers, buckets), [providers, buckets])
  const strip = useMemo(() => usageStrip(buckets), [buckets])
  // Series is the range's own truth; the breakdown total is the fallback for a
  // server that answered one endpoint and not the other.
  const totalCost = state.series
    ? seriesCost(buckets)
    : (state.breakdown?.totals.estimatedApiCost ?? 0)
  const rows = state.breakdown?.rows ?? []
  const totals = state.breakdown?.totals ?? null

  const refresh = useCallback(() => setNonce((n) => n + 1), [])

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto">
      <div className="mx-auto w-full min-w-0 max-w-[1100px] px-6 pb-16">
        <header className="flex flex-wrap items-end justify-between gap-3 pt-8 pb-5">
          <div className="min-w-0">
            <h1 className="font-semibold text-[20px] leading-tight tracking-[-0.02em]">Usage</h1>
            <p className="mt-1 text-[12px] text-muted-foreground">
              {rangeSubtitle(range.from, range.to)}
              <span className="mx-1.5 opacity-40">·</span>
              {effectiveScope === "session" ? "This session" : "All sessions"}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {sessionId && (
              <SegmentedControl
                options={[
                  { value: "all", label: "All" },
                  { value: "session", label: "This session" },
                ]}
                value={effectiveScope}
                onChange={(value) => setScope(value as Scope)}
                ariaLabel="Usage scope"
              />
            )}
            <SegmentedControl
              options={USAGE_RANGES.map((r) => ({ value: String(r), label: `${r}d` }))}
              value={String(days)}
              onChange={(value) => setDays(Number(value) as UsageRangeDays)}
              ariaLabel="Date range"
            />
            <button
              type="button"
              onClick={refresh}
              disabled={!baseUrl || loading}
              aria-label="Refresh usage"
              className="flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-lg border border-border bg-background/50 text-muted-foreground outline-none transition-colors hover:border-ring/40 hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-default disabled:opacity-50"
            >
              <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
            </button>
          </div>
        </header>

        {!loadedOnce ? (
          <Panel>
            <Loader2 className="size-4 animate-spin text-muted-foreground" />
            <span>Loading usage…</span>
          </Panel>
        ) : !baseUrl ? (
          <Panel>
            <BarChart3 className="size-4 opacity-60" />
            <span>Usage needs a live Chunky server.</span>
          </Panel>
        ) : state.unsupported ? (
          <Panel>
            <BarChart3 className="size-4 opacity-60" />
            <span className="max-w-[46ch] text-balance">
              This server does not support usage history yet. Update the Chunky server to see daily
              spend, provider split, and per-model scores.
            </span>
          </Panel>
        ) : (
          <>
            {state.error && (
              <p className="mb-4 rounded-lg border border-destructive/35 bg-destructive/10 px-3 py-2 text-[12px] text-destructive">
                {state.error}
              </p>
            )}

            <div className="grid min-w-0 gap-4 lg:grid-cols-[260px_minmax(0,1fr)]">
              <div className="flex min-w-0 flex-col gap-3">
                <Card className="p-4">
                  <p className="font-medium text-[10.5px] text-muted-foreground uppercase tracking-[0.09em]">
                    Raw token cost
                  </p>
                  <p className="mt-1.5 font-semibold text-[28px] leading-none tracking-[-0.02em] tabular-nums">
                    {bigCostLabel(totalCost)}
                    <span className="align-super text-[14px] text-muted-foreground">*</span>
                  </p>
                  <p className="mt-2 text-[11px] text-muted-foreground/80">
                    * if billed at full API rate
                  </p>
                </Card>

                {providers.length === 0 ? (
                  <Card className="px-3 py-4 text-center text-[11.5px] text-muted-foreground">
                    No provider activity in this range.
                  </Card>
                ) : (
                  providers.map((provider, i) => (
                    <Card key={provider.provider} className="min-w-0 p-3">
                      <div className="flex min-w-0 items-center gap-1.5">
                        {/* Same colour the provider has in the chart: `keys`
                            starts from this same ordered list, so the index
                            normally matches — the fallback only matters if the
                            two endpoints disagree about who exists. */}
                        <span
                          aria-hidden="true"
                          className="size-2 shrink-0 rounded-full"
                          style={{
                            backgroundColor: seriesColor(
                              keys.indexOf(provider.provider) >= 0 ? keys.indexOf(provider.provider) : i,
                            ),
                          }}
                        />
                        <span className="min-w-0 flex-1 truncate font-mono text-[12px]">
                          {provider.provider}
                        </span>
                        {isSubscription(provider.billing) && (
                          <span className="shrink-0 rounded-full border border-success/35 bg-success/10 px-1.5 py-px text-[9.5px] text-success">
                            sub
                          </span>
                        )}
                      </div>
                      <p className="mt-1.5 font-semibold text-[16px] leading-none tabular-nums">
                        {costLabel(provider.estimatedApiCost)}
                      </p>
                      <p className="mt-1.5 text-[11px] text-muted-foreground tabular-nums">
                        {shareLabel(provider.share)}
                        <span className="mx-1.5 opacity-40">·</span>
                        {compactTokens(provider.tokens)} tokens
                      </p>
                    </Card>
                  ))
                )}
              </div>

              <Card className="flex min-w-0 flex-col p-4">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                  <p className="font-medium text-[10.5px] text-muted-foreground uppercase tracking-[0.09em]">
                    Daily {metric === "cost" ? "cost" : "tokens"}
                  </p>
                  <SegmentedControl
                    options={[
                      { value: "cost", label: "Cost" },
                      { value: "tokens", label: "Tokens" },
                    ]}
                    value={metric}
                    onChange={(value) => setMetric(value as UsageMetric)}
                    ariaLabel="Chart metric"
                  />
                </div>
                <UsageChart buckets={buckets} keys={keys} metric={metric} />
                {keys.length > 0 && (
                  <ul className="mt-3 flex min-w-0 flex-wrap gap-x-3 gap-y-1">
                    {keys.map((key, i) => (
                      <li
                        key={key}
                        className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground"
                      >
                        <span
                          aria-hidden="true"
                          className="size-1.5 shrink-0 rounded-full"
                          style={{ backgroundColor: seriesColor(i) }}
                        />
                        <span className="truncate font-mono">{key}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            </div>

            <div className="mt-4 grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-5">
              <Stat
                label="Processed tokens"
                value={compactTokens(strip.processedTokens)}
                note={
                  strip.activeDays > 0
                    ? `${compactTokens(strip.perActiveDay)} per active day (${strip.activeDays})`
                    : "No active days in range"
                }
              />
              <Stat
                label="Cached input"
                value={compactTokens(strip.cachedInput)}
                note={`${shareLabel(strip.cachedShare)} of observed input`}
              />
              <Stat
                label="Uncached input"
                value={compactTokens(strip.uncachedInput)}
                note={`${strip.requests.toLocaleString()} request${strip.requests === 1 ? "" : "s"}`}
              />
              <Stat
                label="Output"
                value={compactTokens(strip.outputTokens)}
                note={
                  strip.reasoningTokens > 0
                    ? `plus ${compactTokens(strip.reasoningTokens)} reasoning`
                    : "no reasoning tokens reported"
                }
              />
              <Stat
                label="Cache savings"
                value={totals ? costLabel(totals.cacheSavings) : "—"}
                note="vs. uncached input at API rate"
              />
            </div>

            <div className="mt-6 grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1fr)_260px]">
              <BreakdownTable rows={rows} totalCost={totals?.estimatedApiCost ?? totalCost} />
              <Card className="min-w-0 p-4">
                <p className="font-medium text-[10.5px] text-muted-foreground uppercase tracking-[0.09em]">
                  Cost quality
                </p>
                <dl className="mt-3 flex flex-col gap-2.5">
                  <QualityRow
                    label="Priced"
                    value={totals ? shareLabel(totals.pricedShare) : "—"}
                    hint="Share of requests with a known price"
                  />
                  <QualityRow
                    label="Unpriced"
                    value={
                      totals
                        ? shareLabel(Math.max(0, 1 - (totals.pricedShare > 1 ? totals.pricedShare / 100 : totals.pricedShare)))
                        : "—"
                    }
                    hint={`${strip.unpricedRequests.toLocaleString()} request${strip.unpricedRequests === 1 ? "" : "s"} with no rate card`}
                  />
                  <QualityRow
                    label="Cache savings"
                    value={totals ? costLabel(totals.cacheSavings) : "—"}
                    hint="Estimated cost avoided by cache reads"
                  />
                </dl>
              </Card>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function Panel({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-center gap-2 rounded-xl border border-border border-dashed px-4 py-14 text-center text-[12.5px] text-muted-foreground">
      {children}
    </div>
  )
}

function Card({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("rounded-xl border border-border bg-card/40", className)}>{children}</div>
  )
}

function Stat({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <Card className="min-w-0 p-3">
      <p className="truncate font-medium text-[10.5px] text-muted-foreground uppercase tracking-[0.08em]">
        {label}
      </p>
      <p className="mt-1.5 font-semibold text-[17px] leading-none tabular-nums">{value}</p>
      <p className="mt-1.5 text-[11px] text-muted-foreground/80">{note}</p>
    </Card>
  )
}

function QualityRow({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="min-w-0">
      <div className="flex items-baseline justify-between gap-2">
        <dt className="truncate text-[12px] text-muted-foreground">{label}</dt>
        <dd className="shrink-0 font-medium text-[13px] tabular-nums">{value}</dd>
      </div>
      <p className="mt-0.5 text-[10.5px] text-muted-foreground/70">{hint}</p>
    </div>
  )
}

/** Model | Cost | Share | Tokens | Score, cost desc (the parser sorts it). */
function BreakdownTable({ rows, totalCost }: { rows: readonly UsageModelRow[]; totalCost: number }) {
  if (rows.length === 0) {
    return (
      <p className="rounded-xl border border-border border-dashed px-3 py-10 text-center text-[12px] text-muted-foreground">
        No model activity in this range.
      </p>
    )
  }
  return (
    <div className="min-w-0 overflow-hidden rounded-xl border border-border">
      <table className="w-full min-w-0 table-fixed border-collapse text-[12px]">
        <colgroup>
          <col />
          <col className="w-[76px]" />
          <col className="w-[62px]" />
          <col className="w-[72px]" />
          <col className="w-[86px]" />
        </colgroup>
        <thead>
          <tr className="border-border/70 border-b bg-muted/40 text-[10.5px] text-muted-foreground uppercase tracking-wide">
            <th className="px-2.5 py-1.5 text-left font-medium">Model</th>
            <th className="px-2.5 py-1.5 text-right font-medium">Cost</th>
            <th className="px-2.5 py-1.5 text-right font-medium">Share</th>
            <th className="px-2.5 py-1.5 text-right font-medium">Tokens</th>
            <th className="px-2.5 py-1.5 text-right font-medium">Score</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={`${row.provider}/${row.model}`}
              className="border-border/50 border-b last:border-0"
            >
              <td className="min-w-0 max-w-0 px-2.5 py-1.5">
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className="min-w-0 truncate font-mono" title={modelRowLabel(row)}>
                    {modelRowLabel(row)}
                  </span>
                  {!row.priced && (
                    <span className="shrink-0 rounded-full border border-border bg-muted px-1.5 py-px text-[9.5px] text-muted-foreground">
                      unpriced
                    </span>
                  )}
                </span>
              </td>
              <td className="px-2.5 py-1.5 text-right tabular-nums">
                {costLabel(row.estimatedApiCost)}
              </td>
              <td className="px-2.5 py-1.5 text-right text-muted-foreground tabular-nums">
                {totalCost > 0 ? shareLabel(row.estimatedApiCost / totalCost) : "—"}
              </td>
              <td className="px-2.5 py-1.5 text-right tabular-nums">
                {compactTokens(modelTokens(row))}
              </td>
              <td className="px-2.5 py-1.5 text-right tabular-nums">
                <ScoreCell row={row} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** "8.4 (12)" with rework behind a tooltip; an unrated model is an em-dash and
 *  says so on hover, so it is never read as "rated badly". */
function ScoreCell({ row }: { row: UsageModelRow }) {
  const label = scoreLabel(row)
  return (
    <Tooltip>
      <TooltipTrigger
        render={<span className="cursor-default border-border/60 border-b border-dotted" />}
      >
        {label}
      </TooltipTrigger>
      <TooltipPopup className="max-w-[240px]">
        {label === "—" ? (
          "Not rated yet — no delegated work from this model has been scored."
        ) : (
          <>
            {row.ratedCount} rated run{row.ratedCount === 1 ? "" : "s"}
            <span className="mx-1 opacity-50">·</span>
            rework {percent(row.reworkRate)}
          </>
        )}
      </TooltipPopup>
    </Tooltip>
  )
}

function SegmentedControl({
  options,
  value,
  onChange,
  ariaLabel,
}: {
  options: readonly { value: string; label: string }[]
  value: string
  onChange: (value: string) => void
  ariaLabel: string
}) {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className="flex shrink-0 items-center gap-0.5 rounded-lg border border-border bg-background/50 p-0.5"
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => onChange(option.value)}
          aria-pressed={value === option.value}
          className={cn(
            "cursor-pointer rounded-md px-2 py-1 text-[11.5px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/40",
            value === option.value
              ? "bg-primary/12 text-primary"
              : "text-muted-foreground hover:bg-accent hover:text-foreground",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}
