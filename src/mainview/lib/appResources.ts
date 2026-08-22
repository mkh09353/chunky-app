// Webview bridge for the app shell's own resource usage (see
// src/bun/resourceSample.ts). Sampling lives entirely in the Bun main process;
// the renderer only reads percentile summaries over this RPC. Types are
// mirrored here rather than imported so the web build never reaches into
// src/bun (matches the fsOps.ts / terminal.ts wrapper convention).

import { getRpc, nativeRpcAvailable } from "./rpc"

export type ResourcePercentiles = { p50: number; p95: number; p99: number; max: number }

/** Mirrors AppResourceUsage in src/bun/resourceSample.ts. */
export interface AppResourceUsage {
  status: "ok"
  sampleCount: number
  intervalMs: number
  windowMs: number
  bun: {
    rssBytes: ResourcePercentiles
    cpuPercent: ResourcePercentiles
    current: { rssBytes: number; heapUsedBytes: number; cpuPercent: number }
  }
  /** Per-tick SUM of the helper process tree; zeros when none were attributable. */
  helpers: { rssBytes: ResourcePercentiles; cpuPercent: ResourcePercentiles }
  total: { rssBytes: ResourcePercentiles; cpuPercent: ResourcePercentiles }
}

export type AppResourceUsageUnavailable = { status: "unavailable" }
export type AppResourceUsageResult = AppResourceUsage | AppResourceUsageUnavailable

const UNAVAILABLE: AppResourceUsageUnavailable = { status: "unavailable" }

/** App resource sampling only exists in the desktop app (no RPC in the web build). */
export function appResourcesAvailable(): boolean {
  return nativeRpcAvailable()
}

/**
 * Percentile summary of the app shell's RAM/CPU over the trailing `hours`
 * window. Resolves with { status: "unavailable" } on any failure (web build,
 * missing handler, RPC error, malformed reply) rather than throwing.
 */
export async function fetchAppResourceUsage(hours = 24): Promise<AppResourceUsageResult> {
  if (!nativeRpcAvailable()) return UNAVAILABLE
  try {
    const rpc = await getRpc()
    const fn = rpc?.request?.appResourceUsage
    if (!fn) return UNAVAILABLE
    const raw = (await fn({ hours })) as Partial<AppResourceUsage> | null
    if (!raw || typeof raw !== "object" || raw.status !== "ok") return UNAVAILABLE
    if (typeof raw.sampleCount !== "number" || !raw.bun || !raw.helpers || !raw.total) return UNAVAILABLE
    return raw as AppResourceUsage
  } catch {
    return UNAVAILABLE
  }
}
