// Factory (zoo) client contract: response validation + the extraction reply
// parser. Run with:
//   bun test src/mainview/lib/zoo.test.ts
import { describe, expect, it } from "bun:test"
import {
  parseAreaResponse,
  parseWatchCheckResponse,
  parseWatchesResponse,
  parseWatchResponse,
  parseAreasResponse,
  parseArtifactResponse,
  parseArtifactsResponse,
  parseExportResponse,
  parseInsightsResponse,
  parseOkResponse,
  parseRecordResponse,
  parseIdeasResponse,
  parseItemsResponse,
  parseSourceResponse,
  parseStatusResponse,
  ZOO_UNAVAILABLE,
  zooAvailable,
  zooStatus,
} from "./zoo"
import { parseFencedInsights } from "./zooExtraction"

const source = {
  id: "src-1",
  kind: "linear",
  label: "Linear · Acme",
  createdAt: 1000,
  backfill: { state: "done", fetched: 12, completedAt: 2000 },
}
const artifact = {
  id: "a-1",
  sourceId: "src-1",
  kind: "linear_issue",
  externalId: "ACME-12",
  title: "Billing page 500s",
  url: "https://linear.app/acme/issue/ACME-12",
  fetchedAt: 3000,
}
const insight = {
  id: "i-1",
  passId: "p-1",
  title: "Checkout is fragile",
  summary: "Several reports of failed payments.",
  priority: 2,
  evidence: [{ artifactId: "a-1", quote: "card declined without a reason" }],
  createdAt: 4000,
}

