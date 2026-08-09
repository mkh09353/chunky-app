// The daily usage chart — hand-rolled SVG, no charting dependency.
//
// It draws one stacked band per provider over the day buckets the server sent,
// and it has to survive the three shapes real data takes: a full 90-day window,
// a 7-day window with two points, and a window where everything is zero (a new
// install, or a session that has spent nothing). The all-zero case still draws
// the axes and a baseline so the page doesn't look broken — it just says so.
//
// Sizing follows the container via ResizeObserver rather than a fixed viewBox,
// because the page lives in a resizable pane and a squashed viewBox makes the
// axis labels illegible long before the layout actually breaks.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { cn } from "~/lib/cn"
import { compactTokens, costLabel, type UsageSeriesBucket } from "~/lib/stats"
import {
  axisScale,
  bucketAtX,
  chartData,
  dayLabel,
  scaleX,
  scaleY,
  stackedPaths,
  tickIndexes,
  type ChartDims,
  type UsageMetric,
} from "~/lib/usage"

/** Token-derived series colours, assigned by provider order (subscription
 *  first) so a provider keeps its colour for as long as the rollup order does. */
export const SERIES_COLORS = [
  "var(--primary)",
  "var(--info)",
  "var(--success)",
  "var(--warning)",
  "color-mix(in oklab, var(--info) 55%, var(--success))",
  "color-mix(in oklab, var(--primary) 55%, var(--warning))",
] as const

export function seriesColor(index: number): string {
  return SERIES_COLORS[index % SERIES_COLORS.length]!
}

const PAD: Omit<ChartDims, "width" | "height"> = {
  padLeft: 46,
  padRight: 12,
  padTop: 12,
  padBottom: 22,
}

/** Container width → chart height: ~2.6:1, clamped so it stays readable in a
 *  narrow pane and doesn't dominate a wide one. */
function heightFor(width: number): number {
  return Math.round(Math.min(280, Math.max(170, width / 2.6)))
}

export function UsageChart({
  buckets,
  keys,
  metric,
  className,
}: {
  buckets: readonly UsageSeriesBucket[]
  /** Provider keys, bottom-of-stack first (see lib/usage chartProviderKeys). */
  keys: readonly string[]
  metric: UsageMetric
  className?: string
}) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const [width, setWidth] = useState(720)
  const [hover, setHover] = useState<number | null>(null)

  useLayoutEffect(() => {
    const host = hostRef.current
    if (!host) return
    const measure = () => setWidth(Math.max(220, Math.round(host.clientWidth)))
    measure()
    // Fires on pane resize, sidebar collapse, and window resize alike.
    const observer = new ResizeObserver(measure)
    observer.observe(host)
    return () => observer.disconnect()
  }, [])

  // A window resize can leave a stale hover pointing at a bucket that has since
  // moved; clearing on data change is cheaper than tracking it.
  useEffect(() => setHover(null), [buckets, metric])

  const height = heightFor(width)
  const dims: ChartDims = useMemo(() => ({ width, height, ...PAD }), [width, height])
  const data = useMemo(() => chartData(buckets, keys, metric), [buckets, keys, metric])
  const scale = useMemo(() => axisScale(data.max), [data.max])
  const paths = useMemo(
    () => stackedPaths(data.points, keys.length, scale.top, dims),
    [data.points, keys.length, scale.top, dims],
  )
  const xTicks = useMemo(() => tickIndexes(data.points.length), [data.points.length])

  const format = useCallback(
    (v: number) => (metric === "cost" ? costLabel(v) : compactTokens(v)),
    [metric],
  )

  const onMove = useCallback(
    (event: React.PointerEvent<SVGSVGElement>) => {
      const svg = event.currentTarget
      const rect = svg.getBoundingClientRect()
      if (rect.width <= 0) return
      // The SVG is drawn in user units equal to `width`; scale the client x back.
      const x = ((event.clientX - rect.left) / rect.width) * dims.width
      setHover(bucketAtX(x, data.points.length, dims))
    },
    [data.points.length, dims],
  )

  if (data.points.length === 0) {
    return (
      <div
        ref={hostRef}
        className={cn(
          "flex min-w-0 items-center justify-center rounded-xl border border-border border-dashed text-[12px] text-muted-foreground",
          className,
        )}
        style={{ height: heightFor(width) }}
      >
        No daily buckets in this range.
      </div>
    )
  }

  const point = hover == null ? null : data.points[hover]
  const hoverX = hover == null ? 0 : scaleX(hover, data.points.length, dims)

  return (
    <div ref={hostRef} className={cn("relative min-w-0", className)}>
      <svg
        role="img"
        aria-label={`Daily ${metric === "cost" ? "estimated cost" : "tokens"} by provider`}
        width="100%"
        height={height}
        viewBox={`0 0 ${dims.width} ${height}`}
        preserveAspectRatio="none"
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
        className="block touch-none"
      >
        <title>{`Daily ${metric === "cost" ? "estimated cost" : "tokens"} by provider`}</title>
        {/* Horizontal grid + y labels. */}
        {scale.values.map((value) => {
          const y = scaleY(value, scale.top, dims)
          return (
            <g key={value}>
              <line
                x1={dims.padLeft}
                x2={dims.width - dims.padRight}
                y1={y}
                y2={y}
                stroke="var(--border)"
                strokeWidth={1}
                opacity={value === 0 ? 0.9 : 0.45}
              />
              <text
                x={dims.padLeft - 8}
                y={y + 3}
                textAnchor="end"
                className="fill-muted-foreground font-mono text-[9px]"
              >
                {data.allZero && value !== 0 ? "" : format(value)}
              </text>
            </g>
          )
        })}

        {/* Stacked bands. Bottom of the stack is drawn first. */}
        {!data.allZero &&
          paths.areas.map((d, i) => (
            <path key={`area-${keys[i] ?? i}`} d={d} fill={seriesColor(i)} opacity={0.22} />
          ))}
        {!data.allZero &&
          paths.lines.map((d, i) => (
            <path
              key={`line-${keys[i] ?? i}`}
              d={d}
              fill="none"
              stroke={seriesColor(i)}
              strokeWidth={1.5}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          ))}

        {/* Hover rule + a dot on the day's total. */}
        {point && (
          <g pointerEvents="none">
            <line
              x1={hoverX}
              x2={hoverX}
              y1={dims.padTop}
              y2={height - dims.padBottom}
              stroke="var(--foreground)"
              strokeWidth={1}
              opacity={0.28}
            />
            <circle
              cx={hoverX}
              cy={scaleY(point.total, scale.top, dims)}
              r={3}
              fill="var(--background)"
              stroke="var(--primary)"
              strokeWidth={1.5}
            />
          </g>
        )}

        {/* X labels. */}
        {xTicks.map((i) => (
          <text
            key={data.points[i]?.date ?? i}
            x={scaleX(i, data.points.length, dims)}
            y={height - 6}
            textAnchor={i === 0 ? "start" : i === data.points.length - 1 ? "end" : "middle"}
            className="fill-muted-foreground font-mono text-[9px]"
          >
            {dayLabel(data.points[i]?.date ?? "")}
          </text>
        ))}
      </svg>

      {data.allZero && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <span className="rounded-full border border-border bg-background/80 px-2.5 py-1 text-[11px] text-muted-foreground">
            Nothing recorded in this range
          </span>
        </div>
      )}

      {point && <ChartTooltip point={point} keys={keys} x={hoverX} width={width} format={format} />}
    </div>
  )
}

