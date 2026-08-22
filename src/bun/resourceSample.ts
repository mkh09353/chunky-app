// App-side resource sampling: the Electrobun desktop shell's OWN footprint
// (this Bun main process plus whatever helper processes hang off it), sampled
// on a 20-second interval into an in-memory ring buffer. This is about the
// shell, not the Chunky server — the server owns its own telemetry.
//
// Helper attribution is deliberately best-effort and tree-scoped: we walk this
// process's unix descendants (`pgrep -P` recursion) plus the parent launcher
// (process.ppid) and read rss/pcpu for that pid set with a single `ps` call.
// LIMITATION (macOS): WKWebView renders in `com.apple.WebKit.WebContent` XPC
// processes that are children of launchd, NOT of this process tree, so the
// webview's memory/CPU is invisible here and intentionally skipped — there is
// no cheap, reliable way to attribute an XPC service to this app without
// machine-wide scraping or name matching, both of which we refuse to do.
//
// Clock, process introspection, and the command runner are injected so the
// whole thing is unit-testable without real processes (resourceSample.test.ts),
// following the dependency style of runtimeInstaller.ts / watchScheduler.ts.

export const SAMPLE_INTERVAL_MS = 20_000
// ~3 days of 20s samples. In-memory only; nothing is persisted to disk.
export const MAX_SAMPLES = 13_000

export type ResourcePercentiles = { p50: number; p95: number; p99: number; max: number }

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
  /** Per-tick SUM over the helper process tree; all zeros when none were attributable. */
  helpers: { rssBytes: ResourcePercentiles; cpuPercent: ResourcePercentiles }
  total: { rssBytes: ResourcePercentiles; cpuPercent: ResourcePercentiles }
}

export type ResourceSample = {
  at: number
  bunRssBytes: number
  bunHeapUsedBytes: number
  bunCpuPercent: number
  helperRssBytes: number
  helperCpuPercent: number
}

type ExecResult = { exitCode: number; stdout: string }

export type ResourceSamplerDeps = {
  now(): number
  /**
   * Run a command, resolving with stdout even on a NONZERO exit: `ps -p` exits
   * 1 when any requested pid has died but still prints the surviving rows, and
   * those rows are exactly what we want. Rejections are treated as "no output".
   */
  exec(command: string[]): Promise<ExecResult>
  memoryUsage(): { rss: number; heapUsed: number }
  cpuUsage(): { user: number; system: number }
  pid: number
  ppid: number
  setIntervalFn(fn: () => void, ms: number): ReturnType<typeof setInterval>
  clearIntervalFn(handle: ReturnType<typeof setInterval>): void
}

const defaults: ResourceSamplerDeps = {
  now: () => Date.now(),
  exec: async (command) => {
    const child = Bun.spawn(command, { stdout: "pipe", stderr: "ignore" })
    const [exitCode, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()])
    return { exitCode, stdout }
  },
  memoryUsage: () => {
    const usage = process.memoryUsage()
    return { rss: usage.rss, heapUsed: usage.heapUsed }
  },
  cpuUsage: () => {
    const usage = process.cpuUsage()
    return { user: usage.user, system: usage.system }
  },
  pid: process.pid,
  ppid: process.ppid,
  setIntervalFn: (fn, ms) => {
    const handle = setInterval(fn, ms)
    handle.unref?.()
    return handle
  },
  clearIntervalFn: (handle) => clearInterval(handle),
}

/**
 * Nearest-rank percentile: for n sorted values, p% is the value at rank
 * ceil(p/100 * n) (1-based). Empty input yields all zeros rather than NaN so
 * an empty window still serializes cleanly.
 */
export function nearestRankPercentiles(values: number[]): ResourcePercentiles {
  if (values.length === 0) return { p50: 0, p95: 0, p99: 0, max: 0 }
  const sorted = [...values].sort((a, b) => a - b)
  const at = (p: number) => sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0
  return { p50: at(50), p95: at(95), p99: at(99), max: sorted[sorted.length - 1] ?? 0 }
}

