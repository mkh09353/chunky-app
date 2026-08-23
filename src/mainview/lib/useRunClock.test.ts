import { beforeEach, describe, expect, test } from "bun:test"
import type { RunRecord } from "./transcript"
import {
  noteRunTimings,
  resetRunTimings,
  runElapsed,
  runTimingsSize,
  RUN_TIMINGS_MAX,
} from "./useRunClock"

function run(id: string, status: RunRecord["status"] = "running"): RunRecord {
  return {
    id,
    threadId: id.split("#")[0]!,
    parentId: "main",
    title: "Sidekick",
    status,
    anchorIndex: 0,
    itemStart: 0,
    toolCount: 0,
  }
}

describe("run clock store", () => {
  beforeEach(() => resetRunTimings())

  test("elapsed survives switching sessions and coming back", () => {
    const live = run("sk#0")
    noteRunTimings("s1", [live], 1_000)
    // Reader switches to another session (ChatView remounts and clocks ITS runs)…
    noteRunTimings("s2", [run("other#0")], 5_000)
    // …then comes back: the original start time is still there.
    expect(noteRunTimings("s1", [live], 9_000)).toBe(true)
    expect(runElapsed("s1", live, 9_000)).toBe(8_000)
  })

  test("run ids are scoped per session", () => {
    noteRunTimings("s1", [run("sk#0")], 1_000)
    noteRunTimings("s2", [run("sk#0")], 4_000)
    expect(runElapsed("s1", run("sk#0"), 5_000)).toBe(4_000)
    expect(runElapsed("s2", run("sk#0"), 5_000)).toBe(1_000)
  })

  test("a settled run freezes, and a run first seen settled stays untimed", () => {
    const r = run("sk#0")
    noteRunTimings("s1", [r], 1_000)
    expect(noteRunTimings("s1", [run("sk#0", "done")], 3_000)).toBe(false)
    expect(runElapsed("s1", r, 99_000)).toBe(2_000)

    // Replayed history: never seen running, so no invented duration.
    noteRunTimings("s1", [run("old#0", "done")], 4_000)
    expect(runElapsed("s1", run("old#0"), 4_000)).toBeUndefined()
  })

  test("the store is bounded, evicting settled runs first", () => {
    for (let i = 0; i < RUN_TIMINGS_MAX; i++) {
      noteRunTimings("s1", [run(`done#${i}`)], 1_000)
      noteRunTimings("s1", [run(`done#${i}`, "done")], 1_100)
    }
    const live = run("live#0")
    noteRunTimings("s1", [live], 2_000)
    expect(runTimingsSize()).toBeLessThanOrEqual(RUN_TIMINGS_MAX)
    // The still-running one is what the UI needs, so it outlives the settled.
    expect(runElapsed("s1", live, 3_000)).toBe(1_000)
  })
})
