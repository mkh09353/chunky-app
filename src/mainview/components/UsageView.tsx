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
import { BarChart3, Clock3, Loader2, RefreshCw } from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  getProviderQuotas,
  getResourceUsage,
  getUsageBreakdown,
  getUsageSeries,
  type UsageFetch,
  type UsageQuery,
} from "~/lib/api"
import {
  appResourcesAvailable,
  fetchAppResourceUsage,
  type AppResourceUsage,
} from "~/lib/appResources"
import { cn } from "~/lib/cn"
import { relativeTime } from "~/lib/format"
import {
  asProviderQuotas,
  asResourceUsage,
  asUsageBreakdown,
  asUsageSeries,
  bigCostLabel,
  compactTokens,
  costLabel,
  cpuLabel,
  kindLabel,
  modelRowLabel,
  modelTokens,
  peakContextLabel,
  percent,
  rssLabel,
  scoreLabel,
  shareLabel,
  type ProviderQuota,
  type ResourcePeak,
  type ResourcePercentiles,
  type ResourceUsageResponse,
  type UsageBreakdownResponse,
  type UsageModelRow,
  type UsageSeriesResponse,
} from "~/lib/stats"
import {
  chartProviderKeys,
  isSubscription,
  mergeProviderCards,
  quotaBarPercent,
  quotaHasMeters,
  quotaPercentLabel,
  quotaResetLabel,
  quotaTone,
  quotaWindowLabel,
  rangeFor,
  rangeSubtitle,
  seriesCost,
  usageStrip,
  USAGE_RANGES,
  type ProviderCard as ProviderCardModel,
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
  // null = this server has no quota endpoint (or it failed): the whole meters
  // section disappears rather than showing an apology next to the cost numbers.
  const [quotas, setQuotas] = useState<ProviderQuota[] | null>(null)
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

  // Quotas are global and cheap, so they ride the refresh button and the base
  // URL only — not the range or scope, which cannot change what a subscription
  // window says.
  useEffect(() => {
    if (!baseUrl) {
      setQuotas(null)
      return
    }
    let live = true
    void getProviderQuotas(baseUrl).then((result) => {
      if (!live) return
      setQuotas(result.status === "ok" ? asProviderQuotas(result.body).providers : null)
    })
    return () => {
      live = false
    }
  }, [baseUrl, nonce])

  // Countdown clock for "resets in…". One interval for the whole page, stopped
  // while the window is hidden so a backgrounded tab isn't re-rendering all day.
  const [now, setNow] = useState(() => Date.now())
  const hasResets = useMemo(
    () => (quotas ?? []).some((q) => q.windows.some((w) => w.resetAt != null)),
    [quotas],
  )
  useEffect(() => {
    if (!hasResets) return
    let timer: number | undefined
    const stop = () => {
      if (timer != null) window.clearInterval(timer)
      timer = undefined
    }
    const start = () => {
      stop()
      setNow(Date.now())
      timer = window.setInterval(() => setNow(Date.now()), 60_000)
    }
    const onVisibility = () => (document.hidden ? stop() : start())
    if (!document.hidden) start()
    document.addEventListener("visibilitychange", onVisibility)
    return () => {
      stop()
      document.removeEventListener("visibilitychange", onVisibility)
    }
  }, [hasResets])

  const buckets = useMemo(() => state.series?.buckets ?? NO_BUCKETS, [state.series])
  const cards = useMemo(
    () => mergeProviderCards(state.breakdown?.providers ?? [], quotas ?? []),
    [state.breakdown, quotas],
  )
  const providers = useMemo(
    () => cards.spending.map((card) => card.rollup!).filter(Boolean),
    [cards],
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

                {cards.spending.length === 0 && cards.quotaOnly.length === 0 ? (
                  <Card className="px-3 py-4 text-center text-[11.5px] text-muted-foreground">
                    No provider activity in this range.
                  </Card>
                ) : (
                  <>
                    {cards.spending.map((card, i) => (
                      <ProviderCard
                        key={card.provider}
                        card={card}
                        now={now}
                        color={seriesColor(
                          keys.indexOf(card.provider) >= 0 ? keys.indexOf(card.provider) : i,
                        )}
                      />
                    ))}
                    {/* Subscriptions with a limit but no spend this range sit
                        last: worth seeing, never worth displacing the providers
                        that actually cost something. */}
                    {cards.quotaOnly.map((card) => (
                      <ProviderCard key={card.provider} card={card} now={now} color={null} />
                    ))}
                  </>
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

        {/* Independent of the spend endpoints above: a server can answer the
            resource sampler and not the usage history, or the other way round.
            It renders nothing at all when neither footprint is readable. */}
        <ResourcesSection baseUrl={baseUrl} nonce={nonce} />
      </div>
    </div>
  )
}

/** 24h / 7d / 30d, in the hours the endpoint takes. */
const RESOURCE_WINDOWS: readonly { value: string; label: string; hours: number }[] = [
  { value: "24", label: "24h", hours: 24 },
  { value: "168", label: "7d", hours: 168 },
  { value: "720", label: "30d", hours: 720 },
]

/**
 * "Resources" — two parallel footprints under one window selector:
 *
 *  - Server: this Chunky server and the process trees it spawns, plus the top
 *    memory ticks with the background tasks live at each one (the "why was P99
 *    5 GiB" answer).
 *  - App: the desktop shell's own Bun process and its helpers, sampled locally
 *    over RPC (src/mainview/lib/appResources.ts).
 *
 * Both halves are optional by construction: an older server 404s and a web/dev
 * build has no RPC, so each block disappears on its own and the whole section
 * renders nothing when neither can be read — no banner, no gap.
 */
function ResourcesSection({ baseUrl, nonce }: { baseUrl: string | null; nonce: number }) {
  // One selector drives both queries; the two windows always agree.
  const [hours, setHours] = useState(24)
  const [server, setServer] = useState<ResourceUsageResponse | null>(null)
  const [serverUnsupported, setServerUnsupported] = useState(false)
  const [serverError, setServerError] = useState<string | null>(null)
  const [app, setApp] = useState<AppResourceUsage | null>(null)
  // Starts "not yet known": the web build reports unavailable synchronously,
  // but the desktop build must not flash an empty App block before it answers.
  const [appUnavailable, setAppUnavailable] = useState(!appResourcesAvailable())
  const serverRef = useRef(0)
  const appRef = useRef(0)

  useEffect(() => {
    if (!baseUrl) {
      setServer(null)
      setServerUnsupported(true)
      return
    }
    const id = ++serverRef.current
    void getResourceUsage(baseUrl, hours).then((result) => {
      if (serverRef.current !== id) return
      setServerUnsupported(result.status === "unsupported")
      setServerError(result.status === "error" ? result.message : null)
      setServer(result.status === "ok" ? asResourceUsage(result.body) : null)
    })
  }, [baseUrl, hours, nonce])

  // The app sampler is local: no base URL, same window and refresh nonce.
  useEffect(() => {
    const id = ++appRef.current
    void fetchAppResourceUsage(hours).then((result) => {
      if (appRef.current !== id) return
      setAppUnavailable(result.status !== "ok")
      setApp(result.status === "ok" ? result : null)
    })
  }, [hours, nonce])

  const showServer = !serverUnsupported && (server != null || serverError != null)
  const showApp = !appUnavailable && app != null
  // Nothing to say yet (first load) or ever (old server + web build).
  if (!showServer && !showApp) return null

  return (
    <section className="mt-8 min-w-0">
      <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
        <div className="min-w-0">
          <h2 className="font-semibold text-[14px] leading-tight tracking-[-0.01em]">Resources</h2>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            Memory and CPU of the Chunky server and this app
          </p>
        </div>
        <SegmentedControl
          options={RESOURCE_WINDOWS.map((w) => ({ value: w.value, label: w.label }))}
          value={String(hours)}
          onChange={(value) => setHours(Number(value))}
          ariaLabel="Resource window"
        />
      </div>

      {showServer && (
        <ResourceBlock
          title="Server resources"
          subtitle={sampleSubtitle(server, "the Chunky server and its child processes")}
        >
          {serverError ? (
            <p className="rounded-lg border border-destructive/35 bg-destructive/10 px-3 py-2 text-[12px] text-destructive">
              {serverError}
            </p>
          ) : !server || server.sampleCount === 0 ? (
            <CollectingSamples />
          ) : (
            <>
              <ResourceStats current={server.server.current} total={server.total} />
              <div className="mt-3 min-w-0 rounded-xl border border-border">
                <p className="border-border/70 border-b bg-muted/40 px-3 py-1.5 font-medium text-[10.5px] text-muted-foreground uppercase tracking-[0.09em]">
                  Peaks
                </p>
                {server.peaks.length === 0 ? (
                  <p className="px-3 py-6 text-center text-[11.5px] text-muted-foreground">
                    No memory peaks recorded in this window.
                  </p>
                ) : (
                  <ul className="min-w-0">
                    {server.peaks.map((peak, i) => (
                      <PeakRow key={`${peak.ts}-${i}`} peak={peak} />
                    ))}
                  </ul>
                )}
              </div>
            </>
          )}
        </ResourceBlock>
      )}

      {showApp && (
        <ResourceBlock
          title="App (this machine)"
          subtitle={sampleSubtitle(app, "the desktop shell and its helper processes")}
          className={showServer ? "mt-5" : undefined}
        >
          {app.sampleCount === 0 ? (
            <CollectingSamples />
          ) : (
            <ResourceStats current={app.bun.current} total={app.total} />
          )}
          <p className="mt-2 text-[10.5px] text-muted-foreground/70">
            excludes WebKit content processes
          </p>
        </ResourceBlock>
      )}
    </section>
  )
}

/** "288 samples every 5s", or the block's own description before any land. */
function sampleSubtitle(
  data: { sampleCount: number; intervalMs: number } | null,
  fallback: string,
): string {
  if (!data || data.sampleCount <= 0) return `Memory and CPU of ${fallback}`
  const every = data.intervalMs > 0 ? ` every ${Math.round(data.intervalMs / 1000)}s` : ""
  return `${data.sampleCount.toLocaleString()} sample${data.sampleCount === 1 ? "" : "s"}${every}`
}

/** A labelled half of the section — server or app, same chrome either way. */
function ResourceBlock({
  title,
  subtitle,
  className,
  children,
}: {
  title: string
  subtitle: string
  className?: string
  children: React.ReactNode
}) {
  return (
    <div className={cn("min-w-0", className)}>
      <div className="mb-2 flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <h3 className="font-medium text-[12px] tracking-[-0.01em]">{title}</h3>
        <p className="min-w-0 truncate text-[11px] text-muted-foreground/80">{subtitle}</p>
      </div>
      {children}
    </div>
  )
}

function CollectingSamples() {
  return (
    <p className="rounded-xl border border-border border-dashed px-3 py-8 text-center text-[12px] text-muted-foreground">
      Collecting samples…
    </p>
  )
}

/** The three headline cards both footprints share. */
function ResourceStats({
  current,
  total,
}: {
  current: { rssBytes: number; heapUsedBytes: number; cpuPercent: number }
  total: { rssBytes: ResourcePercentiles; cpuPercent: ResourcePercentiles }
}) {
  return (
    <div className="grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-3">
      <Stat
        label="Current RSS"
        value={rssLabel(current.rssBytes)}
        note={`${rssLabel(current.heapUsedBytes)} heap · ${cpuLabel(current.cpuPercent)} CPU`}
      />
      <Stat
        label="Total RSS P95"
        value={rssLabel(total.rssBytes.p95)}
        note={`P50 ${rssLabel(total.rssBytes.p50)} · P99 ${rssLabel(total.rssBytes.p99)} · max ${rssLabel(total.rssBytes.max)}`}
      />
      <Stat
        label="CPU P95"
        value={cpuLabel(total.cpuPercent.p95)}
        note={`P99 ${cpuLabel(total.cpuPercent.p99)} · max ${cpuLabel(total.cpuPercent.max)}`}
      />
    </div>
  )
}

/** One memory tick: when, how big, how busy — then what was running. */
function PeakRow({ peak }: { peak: ResourcePeak }) {
  const context = peakContextLabel(peak)
  const when = new Date(peak.ts)
  return (
    <li className="min-w-0 border-border/50 border-b px-3 py-2 last:border-0">
      <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <span className="min-w-0 truncate text-[11.5px] text-muted-foreground tabular-nums">
          {Number.isNaN(when.getTime()) ? "—" : when.toLocaleString()}
        </span>
        <span className="shrink-0 text-[12px] tabular-nums">
          <span className="font-medium">{rssLabel(peak.totalRssBytes)}</span>
          <span className="mx-1.5 opacity-40">·</span>
          <span className="text-muted-foreground">{cpuLabel(peak.cpuPercent)} CPU</span>
        </span>
      </div>
      <p className="mt-0.5 truncate text-[10.5px] text-muted-foreground/80">
        server {rssLabel(peak.serverRssBytes)}
        {context && (
          <>
            <span className="mx-1.5 opacity-40">·</span>
            {context}
          </>
        )}
      </p>
      {peak.topTasks.length > 0 && (
        <ul className="mt-1 flex min-w-0 flex-col gap-0.5">
          {peak.topTasks.map((task, i) => (
            <li
              key={`${task.taskId || task.command}-${i}`}
              className="flex min-w-0 items-baseline gap-2 text-[10.5px]"
            >
              <span
                className="min-w-0 flex-1 truncate font-mono text-muted-foreground"
                title={task.command}
              >
                {task.command || task.taskId}
              </span>
              <span className="shrink-0 text-muted-foreground/80 tabular-nums">
                {rssLabel(task.rssBytes)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </li>
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

/** One provider in the left column: spend (when there was any) with its
 *  subscription meters underneath. `color` matches the chart series; quota-only
 *  cards have no series, so they get a neutral dot and a slimmer body. */
function ProviderCard({
  card,
  now,
  color,
}: {
  card: ProviderCardModel
  now: number
  color: string | null
}) {
  const { rollup, quota } = card
  // Quota-only cards exist because the merge already decided they are
  // subscriptions; a spending card asks its own rollup.
  const subscription = rollup ? isSubscription(rollup.billing) : true
  return (
    <Card className={cn("min-w-0", rollup ? "p-3" : "px-3 py-2.5")}>
      <div className="flex min-w-0 items-center gap-1.5">
        <span
          aria-hidden="true"
          className="size-2 shrink-0 rounded-full"
          style={{ backgroundColor: color ?? "var(--muted-foreground)", opacity: color ? 1 : 0.5 }}
        />
        <span className="min-w-0 flex-1 truncate font-mono text-[12px]">{card.provider}</span>
        {subscription && (
          <span className="shrink-0 rounded-full border border-success/35 bg-success/10 px-1.5 py-px text-[9.5px] text-success">
            sub
          </span>
        )}
      </div>
      {rollup && (
        <>
          <p className="mt-1.5 font-semibold text-[16px] leading-none tabular-nums">
            {costLabel(rollup.estimatedApiCost)}
          </p>
          <p className="mt-1.5 text-[11px] text-muted-foreground tabular-nums">
            {shareLabel(rollup.share)}
            <span className="mx-1.5 opacity-40">·</span>
            {compactTokens(rollup.tokens)} tokens
          </p>
        </>
      )}
      {subscription && quota && <QuotaMeters quota={quota} now={now} spending={!!rollup} />}
    </Card>
  )
}

/** The meters themselves — secondary to the cost above them, so: small type,
 *  thin bars, and every not-available status collapses to one quiet line. */
function QuotaMeters({
  quota,
  now,
  spending,
}: {
  quota: ProviderQuota
  now: number
  /** The card above has cost numbers, so the meters need a separating rule. */
  spending: boolean
}) {
  const wrapper = cn("min-w-0", spending ? "mt-2.5 border-border/60 border-t pt-2" : "mt-1.5")

  if (quota.status === "not-authenticated") {
    return <p className={cn(wrapper, "text-[10.5px] text-muted-foreground/70")}>sign in to see limits</p>
  }
  if (quota.status === "unsupported" || quota.status === "error" || !quotaHasMeters(quota)) {
    return (
      <div className={wrapper}>
        <Tooltip>
          <TooltipTrigger
            render={
              <span className="cursor-default text-[10.5px] text-muted-foreground/60 underline decoration-dotted underline-offset-2" />
            }
          >
            limits unavailable
          </TooltipTrigger>
          <TooltipPopup className="max-w-[240px]">
            {quota.error ||
              (quota.status === "unsupported"
                ? "This provider does not report subscription limits."
                : "The server could not read this provider's limits.")}
          </TooltipPopup>
        </Tooltip>
      </div>
    )
  }

  return (
    <div className={cn(wrapper, "flex flex-col gap-1.5")}>
      {quota.status === "stale" && (
        <Tooltip>
          <TooltipTrigger
            render={
              <span className="flex w-fit cursor-default items-center gap-1 text-[10px] text-muted-foreground/60" />
            }
          >
            <Clock3 className="size-2.5" />
            <span>last known</span>
          </TooltipTrigger>
          <TooltipPopup className="max-w-[240px]">
            {quota.fetchedAt
              ? `Limits last read ${relativeTime(quota.fetchedAt, now)} ago — the provider is not answering right now.`
              : "Limits are stale — the provider is not answering right now."}
          </TooltipPopup>
        </Tooltip>
      )}
      {quota.windows.map((w, i) => {
        const tone = quotaTone(w.usedPercent)
        const reset = quotaResetLabel(w.resetAt, now)
        const indeterminate = w.usedPercent == null
        return (
          <div key={`${w.kind}-${w.model ?? w.label ?? i}`} className="min-w-0">
            <div className="flex min-w-0 items-baseline gap-1.5">
              <span
                className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-muted-foreground"
                title={quotaWindowLabel(w)}
              >
                {quotaWindowLabel(w)}
              </span>
              <span
                className={cn(
                  "shrink-0 text-[10.5px] tabular-nums",
                  tone === "danger"
                    ? "text-destructive"
                    : tone === "warn"
                      ? "text-warning"
                      : "text-muted-foreground",
                )}
              >
                {quotaPercentLabel(w.usedPercent)}
              </span>
            </div>
            <div
              role="progressbar"
              aria-label={`${quota.provider} ${quotaWindowLabel(w)} usage`}
              aria-valuemin={0}
              aria-valuemax={100}
              {...(indeterminate ? {} : { "aria-valuenow": Math.round(w.usedPercent!) })}
              className={cn(
                "mt-1 h-1 w-full overflow-hidden rounded-full",
                indeterminate ? "border border-border/70 border-dashed" : "bg-muted",
              )}
            >
              {!indeterminate && (
                <div
                  className={cn(
                    "h-full rounded-full transition-[width] duration-300",
                    tone === "danger"
                      ? "bg-destructive"
                      : tone === "warn"
                        ? "bg-warning"
                        : "bg-muted-foreground/55",
                  )}
                  style={{ width: `${quotaBarPercent(w.usedPercent)}%` }}
                />
              )}
            </div>
            {reset && (
              <p className="mt-0.5 truncate text-[10px] text-muted-foreground/70">{reset}</p>
            )}
          </div>
        )
      })}
    </div>
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

/** Model | Cost | Share | Tokens | Score | Rework, cost desc (the parser sorts it). */
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
          <col className="w-[66px]" />
        </colgroup>
        <thead>
          <tr className="border-border/70 border-b bg-muted/40 text-[10.5px] text-muted-foreground uppercase tracking-wide">
            <th className="px-2.5 py-1.5 text-left font-medium">Model</th>
            <th className="px-2.5 py-1.5 text-right font-medium">Cost</th>
            <th className="px-2.5 py-1.5 text-right font-medium">Share</th>
            <th className="px-2.5 py-1.5 text-right font-medium">Tokens</th>
            <th className="px-2.5 py-1.5 text-right font-medium">Score</th>
            <th className="px-2.5 py-1.5 text-right font-medium">Rework</th>
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
              <td className="px-2.5 py-1.5 text-right text-muted-foreground tabular-nums">
                {row.reworkRate == null ? "—" : percent(row.reworkRate)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** The per-seat score lines the hover adds under its summary: one per seat that
 *  earned ratings on this model. A single unnamed seat says nothing the summary
 *  line doesn't, so it is dropped; a single NAMED seat is worth showing. Server
 *  order is kept. Absent/empty `scoreBySeat` yields no lines at all — exactly
 *  today's tooltip. */
function seatScoreLines(
  row: UsageModelRow,
): { key: string; label: string; score: string; rework: string | null }[] {
  const splits = row.scoreBySeat ?? []
  if (splits.length === 0) return []
  if (splits.length === 1 && !splits[0]!.seat) return []
  return splits.map((split, index) => ({
    key: `${split.kind}:${split.seat ?? ""}:${index}`,
    label: kindLabel(split),
    score: scoreLabel(split),
    rework: split.reworkRate == null ? null : percent(split.reworkRate),
  }))
}

/** "8.4 (12)" with rework behind a tooltip; an unrated model is an em-dash and
 *  says so on hover, so it is never read as "rated badly". */
function ScoreCell({ row }: { row: UsageModelRow }) {
  const label = scoreLabel(row)
  const bySeat = seatScoreLines(row)
  return (
    <Tooltip>
      <TooltipTrigger
        render={<span className="cursor-default border-border/60 border-b border-dotted" />}
      >
        {label}
      </TooltipTrigger>
      <TooltipPopup className="max-w-[280px]">
        {label === "—" ? (
          "Not rated yet — no delegated work from this model has been scored."
        ) : (
          <>
            {row.ratedCount} rated run{row.ratedCount === 1 ? "" : "s"}
            <span className="mx-1 opacity-50">·</span>
            rework {percent(row.reworkRate)}
          </>
        )}
        {bySeat.length > 0 && (
          <span className="mt-1 block space-y-0.5 border-border/40 border-t pt-1">
            {bySeat.map((entry) => (
              <span key={entry.key} className="flex items-baseline justify-between gap-3">
                <span className="min-w-0 truncate">{entry.label}</span>
                <span className="shrink-0 tabular-nums">
                  {entry.score}
                  {entry.rework && (
                    <>
                      <span className="mx-1 opacity-50">·</span>
                      <span className="opacity-70">rework {entry.rework}</span>
                    </>
                  )}
                </span>
              </span>
            ))}
          </span>
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