/**
 * Parse `ps -o pid,rss,pcpu -p …` output into per-pid rows. Tolerates the
 * header line, blank lines, and PARTIAL output (dead pids simply have no row
 * and `ps` exits nonzero — the surviving rows are still valid). rss is KiB on
 * macOS; converted to bytes here.
 */
export function parsePsOutput(stdout: string): Array<{ pid: number; rssBytes: number; cpuPercent: number }> {
  const rows: Array<{ pid: number; rssBytes: number; cpuPercent: number }> = []
  for (const line of stdout.split("\n")) {
    const parts = line.trim().split(/\s+/)
    if (parts.length < 3) continue
    const pid = Number.parseInt(parts[0] ?? "", 10)
    const rssKiB = Number.parseFloat(parts[1] ?? "")
    const pcpu = Number.parseFloat(parts[2] ?? "")
    // The header ("PID RSS %CPU") fails these parses and is skipped naturally.
    if (!Number.isInteger(pid) || pid <= 0) continue
    if (!Number.isFinite(rssKiB) || !Number.isFinite(pcpu)) continue
    rows.push({ pid, rssBytes: Math.max(0, rssKiB) * 1024, cpuPercent: Math.max(0, pcpu) })
  }
  return rows
}

/** Recursive `pgrep -P`: every unix descendant of `pid`. pgrep exits 1 for "no children". */
async function descendantPids(exec: ResourceSamplerDeps["exec"], pid: number): Promise<number[]> {
  const found: number[] = []
  const queue = [pid]
  const seen = new Set<number>([pid])
  while (queue.length > 0) {
    const parent = queue.shift() as number
    let result: ExecResult
    try {
      result = await exec(["pgrep", "-P", String(parent)])
    } catch {
      continue
    }
    for (const token of result.stdout.split(/\s+/)) {
      const child = Number.parseInt(token, 10)
      if (!Number.isInteger(child) || child <= 0 || seen.has(child)) continue
      seen.add(child)
      found.push(child)
      queue.push(child)
    }
  }
  return found
}

/**
 * Percentile summary of the samples inside the trailing `hours` window.
 * Pure: the buffer and the clock come from the caller, so tests feed both.
 */
export function summarizeSamples(samples: ResourceSample[], hours: number, now: number): AppResourceUsage {
  const safeHours = Number.isFinite(hours) && hours > 0 ? hours : 1
  const windowMs = safeHours * 3_600_000
  const cutoff = now - windowMs
  const windowed = samples.filter((sample) => sample.at >= cutoff)
  const latest = samples[samples.length - 1]
  return {
    status: "ok",
    sampleCount: windowed.length,
    intervalMs: SAMPLE_INTERVAL_MS,
    windowMs,
    bun: {
      rssBytes: nearestRankPercentiles(windowed.map((s) => s.bunRssBytes)),
      cpuPercent: nearestRankPercentiles(windowed.map((s) => s.bunCpuPercent)),
      current: latest
        ? { rssBytes: latest.bunRssBytes, heapUsedBytes: latest.bunHeapUsedBytes, cpuPercent: latest.bunCpuPercent }
        : { rssBytes: 0, heapUsedBytes: 0, cpuPercent: 0 },
    },
    helpers: {
      rssBytes: nearestRankPercentiles(windowed.map((s) => s.helperRssBytes)),
      cpuPercent: nearestRankPercentiles(windowed.map((s) => s.helperCpuPercent)),
    },
    total: {
      rssBytes: nearestRankPercentiles(windowed.map((s) => s.bunRssBytes + s.helperRssBytes)),
      cpuPercent: nearestRankPercentiles(windowed.map((s) => s.bunCpuPercent + s.helperCpuPercent)),
    },
  }
}

export type ResourceSampler = {
  start(): void
  stop(): void
  usage(hours: number): AppResourceUsage
  /** One measurement tick; exposed for tests. Never throws. */
  sampleOnce(): Promise<void>
  /** Snapshot of the ring buffer; exposed for tests. */
  samples(): readonly ResourceSample[]
}

