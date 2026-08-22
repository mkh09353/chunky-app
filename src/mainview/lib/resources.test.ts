import { describe, expect, test } from "bun:test"
import { getResourceUsage } from "./api"
import { appResourcesAvailable, fetchAppResourceUsage } from "./appResources"
import {
  asResourceUsage,
  cpuLabel,
  peakContextLabel,
  rssLabel,
  type ResourceUsageResponse,
} from "./stats"

const OK_BODY = {
  status: "ok",
  sampleCount: 288,
  intervalMs: 5000,
  windowMs: 86_400_000,
  server: {
    rssBytes: { p50: 300_000_000, p95: 500_000_000, p99: 700_000_000, max: 800_000_000 },
    cpuPercent: { p50: 4, p95: 40, p99: 90, max: 130 },
    current: { rssBytes: 320_000_000, heapUsedBytes: 180_000_000, cpuPercent: 3.4 },
  },
  children: {
    rssBytes: { p50: 100_000_000, p95: 900_000_000, p99: 4_000_000_000, max: 4_500_000_000 },
    cpuPercent: { p50: 1, p95: 60, p99: 180, max: 240 },
  },
  total: {
    rssBytes: { p50: 400_000_000, p95: 1_400_000_000, p99: 5_368_709_120, max: 5_600_000_000 },
    cpuPercent: { p50: 5, p95: 100, p99: 270, max: 370 },
  },
  peaks: [
    {
      ts: 1_700_000_000_000,
      totalRssBytes: 1_000_000_000,
      serverRssBytes: 400_000_000,
      cpuPercent: 55,
      activeSessions: 2,
      liveTasks: 1,
      liveDelegates: 0,
      topTasks: [
        { taskId: "t1", sessionId: "s1", command: "bun test", rssBytes: 200_000_000 },
        { taskId: "t2", sessionId: "s1", command: "vite build", rssBytes: 900_000_000 },
      ],
    },
    {
      ts: 1_700_000_600_000,
      totalRssBytes: 5_368_709_120,
      serverRssBytes: 700_000_000,
      cpuPercent: 270,
      activeSessions: 4,
      liveTasks: 3,
      liveDelegates: 2,
      topTasks: [{ taskId: "t9", sessionId: "s2", command: "cargo build", rssBytes: 4_000_000_000 }],
    },
  ],
}

describe("asResourceUsage — ok payload", () => {
  const parsed = asResourceUsage(OK_BODY)

  test("keeps the headline numbers", () => {
    expect(parsed.status).toBe("ok")
    expect(parsed.sampleCount).toBe(288)
    expect(parsed.intervalMs).toBe(5000)
    expect(parsed.windowMs).toBe(86_400_000)
    expect(parsed.server.current.rssBytes).toBe(320_000_000)
    expect(parsed.server.current.heapUsedBytes).toBe(180_000_000)
    expect(parsed.total.rssBytes.p99).toBe(5_368_709_120)
    expect(parsed.children.cpuPercent.max).toBe(240)
  })

  test("orders peaks by total RSS and their tasks by size", () => {
    expect(parsed.peaks.map((p) => p.totalRssBytes)).toEqual([5_368_709_120, 1_000_000_000])
    expect(parsed.peaks[1]!.topTasks.map((t) => t.command)).toEqual(["vite build", "bun test"])
  })

  test("keeps peak context counts, including zero", () => {
    expect(peakContextLabel(parsed.peaks[0]!)).toBe("4 sessions · 3 tasks · 2 delegates")
    expect(peakContextLabel(parsed.peaks[1]!)).toBe("2 sessions · 1 task · 0 delegates")
  })
})