describe("zoo response validation", () => {
  it("accepts a well-formed status response", () => {
    const result = parseStatusResponse({
      ok: true,
      sources: [source],
      artifactCount: 12,
      insightCount: 3,
      ideaCount: 2,
      itemCount: 1,
      passes: [{ id: "p-1", startedAt: 5000, status: "done", note: "clean" }],
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.sources[0]).toEqual({
      id: "src-1",
      kind: "linear",
      label: "Linear · Acme",
      createdAt: 1000,
      backfill: { state: "done", fetched: 12, completedAt: 2000 },
    })
    expect(result.passes[0]?.note).toBe("clean")
  })

  it("passes a server failure envelope through with its error", () => {
    expect(parseStatusResponse({ ok: false, error: "Unknown source" })).toEqual({
      ok: false,
      error: "Unknown source",
    })
    // ok:false without a usable error still fails, never succeeds.
    expect(parseOkResponse({ ok: false }).ok).toBe(false)
  })

  it("rejects non-object and un-enveloped responses", () => {
    for (const raw of [null, undefined, 7, "ok", [], {}, { ok: "yes" }]) {
      expect(parseStatusResponse(raw).ok).toBe(false)
    }
  })

  it("rejects a status response with missing or wrong-typed fields", () => {
    const counts = { artifactCount: 0, insightCount: 0, ideaCount: 0, itemCount: 0 }
    expect(parseStatusResponse({ ok: true, sources: [], passes: [], insightCount: 0 }).ok).toBe(false)
    expect(parseStatusResponse({ ok: true, sources: {}, ...counts, passes: [] }).ok).toBe(false)
    expect(
      parseStatusResponse({ ok: true, sources: [], ...counts, artifactCount: "12", passes: [] }).ok,
    ).toBe(false)
    // The pipeline counters are part of the contract, not optional extras.
    expect(parseStatusResponse({ ok: true, sources: [], ...counts, ideaCount: undefined, passes: [] }).ok).toBe(false)
    expect(parseStatusResponse({ ok: true, sources: [], ...counts, itemCount: null, passes: [] }).ok).toBe(false)
  })

  it("accepts both source kinds and rejects unknown ones", () => {
    const bad = (patch: Record<string, unknown>) =>
      parseSourceResponse({ ok: true, source: { ...source, ...patch } }).ok
    expect(parseSourceResponse({ ok: true, source }).ok).toBe(true)
    expect(bad({ kind: "transcripts" })).toBe(true)
    expect(bad({ kind: "posthog" })).toBe(false)
    expect(bad({ id: "" })).toBe(false)
    expect(bad({ createdAt: "1000" })).toBe(false)
    expect(bad({ backfill: { state: "paused", fetched: 1 } })).toBe(false)
    expect(bad({ backfill: { state: "done" } })).toBe(false)
    expect(bad({ backfill: null })).toBe(false)
  })

  it("drops an absent optional field instead of inventing one", () => {
    const result = parseSourceResponse({
      ok: true,
      source: { ...source, backfill: { state: "idle", fetched: 0 } },
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect("completedAt" in result.source.backfill).toBe(false)
    expect("error" in result.source.backfill).toBe(false)
  })

  it("rejects the whole artifact list when one entry is malformed", () => {
    expect(parseArtifactsResponse({ ok: true, artifacts: [artifact], total: 1 }).ok).toBe(true)
    expect(
      parseArtifactsResponse({ ok: true, artifacts: [artifact, { id: "a-2" }], total: 2 }).ok,
    ).toBe(false)
    expect(parseArtifactsResponse({ ok: true, artifacts: [artifact] }).ok).toBe(false)
  })

  it("requires artifact detail content to be a string", () => {
    const detail = parseArtifactResponse({ ok: true, artifact: { ...artifact, content: "body" } })
    expect(detail.ok).toBe(true)
    if (detail.ok) expect(detail.artifact.content).toBe("body")
    expect(parseArtifactResponse({ ok: true, artifact }).ok).toBe(false)
    expect(parseArtifactResponse({ ok: true, artifact: { ...artifact, content: 5 } }).ok).toBe(false)
  })

  it("requires a pass id and string bundle on export, including an empty watch delta", () => {
    expect(parseExportResponse({ ok: true, passId: "p-1", bundle: "text" }).ok).toBe(true)
    expect(parseExportResponse({ ok: true, passId: "p-1", bundle: "" }).ok).toBe(true)
    expect(parseExportResponse({ ok: true, bundle: "text" }).ok).toBe(false)
  })

  it("validates the recorded-insight count", () => {
    expect(parseRecordResponse({ ok: true, insightCount: 4 }).ok).toBe(true)
    expect(parseRecordResponse({ ok: true, insightCount: null }).ok).toBe(false)
  })

  it("rejects insights with malformed evidence", () => {
    expect(parseInsightsResponse({ ok: true, insights: [insight] }).ok).toBe(true)
    expect(
      parseInsightsResponse({ ok: true, insights: [{ ...insight, evidence: [{ quote: "x" }] }] }).ok,
    ).toBe(false)
    expect(parseInsightsResponse({ ok: true, insights: [{ ...insight, evidence: "none" }] }).ok).toBe(
      false,
    )
    expect(parseInsightsResponse({ ok: true, insights: [{ ...insight, summary: "" }] }).ok).toBe(false)
  })

  it("omits an absent priority", () => {
    const result = parseInsightsResponse({
      ok: true,
      insights: [{ ...insight, priority: undefined }],
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect("priority" in result.insights[0]!).toBe(false)
  })

  it("reports unavailable rather than failing when there is no native bridge", async () => {
    expect(zooAvailable()).toBe(false)
    const result = await zooStatus()
    expect(result).toEqual({ ok: false, error: ZOO_UNAVAILABLE, unavailable: true })
  })
})

describe("parseFencedInsights", () => {
  const block = (body: string, tag = "json") => "```" + tag + "\n" + body + "\n```"
  const valid = JSON.stringify([
    {
      title: "Checkout is fragile",
      summary: "Payments fail without explanation.",
      priority: 1,
      evidence: [{ artifactId: "a-1", quote: "card declined" }],
    },
  ])

  it("parses a lone fenced json block", () => {
    const result = parseFencedInsights(block(valid))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.insights).toEqual([
      {
        title: "Checkout is fragile",
        summary: "Payments fail without explanation.",
        priority: 1,
        evidence: [{ artifactId: "a-1", quote: "card declined" }],
      },
    ])
  })

  it("ignores prose around the block and takes the last json fence", () => {
    const reply = [
      "Here is what I found after clustering.",
      block(JSON.stringify([{ title: "Draft", summary: "ignored", evidence: [] }])),
      "On reflection, the final answer is:",
      block(valid),
      "Let me know if you want more detail.",
    ].join("\n\n")
    const result = parseFencedInsights(reply)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.insights[0]?.title).toBe("Checkout is fragile")
  })

  it("accepts an untagged fence and clamps priority into 1-5", () => {
    const result = parseFencedInsights(
      block(JSON.stringify([{ title: "T", summary: "S", priority: 9, evidence: [] }]), ""),
    )
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.insights[0]?.priority).toBe(5)
  })

  it("fails on invalid JSON inside the fence", () => {
    const result = parseFencedInsights(block("[{ title: 'nope' }"))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain("not valid JSON")
  })

  it("fails when there is no fence at all", () => {
    const result = parseFencedInsights(`Sure — ${valid}`)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain("no fenced JSON block")
  })

  it("fails on a non-array body, empty array, or entries missing fields", () => {
    expect(parseFencedInsights(block('{"title":"x","summary":"y"}')).ok).toBe(false)
    expect(parseFencedInsights(block("[]")).ok).toBe(false)
    expect(parseFencedInsights(block('[{"title":"x"}]')).ok).toBe(false)
    expect(parseFencedInsights(block('[{"title":"x","summary":"y","evidence":[{"quote":"q"}]}]')).ok).toBe(
      false,
    )
  })

  it("treats missing evidence as an empty list", () => {
    const result = parseFencedInsights(block('[{"title":"x","summary":"y"}]'))
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.insights[0]?.evidence).toEqual([])
  })
})

// ---- Areas: the wire contract for multi-product scoping --------------------

describe("area validation", () => {
  const area = { id: "a-1", name: "Payments", repoPaths: ["/code/payments"], createdAt: 1000 }

  it("accepts areas with and without repo paths", () => {
    const result = parseAreasResponse({ ok: true, areas: [area, { id: "a-2", name: "Growth", createdAt: 2000 }] })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.areas[0]).toEqual(area)
    // An area with no paths carries no key at all rather than an empty array.
    expect("repoPaths" in result.areas[1]!).toBe(false)
  })

  it("rejects malformed areas and bad path lists", () => {
    const bad = (patch: Record<string, unknown>) => parseAreaResponse({ ok: true, area: { ...area, ...patch } }).ok
    expect(parseAreaResponse({ ok: true, area }).ok).toBe(true)
    expect(bad({ name: "" })).toBe(false)
    expect(bad({ createdAt: "1000" })).toBe(false)
    expect(bad({ repoPaths: "/code/payments" })).toBe(false)
    expect(bad({ repoPaths: ["/code/payments", 7] })).toBe(false)
    expect(parseAreasResponse({ ok: true, areas: [area, { id: "a-2" }] }).ok).toBe(false)
    expect(parseAreasResponse({ ok: false, error: "nope" })).toEqual({ ok: false, error: "nope" })
  })

  it("reads areaId off every scoped row, and tolerates its absence", () => {
    const withArea = parseIdeasResponse({
      ok: true,
      ideas: [
        { id: "d-1", type: "build", title: "t", rationale: "r", status: "proposed", insightIds: [], areaId: "a-1", createdAt: 1 },
        { id: "d-2", type: "build", title: "t", rationale: "r", status: "proposed", insightIds: [], createdAt: 2 },
      ],
    })
    expect(withArea.ok).toBe(true)
    if (!withArea.ok) return
    expect(withArea.ideas[0]?.areaId).toBe("a-1")
    // Rows stored before areas existed simply have none — never a parse failure.
    expect("areaId" in withArea.ideas[1]!).toBe(false)

    const items = parseItemsResponse({
      ok: true,
      items: [{ id: "t-1", ideaId: "d-1", title: "t", stage: "research", sessionIds: [], decisions: [], areaId: "a-1", createdAt: 1, updatedAt: 2 }],
    })
    expect(items.ok && items.items[0]?.areaId).toBe("a-1")

    const sources = parseStatusResponse({
      ok: true,
      sources: [{ id: "s-1", kind: "linear", label: "Acme", areaId: "a-1", createdAt: 1, backfill: { state: "done", fetched: 2 } }],
      artifactCount: 0,
      insightCount: 0,
      ideaCount: 0,
      itemCount: 0,
      passes: [],
    })
    expect(sources.ok && sources.sources[0]?.areaId).toBe("a-1")

    const insights = parseInsightsResponse({
      ok: true,
      insights: [{ id: "i-1", passId: "p-1", title: "t", summary: "s", evidence: [], areaId: "a-1", createdAt: 1 }],
    })
    expect(insights.ok && insights.insights[0]?.areaId).toBe("a-1")
  })
})

