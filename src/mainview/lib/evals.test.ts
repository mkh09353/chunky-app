import { describe, expect, test } from "bun:test"
import {
  briefSections,
  durationLabel,
  formatBytes,
  hasRunningReplay,
  modelKey,
  modelLine,
  parseTranscript,
  promotedBadgeLabel,
  ratingTone,
  replayStatusLabel,
  replayStatusTone,
  replayTimingLabel,
  statsLine,
  subScoreLine,
  taskLine,
} from "./evals"
import type { EvalReplaySummary } from "./evals"

describe("formatBytes", () => {
  test("scales and rounds", () => {
    expect(formatBytes(0)).toBe("0 B")
    expect(formatBytes(-5)).toBe("0 B")
    expect(formatBytes(900)).toBe("900 B")
    expect(formatBytes(1024 * 1024 * 1.25)).toBe("1.3 MB")
    expect(formatBytes(1024 ** 3 * 1.2)).toBe("1.2 GB")
  })
})

describe("statsLine", () => {
  test("renders the settings usage line", () => {
    expect(statsLine({ candidates: 312, promoted: 47, bytes: 1024 ** 3 * 1.2 })).toBe(
      "312 candidates · 47 promoted · 1.2 GB",
    )
  })
  test("singularizes and tolerates junk", () => {
    expect(statsLine({ candidates: 1, promoted: 0, bytes: Number.NaN })).toBe(
      "1 candidate · 0 promoted · 0 B",
    )
  })
})

describe("subScoreLine", () => {
  const base = {
    compliance: 3,
    correctness: 2,
    report: 2,
    exceeded: 0,
    rework: false,
    reason: "",
    rating: 8,
    judgeProvider: "zen",
    judgeModel: "m",
    ts: 0,
  }
  test("omits exceeded when zero", () => {
    expect(subScoreLine(base)).toBe("c 3/3 · x 2/3 · r 2/2")
  })
  test("includes exceeded when earned", () => {
    expect(subScoreLine({ ...base, exceeded: 1 })).toBe("c 3/3 · x 2/3 · r 2/2 · +1")
  })
})

describe("ratingTone / modelLine / taskLine", () => {
  test("tones", () => {
    expect(ratingTone(undefined)).toBe("muted")
    expect(ratingTone(9)).toBe("success")
    expect(ratingTone(6)).toBe("warning")
    expect(ratingTone(3)).toBe("destructive")
  })
  test("model line drops empty parts", () => {
    expect(modelLine({ provider: "zen", model: "gpt", effort: undefined })).toBe("zen · gpt")
  })
  test("task line collapses whitespace and truncates", () => {
    expect(taskLine("  a\n b  ")).toBe("a b")
    expect(taskLine("", 10)).toBe("Untitled brief")
    expect(taskLine("abcdefghijkl", 6)).toBe("abcde…")
  })
})

describe("briefSections", () => {
  test("orders and filters", () => {
    const sections = briefSections({
      task: "Do it",
      constraints: ["one", "  ", "two"],
      done_when: "tests pass",
      pointers: "",
    })
    expect(sections.map((s) => s.label)).toEqual(["Task", "Constraints", "Done when"])
    expect(sections[1]!.values).toEqual(["one", "two"])
  })
  test("empty without a struct", () => {
    expect(briefSections(undefined)).toEqual([])
  })
})

describe("promotedBadgeLabel", () => {
  test("nothing for an unpromoted candidate", () => {
    expect(promotedBadgeLabel(false, undefined)).toBe(null)
    // A stale bucket on an unpromoted row must still read as not promoted.
    expect(promotedBadgeLabel(false, "hard")).toBe(null)
  })
  test("names the server's bucket, or stays plain without one", () => {
    expect(promotedBadgeLabel(true, "regression")).toBe("promoted · regression")
    expect(promotedBadgeLabel(true, undefined)).toBe("promoted")
  })
})