describe("asResourceUsage — malformed payloads", () => {
  test("null / non-object bodies become an empty, renderable payload", () => {
    for (const body of [null, undefined, 42, "nope", []]) {
      const parsed = asResourceUsage(body)
      expect(parsed.sampleCount).toBe(0)
      expect(parsed.peaks).toEqual([])
      expect(parsed.total.rssBytes).toEqual({ p50: 0, p95: 0, p99: 0, max: 0 })
      expect(parsed.server.current.cpuPercent).toBe(0)
    }
  })

  test("string numbers are coerced; junk, NaN and negatives become 0", () => {
    const parsed = asResourceUsage({
      sampleCount: "12",
      intervalMs: "5000",
      windowMs: null,
      server: {
        rssBytes: { p50: "1024", p95: "oops", p99: Number.NaN, max: -5 },
        current: { rssBytes: "2048", heapUsedBytes: {}, cpuPercent: "7.5" },
      },
      total: { rssBytes: { p95: "4096" } },
      peaks: "not an array",
    })
    expect(parsed.sampleCount).toBe(12)
    expect(parsed.intervalMs).toBe(5000)
    expect(parsed.windowMs).toBe(0)
    expect(parsed.server.rssBytes).toEqual({ p50: 1024, p95: 0, p99: 0, max: 0 })
    expect(parsed.server.current).toEqual({ rssBytes: 2048, heapUsedBytes: 0, cpuPercent: 7.5 })
    expect(parsed.total.rssBytes.p95).toBe(4096)
    expect(parsed.peaks).toEqual([])
  })

  test("drops peaks without a timestamp and tasks without identity", () => {
    const parsed = asResourceUsage({
      sampleCount: 3,
      peaks: [
        { totalRssBytes: 10 },
        { ts: 0, totalRssBytes: 10 },
        null,
        {
          ts: 1_700_000_000_000,
          totalRssBytes: "500",
          topTasks: [{}, null, { command: "bun run build" }, { taskId: "t3" }],
        },
      ],
    })
    expect(parsed.peaks).toHaveLength(1)
    const peak = parsed.peaks[0]!
    expect(peak.totalRssBytes).toBe(500)
    expect(peak.topTasks.map((t) => t.command)).toEqual(["bun run build", ""])
    expect(peak.topTasks[1]!.taskId).toBe("t3")
  })

  test("missing context counts stay null and drop out of the label", () => {
    const parsed = asResourceUsage({
      peaks: [{ ts: 1, liveTasks: 2 }],
    })
    const peak = parsed.peaks[0]!
    expect(peak.activeSessions).toBeNull()
    expect(peak.liveDelegates).toBeNull()
    expect(peakContextLabel(peak)).toBe("2 tasks")
  })
})

describe("asResourceUsage — zero samples", () => {
  test("an empty window parses to the collecting state", () => {
    const parsed: ResourceUsageResponse = asResourceUsage({
      status: "ok",
      sampleCount: 0,
      intervalMs: 5000,
      windowMs: 86_400_000,
      server: {
        rssBytes: { p50: 0, p95: 0, p99: 0, max: 0 },
        cpuPercent: { p50: 0, p95: 0, p99: 0, max: 0 },
        current: { rssBytes: 0, heapUsedBytes: 0, cpuPercent: 0 },
      },
      children: { rssBytes: {}, cpuPercent: {} },
      total: { rssBytes: {}, cpuPercent: {} },
      peaks: [],
    })
    expect(parsed.sampleCount).toBe(0)
    expect(parsed.peaks).toEqual([])
  })
})

describe("formatting", () => {
  test("rssLabel uses binary units", () => {
    expect(rssLabel(0)).toBe("0 B")
    expect(rssLabel(-1)).toBe("0 B")
    expect(rssLabel(900)).toBe("900 B")
    expect(rssLabel(1024 * 1024 * 512)).toBe("512 MiB")
    expect(rssLabel(1024 ** 3 * 5)).toBe("5 GiB")
    expect(rssLabel(1024 ** 3 * 1.25)).toBe("1.3 GiB")
    expect(rssLabel(Number.NaN)).toBe("0 B")
  })

  test("cpuLabel is a percentage that may exceed one core", () => {
    expect(cpuLabel(0)).toBe("0%")
    expect(cpuLabel(3.44)).toBe("3.4%")
    expect(cpuLabel(270)).toBe("270%")
    expect(cpuLabel(Number.NaN)).toBe("0%")
  })
})

