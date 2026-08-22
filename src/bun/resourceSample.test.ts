// App-side resource sampling: percentile math, ring-buffer windowing, ps/pgrep
// parsing (including partial output from dead pids), and the empty-window
// response shape. Everything runs on injected fakes — no real processes.
// Run with: bun test src/bun/resourceSample.test.ts
import { describe, expect, it } from "bun:test"
import {
  createResourceSampler,
  MAX_SAMPLES,
  nearestRankPercentiles,
  parsePsOutput,
  SAMPLE_INTERVAL_MS,
  summarizeSamples,
  type ResourceSample,
  type ResourceSamplerDeps,
} from "./resourceSample"

const HOUR = 3_600_000

function sampleAt(at: number, overrides: Partial<ResourceSample> = {}): ResourceSample {
  return {
    at,
    bunRssBytes: 100,
    bunHeapUsedBytes: 50,
    bunCpuPercent: 1,
    helperRssBytes: 10,
    helperCpuPercent: 0.5,
    ...overrides,
  }
}

describe("nearestRankPercentiles", () => {
  it("returns zeros for an empty list", () => {
    expect(nearestRankPercentiles([])).toEqual({ p50: 0, p95: 0, p99: 0, max: 0 })
  })

  it("uses nearest-rank (ceil) on 1..100", () => {
    const values = Array.from({ length: 100 }, (_, i) => i + 1)
    expect(nearestRankPercentiles(values)).toEqual({ p50: 50, p95: 95, p99: 99, max: 100 })
  })

  it("collapses to the single value for one sample", () => {
    expect(nearestRankPercentiles([7])).toEqual({ p50: 7, p95: 7, p99: 7, max: 7 })
  })

  it("sorts unordered input and rounds ranks up", () => {
    // n=4: p50 → rank ceil(2)=2, p95 → rank ceil(3.8)=4, p99 → rank 4.
    expect(nearestRankPercentiles([40, 10, 30, 20])).toEqual({ p50: 20, p95: 40, p99: 40, max: 40 })
  })

  it("does not mutate its input", () => {
    const values = [3, 1, 2]
    nearestRankPercentiles(values)
    expect(values).toEqual([3, 1, 2])
  })
})

describe("parsePsOutput", () => {
  it("parses rows, skipping the header, and converts KiB rss to bytes", () => {
    const rows = parsePsOutput("  PID    RSS  %CPU\n  123  2048   1.5\n  456    10   0.0\n")
    expect(rows).toEqual([
      { pid: 123, rssBytes: 2048 * 1024, cpuPercent: 1.5 },
      { pid: 456, rssBytes: 10 * 1024, cpuPercent: 0 },
    ])
  })

  it("keeps surviving rows from partial output (dead pids, nonzero exit)", () => {
    // ps exits 1 when a requested pid vanished; the row simply isn't printed.
    const rows = parsePsOutput("  PID    RSS  %CPU\n  999  1024   0.3\n")
    expect(rows).toEqual([{ pid: 999, rssBytes: 1024 * 1024, cpuPercent: 0.3 }])
  })

  it("ignores blank lines and garbage", () => {
    expect(parsePsOutput("\n\nnot a row\n- - -\n")).toEqual([])
    expect(parsePsOutput("")).toEqual([])
  })
})

describe("summarizeSamples", () => {
  const NOW = 1_000 * HOUR

  it("returns the zero-sample shape for an empty buffer", () => {
    const usage = summarizeSamples([], 24, NOW)
    expect(usage.status).toBe("ok")
    expect(usage.sampleCount).toBe(0)
    expect(usage.intervalMs).toBe(SAMPLE_INTERVAL_MS)
    expect(usage.windowMs).toBe(24 * HOUR)
    const zeros = { p50: 0, p95: 0, p99: 0, max: 0 }
    expect(usage.bun.rssBytes).toEqual(zeros)
    expect(usage.bun.cpuPercent).toEqual(zeros)
    expect(usage.bun.current).toEqual({ rssBytes: 0, heapUsedBytes: 0, cpuPercent: 0 })
    expect(usage.helpers.rssBytes).toEqual(zeros)
    expect(usage.helpers.cpuPercent).toEqual(zeros)
    expect(usage.total.rssBytes).toEqual(zeros)
    expect(usage.total.cpuPercent).toEqual(zeros)
  })

  it("filters to the trailing window", () => {
    const samples = [
      sampleAt(NOW - 3 * HOUR, { bunRssBytes: 999 }), // outside a 2h window
      sampleAt(NOW - 1 * HOUR, { bunRssBytes: 100 }),
      sampleAt(NOW - 1, { bunRssBytes: 200 }),
    ]
    const usage = summarizeSamples(samples, 2, NOW)
    expect(usage.sampleCount).toBe(2)
    expect(usage.windowMs).toBe(2 * HOUR)
    expect(usage.bun.rssBytes.max).toBe(200)
    expect(usage.bun.rssBytes.p50).toBe(100)
  })

  it("sums bun + helpers into total, per tick", () => {
    const samples = [
      sampleAt(NOW - 1, { bunRssBytes: 100, helperRssBytes: 30, bunCpuPercent: 2, helperCpuPercent: 1 }),
    ]
    const usage = summarizeSamples(samples, 1, NOW)
    expect(usage.total.rssBytes.max).toBe(130)
    expect(usage.total.cpuPercent.max).toBe(3)
    expect(usage.helpers.rssBytes.max).toBe(30)
  })

  it("reports current from the latest sample even when it falls outside the window", () => {
    const samples = [sampleAt(NOW - 5 * HOUR, { bunRssBytes: 42, bunHeapUsedBytes: 21, bunCpuPercent: 7 })]
    const usage = summarizeSamples(samples, 1, NOW)
    expect(usage.sampleCount).toBe(0)
    expect(usage.bun.current).toEqual({ rssBytes: 42, heapUsedBytes: 21, cpuPercent: 7 })
  })

  it("defaults a nonsense window to one hour", () => {
    expect(summarizeSamples([], 0, NOW).windowMs).toBe(HOUR)
    expect(summarizeSamples([], Number.NaN, NOW).windowMs).toBe(HOUR)
  })
})