const TOOLTIP_WIDTH = 190

function ChartTooltip({
  point,
  keys,
  x,
  width,
  format,
}: {
  point: { date: string; values: number[]; total: number }
  keys: readonly string[]
  x: number
  width: number
  format: (v: number) => string
}) {
  // Clamp inside the chart box: near either edge the tooltip slides rather than
  // spilling out of the card (and, at the window edge, off-screen).
  const left = Math.min(Math.max(8, x - TOOLTIP_WIDTH / 2), Math.max(8, width - TOOLTIP_WIDTH - 8))
  const rows = keys
    .map((key, i) => ({ key, value: point.values[i] ?? 0, color: seriesColor(i) }))
    .filter((row) => row.value > 0)
    .sort((a, b) => b.value - a.value)
  return (
    <div
      className="pointer-events-none absolute top-2 z-10 rounded-lg border border-border bg-popover/95 p-2 text-popover-foreground shadow-md shadow-black/10 backdrop-blur-sm dark:shadow-black/30"
      style={{ left, width: TOOLTIP_WIDTH }}
    >
      <p className="mb-1 font-medium text-[11px]">{dayLabel(point.date)}</p>
      {rows.length === 0 ? (
        <p className="text-[11px] text-muted-foreground">Nothing recorded</p>
      ) : (
        <ul className="flex flex-col gap-0.5">
          {rows.map((row) => (
            <li key={row.key} className="flex min-w-0 items-center gap-1.5 text-[11px]">
              <span
                aria-hidden="true"
                className="size-1.5 shrink-0 rounded-full"
                style={{ backgroundColor: row.color }}
              />
              <span className="min-w-0 flex-1 truncate font-mono text-muted-foreground">
                {row.key}
              </span>
              <span className="shrink-0 tabular-nums">{format(row.value)}</span>
            </li>
          ))}
        </ul>
      )}
      {rows.length > 1 && (
        <p className="mt-1 flex items-center justify-between border-border/60 border-t pt-1 text-[11px]">
          <span className="text-muted-foreground">Total</span>
          <span className="tabular-nums">{format(point.total)}</span>
        </p>
      )}
    </div>
  )
}
