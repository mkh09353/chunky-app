import { describe, expect, test } from "bun:test"
import { normalizeXHandleInput, summarizeXCheck, xWatchNeedsExtraction, xWatchStatusLabel } from "./zooXWatch"
import type { ZooXWatch } from "./zoo"

const watch = (patch: Partial<ZooXWatch> = {}): ZooXWatch => ({ id: "x", sourceId: "s", handle: "theo", label: "@theo", createdAt: 1, ...patch })
describe("X-watch renderer helpers", () => {
  test("normalizes composer input", () => { expect(normalizeXHandleInput("  @@Theo ")).toBe("Theo") })
  test("tracks pending extraction", () => { expect(xWatchNeedsExtraction(watch())).toBe(false); expect(xWatchNeedsExtraction(watch({ lastArtifactAt: 5 }))).toBe(true); expect(xWatchNeedsExtraction(watch({ lastArtifactAt: 5, lastExtractAt: 5 }))).toBe(false) })
  test("surfaces errors, last success, and summaries", () => { expect(xWatchStatusLabel(watch())).toBe("Never checked"); expect(xWatchStatusLabel(watch({ lastStatus: "error", lastNote: "Grok unavailable", lastSuccessAt: 1 }), 2)).toContain("last success"); expect(summarizeXCheck([{ watchId: "x", label: "@theo", status: "ok", added: 2 }])).toBe("2 new posts") })
})