export function createResourceSampler(overrides: Partial<ResourceSamplerDeps> = {}): ResourceSampler {
  const deps: ResourceSamplerDeps = { ...defaults, ...overrides }
  const buffer: ResourceSample[] = []
  let timer: ReturnType<typeof setInterval> | null = null
  let sampling = false
  let lastCpu = deps.cpuUsage()
  let lastCpuAt = deps.now()

  async function measureHelpers(): Promise<{ rssBytes: number; cpuPercent: number }> {
    const pids = await descendantPids(deps.exec, deps.pid)
    // The launcher that spawned us (Electrobun's native shell) counts as a
    // helper too; pid 0/1 means we were orphaned to launchd — not ours.
    if (deps.ppid > 1) pids.push(deps.ppid)
    if (pids.length === 0) return { rssBytes: 0, cpuPercent: 0 }
    // One ps call for the whole set. Nonzero exit just means some pids died
    // between pgrep and ps; the surviving rows still parse.
    const result = await deps.exec(["ps", "-o", "pid,rss,pcpu", "-p", pids.join(",")])
    let rssBytes = 0
    let cpuPercent = 0
    for (const row of parsePsOutput(result.stdout)) {
      if (row.pid === deps.pid) continue // never double-count ourselves
      rssBytes += row.rssBytes
      cpuPercent += row.cpuPercent
    }
    return { rssBytes, cpuPercent }
  }

  async function sampleOnce(): Promise<void> {
    if (sampling) return // a slow ps must not stack ticks
    sampling = true
    try {
      const now = deps.now()
      const memory = deps.memoryUsage()
      const cpu = deps.cpuUsage()
      const elapsedMs = now - lastCpuAt
      // cpuUsage deltas are microseconds of CPU time; over elapsed wall time
      // that is a utilization percentage (can exceed 100 on multiple cores).
      const deltaMicros = Math.max(0, cpu.user - lastCpu.user) + Math.max(0, cpu.system - lastCpu.system)
      const bunCpuPercent = elapsedMs > 0 ? (deltaMicros / (elapsedMs * 1000)) * 100 : 0
      lastCpu = cpu
      lastCpuAt = now

      let helpers = { rssBytes: 0, cpuPercent: 0 }
      try {
        helpers = await measureHelpers()
      } catch {
        // Best-effort only: pgrep/ps trouble degrades to zero helpers.
      }

      buffer.push({
        at: now,
        bunRssBytes: memory.rss,
        bunHeapUsedBytes: memory.heapUsed,
        bunCpuPercent,
        helperRssBytes: helpers.rssBytes,
        helperCpuPercent: helpers.cpuPercent,
      })
      if (buffer.length > MAX_SAMPLES) buffer.splice(0, buffer.length - MAX_SAMPLES)
    } catch {
      // A tick must never throw out of the interval.
    } finally {
      sampling = false
    }
  }

  return {
    start() {
      if (timer) return
      lastCpu = deps.cpuUsage()
      lastCpuAt = deps.now()
      timer = deps.setIntervalFn(() => void sampleOnce(), SAMPLE_INTERVAL_MS)
    },
    stop() {
      if (timer) deps.clearIntervalFn(timer)
      timer = null
    },
    usage(hours: number): AppResourceUsage {
      return summarizeSamples(buffer, hours, deps.now())
    },
    sampleOnce,
    samples: () => buffer,
  }
}

// ---- module singleton used by src/bun/index.ts -----------------------------

let singleton: ResourceSampler | null = null

export function startAppResourceSampler(): void {
  if (!singleton) singleton = createResourceSampler()
  singleton.start()
}

export function stopAppResourceSampler(): void {
  singleton?.stop()
}

export function appResourceUsage(hours: number): AppResourceUsage {
  if (!singleton) return summarizeSamples([], hours, Date.now())
  return singleton.usage(hours)
}