// ---- Competitor watch: the wire contract ----------------------------------

describe("watch validation", () => {
  const watch = {
    id: "w-1",
    sourceId: "s-1",
    owner: "sst",
    name: "opencode",
    label: "sst/opencode",
    lastCheckAt: 5000,
    lastStatus: "ok",
    lastNote: "Recorded 1 release",
    lastArtifactAt: 5000,
    createdAt: 1000,
  }

  it("accepts a watch with and without check history", () => {
    const result = parseWatchesResponse({
      ok: true,
      watches: [watch, { id: "w-2", sourceId: "s-2", owner: "openai", name: "codex", label: "openai/codex", createdAt: 2000 }],
      hour: 8,
      lastRunAt: 5000,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.watches[0]).toMatchObject({ label: "sst/opencode", lastStatus: "ok" })
    expect(result.watches[1]?.lastStatus).toBeUndefined()
    expect(result.hour).toBe(8)
  })

  it("tolerates a board that has never run a check", () => {
    const result = parseWatchesResponse({ ok: true, watches: [], hour: 8, lastRunAt: null })
    expect(result).toEqual({ ok: true, watches: [], hour: 8, lastRunAt: null })
  })

  it("rejects malformed watches and unknown statuses", () => {
    const bad = (patch: Record<string, unknown>) => parseWatchResponse({ ok: true, watch: { ...watch, ...patch } }).ok
    expect(parseWatchResponse({ ok: true, watch }).ok).toBe(true)
    expect(bad({ label: "" })).toBe(false)
    expect(bad({ createdAt: "1000" })).toBe(false)
    expect(bad({ lastStatus: "pending" })).toBe(false)
    expect(parseWatchesResponse({ ok: true, watches: [watch], hour: "8", lastRunAt: null }).ok).toBe(false)
  })

  it("validates a check pass, including skips", () => {
    const result = parseWatchCheckResponse({
      ok: true,
      checkedAt: 9000,
      results: [
        { watchId: "w-1", label: "sst/opencode", status: "ok", added: 1, note: "Recorded 1 release" },
        { watchId: "w-2", label: "openai/codex", status: "skipped", added: 0, note: "GitHub rate limit reached" },
      ],
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.results.map((row) => row.status)).toEqual(["ok", "skipped"])
    expect(parseWatchCheckResponse({ ok: true, checkedAt: 1, results: [{ watchId: "w", label: "l", status: "nope", added: 0 }] }).ok).toBe(false)
    expect(parseWatchCheckResponse({ ok: false, error: "busy" })).toEqual({ ok: false, error: "busy" })
  })

  it("reads the source labels behind an insight's evidence", () => {
    const result = parseInsightsResponse({
      ok: true,
      insights: [
        { id: "i-1", passId: "p-1", title: "t", summary: "s", evidence: [], sourceLabels: ["sst/opencode"], createdAt: 1 },
        { id: "i-2", passId: "p-1", title: "t", summary: "s", evidence: [], createdAt: 2 },
      ],
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.insights[0]?.sourceLabels).toEqual(["sst/opencode"])
    expect("sourceLabels" in result.insights[1]!).toBe(false)
    expect(parseInsightsResponse({ ok: true, insights: [{ id: "i-1", passId: "p-1", title: "t", summary: "s", evidence: [], sourceLabels: [7], createdAt: 1 }] }).ok).toBe(false)
  })
})