describe("getResourceUsage", () => {
  const withFetch = async (
    impl: (url: string) => Promise<Response> | Response,
    run: () => Promise<void>,
  ) => {
    const original = globalThis.fetch
    globalThis.fetch = ((input: RequestInfo | URL) =>
      Promise.resolve(impl(String(input)))) as typeof fetch
    try {
      await run()
    } finally {
      globalThis.fetch = original
    }
  }

  test("requests the literal route with the hours window", async () => {
    let seen = ""
    await withFetch(
      (url) => {
        seen = url
        return new Response(JSON.stringify(OK_BODY), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      },
      async () => {
        const result = await getResourceUsage("http://localhost:4620", 168)
        expect(result.status).toBe("ok")
        expect(seen).toBe("http://localhost:4620/api/usage/resources?hours=168")
      },
    )
  })

  test("defaults to 24 hours and rejects nonsense windows", async () => {
    const seen: string[] = []
    await withFetch(
      (url) => {
        seen.push(url)
        return new Response("{}", { status: 200 })
      },
      async () => {
        await getResourceUsage("http://x", undefined)
        await getResourceUsage("http://x", 0)
        await getResourceUsage("http://x", Number.NaN)
        expect(seen).toEqual([
          "http://x/api/usage/resources?hours=24",
          "http://x/api/usage/resources?hours=24",
          "http://x/api/usage/resources?hours=24",
        ])
      },
    )
  })

  test("404 and 501 are unsupported, not errors", async () => {
    await withFetch(
      () => new Response("not found", { status: 404 }),
      async () => {
        expect(await getResourceUsage("http://x")).toEqual({ status: "unsupported" })
      },
    )
    await withFetch(
      () => new Response("nope", { status: 501 }),
      async () => {
        expect(await getResourceUsage("http://x")).toEqual({ status: "unsupported" })
      },
    )
  })

  test("a network failure degrades to unsupported", async () => {
    const original = globalThis.fetch
    globalThis.fetch = (() => Promise.reject(new Error("Load failed"))) as unknown as typeof fetch
    try {
      expect(await getResourceUsage("http://x")).toEqual({ status: "unsupported" })
    } finally {
      globalThis.fetch = original
    }
  })

  test("no base URL is unsupported", async () => {
    expect(await getResourceUsage("")).toEqual({ status: "unsupported" })
  })

  test("a server error surfaces its message", async () => {
    await withFetch(
      () =>
        new Response(JSON.stringify({ error: "sampler disabled" }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        }),
      async () => {
        expect(await getResourceUsage("http://x")).toEqual({
          status: "error",
          message: "sampler disabled",
        })
      },
    )
  })

  test("a 200 with an unparseable body still parses to an empty payload", async () => {
    await withFetch(
      () => new Response("<html>", { status: 200 }),
      async () => {
        const result = await getResourceUsage("http://x")
        expect(result.status).toBe("ok")
        if (result.status !== "ok") return
        expect(asResourceUsage(result.body).sampleCount).toBe(0)
      },
    )
  })
})

/** The App half of the Resources section leans on this degrading quietly: with
 *  no Electrobun RPC (web/dev build, and this test runner) it must resolve to
 *  "unavailable" rather than throw, which is what makes the block render
 *  nothing. The sampler itself is covered by src/bun/resourceSample.test.ts. */
describe("fetchAppResourceUsage — without RPC", () => {
  test("reports unavailable instead of throwing", async () => {
    expect(appResourcesAvailable()).toBe(false)
    expect(await fetchAppResourceUsage(168)).toEqual({ status: "unavailable" })
  })
})