/** Sampler harness: fake clock, fake process stats, scripted pgrep/ps. */
function harness(options: {
  exec?: ResourceSamplerDeps["exec"]
  rss?: number
  heapUsed?: number
  pid?: number
  ppid?: number
} = {}) {
  let clock = 1_000_000
  let cpu = { user: 0, system: 0 }
  const deps: Partial<ResourceSamplerDeps> = {
    now: () => clock,
    exec: options.exec ?? (async () => ({ exitCode: 1, stdout: "" })),
    memoryUsage: () => ({ rss: options.rss ?? 1_000, heapUsed: options.heapUsed ?? 500 }),
    cpuUsage: () => cpu,
    pid: options.pid ?? 100,
    ppid: options.ppid ?? 0,
    setIntervalFn: () => 0 as unknown as ReturnType<typeof setInterval>,
    clearIntervalFn: () => {},
  }
  const sampler = createResourceSampler(deps)
  return {
    sampler,
    advance(ms: number, cpuMicros = 0) {
      clock += ms
      cpu = { user: cpu.user + cpuMicros, system: cpu.system }
    },
  }
}

describe("createResourceSampler", () => {
  it("computes bun CPU% from the cpuUsage delta over wall time", async () => {
    const h = harness()
    h.sampler.start()
    // 20s elapsed, 2s of CPU time → 10%.
    h.advance(20_000, 2_000_000)
    await h.sampler.sampleOnce()
    const [sample] = h.sampler.samples()
    expect(sample?.bunCpuPercent).toBeCloseTo(10)
    expect(sample?.bunRssBytes).toBe(1_000)
    expect(sample?.bunHeapUsedBytes).toBe(500)
  })

  it("walks pgrep descendants + the launcher ppid and sums one ps call", async () => {
    const calls: string[][] = []
    const h = harness({
      pid: 100,
      ppid: 42,
      exec: async (command) => {
        calls.push(command)
        if (command[0] === "pgrep") {
          if (command[2] === "100") return { exitCode: 0, stdout: "200\n201\n" }
          if (command[2] === "200") return { exitCode: 0, stdout: "300\n" }
          return { exitCode: 1, stdout: "" } // no children
        }
        // 201 died between pgrep and ps: nonzero exit, partial rows.
        return {
          exitCode: 1,
          stdout: "  PID    RSS  %CPU\n  200  1024   1.0\n  300    10   0.5\n   42  2048   0.25\n",
        }
      },
    })
    h.sampler.start()
    h.advance(20_000)
    await h.sampler.sampleOnce()

    const psCalls = calls.filter((c) => c[0] === "ps")
    expect(psCalls).toHaveLength(1)
    expect(psCalls[0]?.[4]?.split(",").sort()).toEqual(["200", "201", "300", "42"])

    const [sample] = h.sampler.samples()
    expect(sample?.helperRssBytes).toBe((1024 + 10 + 2048) * 1024)
    expect(sample?.helperCpuPercent).toBeCloseTo(1.75)
  })

  it("records zero helpers when exec fails, without throwing", async () => {
    const h = harness({
      ppid: 42,
      exec: async () => {
        throw new Error("spawn failed")
      },
    })
    h.sampler.start()
    h.advance(20_000)
    await h.sampler.sampleOnce()
    const [sample] = h.sampler.samples()
    expect(sample?.helperRssBytes).toBe(0)
    expect(sample?.helperCpuPercent).toBe(0)
  })

  it("caps the ring buffer at MAX_SAMPLES, dropping the oldest", async () => {
    const h = harness()
    h.sampler.start()
    const extra = 5
    for (let i = 0; i < MAX_SAMPLES + extra; i++) {
      h.advance(20_000)
      await h.sampler.sampleOnce()
    }
    const samples = h.sampler.samples()
    expect(samples).toHaveLength(MAX_SAMPLES)
    // The first `extra` ticks were evicted: the oldest surviving sample is tick extra+1.
    expect(samples[0]?.at).toBe(1_000_000 + (extra + 1) * 20_000)
  })

  it("usage() windows the buffer against the injected clock", async () => {
    const h = harness()
    h.sampler.start()
    h.advance(20_000)
    await h.sampler.sampleOnce()
    h.advance(2 * HOUR)
    await h.sampler.sampleOnce()
    const usage = h.sampler.usage(1)
    expect(usage.sampleCount).toBe(1) // only the recent tick is inside 1h
    expect(usage.status).toBe("ok")
  })
})