describe("replay helpers", () => {
  const run = (over: Partial<EvalReplaySummary> = {}): EvalReplaySummary => ({
    replayId: "r1",
    provider: "zen",
    model: "glm-4.6",
    status: "running",
    startedAt: 1_000,
    ...over,
  })

  test("hasRunningReplay drives the poll", () => {
    expect(hasRunningReplay([])).toBe(false)
    expect(hasRunningReplay([run({ status: "done", ok: true })])).toBe(false)
    expect(hasRunningReplay([run({ status: "done", ok: true }), run()])).toBe(true)
  })

  test("status label splits done on ok", () => {
    expect(replayStatusLabel(run())).toBe("running")
    expect(replayStatusLabel(run({ status: "done", ok: true }))).toBe("ok")
    expect(replayStatusLabel(run({ status: "done", ok: false }))).toBe("failed")
    expect(replayStatusLabel(run({ status: "error" }))).toBe("error")
  })

  test("status tones", () => {
    expect(replayStatusTone(run())).toBe("muted")
    expect(replayStatusTone(run({ status: "done", ok: true }))).toBe("success")
    expect(replayStatusTone(run({ status: "done", ok: false }))).toBe("warning")
    expect(replayStatusTone(run({ status: "error" }))).toBe("destructive")
  })

  test("durations", () => {
    expect(durationLabel(0, 12_000)).toBe("12s")
    expect(durationLabel(0, 243_000)).toBe("4m 03s")
    expect(durationLabel(0, 4_320_000)).toBe("1h 12m")
    expect(durationLabel(10, 0)).toBe("—")
  })

  test("timing line reads live vs finished", () => {
    expect(replayTimingLabel(run(), 6_000)).toBe("running for 5s")
    expect(replayTimingLabel(run({ status: "done", ok: true, completedAt: 61_000 }), 0)).toBe(
      "took 1m 00s",
    )
    // A finished run the server gave no completion time for.
    expect(replayTimingLabel(run({ status: "error" }), 0)).toBe("finished")
  })

  test("modelKey needs both halves", () => {
    expect(modelKey("zen", "glm-4.6")).toBe("zen/glm-4.6")
    expect(modelKey("zen", undefined)).toBe("")
    expect(modelKey(undefined, "glm-4.6")).toBe("")
  })
})

describe("parseTranscript", () => {
  const line = (seq: number, event: unknown) =>
    JSON.stringify({ seq, json: JSON.stringify(event) })

  test("parses events and coalesces assistant deltas", () => {
    const text = [
      line(1, { type: "message.user", text: "hello" }),
      line(2, { type: "message.start", role: "assistant" }),
      line(3, { type: "message.delta", text: "abc" }),
      line(4, { type: "message.delta", text: "def" }),
      line(5, { type: "tool.start", name: "bash", input: { command: "ls" } }),
      line(6, { type: "tool.end", ok: true, output: "a\nb" }),
    ].join("\n")
    const rows = parseTranscript(text)
    expect(rows.map((r) => r.label)).toEqual(["user", "assistant", "tool bash", "tool ok"])
    expect(rows[1]!.detail).toBe("abcdef")
    expect(rows[3]!.ok).toBe(true)
    expect(rows[0]!.seq).toBe(1)
  })

  test("failed tools carry ok=false", () => {
    const rows = parseTranscript(line(9, { type: "tool.end", ok: false, output: "boom" }))
    expect(rows[0]!.label).toBe("tool failed")
    expect(rows[0]!.ok).toBe(false)
  })

  test("degrades to raw rows on unparseable lines", () => {
    const rows = parseTranscript(`not json\n${line(2, { type: "message.user", text: "hi" })}\n`)
    expect(rows[0]!.kind).toBe("raw")
    expect(rows[0]!.detail).toBe("not json")
    expect(rows[1]!.kind).toBe("user")
  })

  test("accepts a bare event line and ignores blanks", () => {
    const rows = parseTranscript(`\n${JSON.stringify({ type: "message.user", text: "hi" })}\n\n`)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.kind).toBe("user")
    expect(rows[0]!.seq).toBe(null)
  })

  test("previews are single-line and bounded", () => {
    const rows = parseTranscript(line(1, { type: "message.delta", text: `${"x".repeat(500)}\ny` }))
    expect(rows[0]!.preview.length).toBeLessThanOrEqual(200)
    expect(rows[0]!.preview).not.toContain("\n")
  })
})
