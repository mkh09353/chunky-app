// Renderer-side watch helpers: which watches still owe a synthesis, and how a
// check reads in the UI. No network, no RPC — these are the pure parts.
// Run with: bun test src/mainview/lib/zooWatch.test.ts
import { describe, expect, it } from "bun:test"
import { needsSynthesis, summarizeCheck, watchStatusLabel } from "./zooWatch"
import type { ZooRepoWatch, ZooWatchResult } from "./zoo"

const watch = (over: Partial<ZooRepoWatch> = {}): ZooRepoWatch => ({
  id: "w-1",
  sourceId: "s-1",
  owner: "sst",
  name: "opencode",
  label: "sst/opencode",
  createdAt: 1000,
  ...over,
})

const result = (over: Partial<ZooWatchResult> = {}): ZooWatchResult => ({
  watchId: "w-1",
  label: "sst/opencode",
  status: "ok",
  added: 0,
  ...over,
})

describe("needsSynthesis", () => {
  it("is false until a check has actually stored something", () => {
    expect(needsSynthesis(watch())).toBe(false)
    expect(needsSynthesis(watch({ lastExtractAt: 5000 }))).toBe(false)
  })

  it("is true for a delta no extraction pass has read", () => {
    expect(needsSynthesis(watch({ lastArtifactAt: 5000 }))).toBe(true)
    expect(needsSynthesis(watch({ lastArtifactAt: 5000, lastExtractAt: 4000 }))).toBe(true)
  })

  it("is false once the pass has caught up", () => {
    expect(needsSynthesis(watch({ lastArtifactAt: 5000, lastExtractAt: 5000 }))).toBe(false)
    expect(needsSynthesis(watch({ lastArtifactAt: 5000, lastExtractAt: 6000 }))).toBe(false)
  })
})

describe("watchStatusLabel", () => {
  const now = 10_000_000

  it("says so plainly before the first check", () => {
    expect(watchStatusLabel(watch(), now)).toBe("Never checked")
  })

  it("reports the last good check with what it found", () => {
    const label = watchStatusLabel(
      watch({ lastStatus: "ok", lastNote: "Recorded 2 releases", lastCheckAt: now - 3600_000 }),
      now,
    )
    expect(label).toBe("Recorded 2 releases · 1h")
  })

  it("surfaces a skip and a failure as themselves, not as success", () => {
    expect(watchStatusLabel(watch({ lastStatus: "skipped", lastNote: "GitHub rate limit reached" }), now)).toBe(
      "Skipped — GitHub rate limit reached",
    )
    expect(watchStatusLabel(watch({ lastStatus: "error", lastNote: "Repository not found (or private)" }), now)).toBe(
      "Failed — Repository not found (or private)",
    )
  })
})

describe("summarizeCheck", () => {
  it("describes an empty watchlist without pretending work happened", () => {
    expect(summarizeCheck([])).toBe("Nothing to check yet.")
  })

  it("counts new deltas, skips and failures together", () => {
    expect(summarizeCheck([result(), result()])).toBe("no new activity")
    expect(summarizeCheck([result({ added: 1 }), result({ added: 2 })])).toBe("3 new deltas")
    expect(
      summarizeCheck([
        result({ added: 1 }),
        result({ status: "skipped", note: "rate limited" }),
        result({ status: "error", note: "gone" }),
      ]),
    ).toBe("1 new delta · 1 skipped · 1 failed")
  })
})
