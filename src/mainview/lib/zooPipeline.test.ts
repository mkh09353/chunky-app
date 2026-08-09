// Ideas/items half of the Factory contract: response validation, the lenient
// ideas fence parser, and the research brief handed to a promoted item. Run with:
//   bun test src/mainview/lib/zooPipeline.test.ts
import { describe, expect, it } from "bun:test"
import {
  parseIdeaResponse,
  parseIdeasResponse,
  parseItemResponse,
  parseItemsResponse,
  parseRecordIdeasResponse,
  type ZooIdea,
  type ZooInsight,
  type ZooItem,
} from "./zoo"
import { parseFencedIdeas } from "./zooSynthesis"
import { buildResearchBrief, nextStage, startResearchSessionWithDeps } from "./zooItemFlow"

const idea: ZooIdea = {
  id: "d-1",
  type: "build",
  title: "Retry failed payments",
  rationale: "Three independent reports of silent card declines.",
  status: "proposed",
  insightIds: ["i-1", "i-2"],
  createdAt: 1000,
}

const item: ZooItem = {
  id: "t-1",
  ideaId: "d-1",
  title: "Retry failed payments",
  stage: "research",
  sessionIds: ["s-1", "s-2"],
  decisions: [{ at: 2000, actor: "user", note: "Promoted for research" }],
  createdAt: 1000,
  updatedAt: 3000,
}

describe("idea and item response validation", () => {
  it("accepts well-formed ideas and drops an absent itemId", () => {
    const result = parseIdeasResponse({ ok: true, ideas: [idea, { ...idea, id: "d-2", itemId: "t-9" }] })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect("itemId" in result.ideas[0]!).toBe(false)
    expect(result.ideas[1]?.itemId).toBe("t-9")
  })

  it("accepts jam session and idea outcome metadata", () => {
    const result = parseIdeaResponse({ ok: true, idea: { ...idea, jamSessions: [{ sessionId: "jam-1", createdAt: 1, outcomeAt: 2 }], decisions: [{ at: 2, actor: "agent", note: "Outcome", sessionId: "jam-1" }] } })
    expect(result).toMatchObject({ ok: true, idea: { jamSessions: [{ sessionId: "jam-1" }], decisions: [{ note: "Outcome" }] } })
  })

  it("rejects an idea with an unknown type, status, or non-string insightIds", () => {
    const bad = (patch: Record<string, unknown>) =>
      parseIdeaResponse({ ok: true, idea: { ...idea, ...patch } }).ok
    expect(parseIdeaResponse({ ok: true, idea }).ok).toBe(true)
    expect(bad({ type: "refactor" })).toBe(false)
    expect(bad({ status: "queued" })).toBe(false)
    expect(bad({ insightIds: "i-1" })).toBe(false)
    expect(bad({ insightIds: ["i-1", 7] })).toBe(false)
    expect(bad({ rationale: "" })).toBe(false)
    expect(bad({ createdAt: "1000" })).toBe(false)
  })

  it("rejects the whole ideas list when one entry is malformed", () => {
    expect(parseIdeasResponse({ ok: true, ideas: [idea, { id: "d-2" }] }).ok).toBe(false)
    expect(parseIdeasResponse({ ok: true, ideas: {} }).ok).toBe(false)
  })

  it("validates the recorded-idea count", () => {
    expect(parseRecordIdeasResponse({ ok: true, ideaCount: 3 }).ok).toBe(true)
    expect(parseRecordIdeasResponse({ ok: true, ideaCount: "3" }).ok).toBe(false)
    expect(parseRecordIdeasResponse({ ok: false, error: "Unknown pass" })).toEqual({
      ok: false,
      error: "Unknown pass",
    })
  })

  it("accepts a well-formed item with its session and decision arrays", () => {
    const result = parseItemResponse({ ok: true, item })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.item.sessionIds).toEqual(["s-1", "s-2"])
    expect(result.item.decisions[0]).toEqual({ at: 2000, actor: "user", note: "Promoted for research" })
  })

  it("rejects an item with a bad stage or malformed session/decision entries", () => {
    const bad = (patch: Record<string, unknown>) => parseItemResponse({ ok: true, item: { ...item, ...patch } }).ok
    expect(bad({ stage: "parked" })).toBe(false)
    expect(bad({ sessionIds: [""] })).toBe(false)
    expect(bad({ sessionIds: ["s-1", 2] })).toBe(false)
    expect(bad({ decisions: "none" })).toBe(false)
    expect(bad({ decisions: [{ at: 1, actor: "robot", note: "x" }] })).toBe(false)
    expect(bad({ decisions: [{ at: 1, actor: "user" }] })).toBe(false)
    expect(bad({ decisions: [{ actor: "user", note: "x" }] })).toBe(false)
    expect(bad({ updatedAt: null })).toBe(false)
  })

  it("rejects the whole items list when one entry is malformed", () => {
    expect(parseItemsResponse({ ok: true, items: [item] }).ok).toBe(true)
    expect(parseItemsResponse({ ok: true, items: [item, { ...item, stage: "nope" }] }).ok).toBe(false)
  })
})

describe("parseFencedIdeas", () => {
  const block = (body: unknown) => "```json\n" + JSON.stringify(body) + "\n```"
  const good = { type: "build", title: "Retry payments", rationale: "Three reports.", insightIds: ["i-1"] }

  it("parses a valid ideas array", () => {
    const result = parseFencedIdeas(`Here you go:\n\n${block([good])}`)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.ideas).toEqual([
      { type: "build", title: "Retry payments", rationale: "Three reports.", insightIds: ["i-1"] },
    ])
    expect(result.dropped).toBe(0)
  })

  // Documented policy: unusable entries are DROPPED and counted (an expensive
  // triage run should not be lost to one hallucinated type); only a reply with
  // nothing usable fails the pass.
  it("drops entries with an unknown type or missing fields and counts them", () => {
    const result = parseFencedIdeas(
      block([
        good,
        { type: "refactor", title: "Rewrite it", rationale: "vibes", insightIds: [] },
        { type: "close", title: "", rationale: "no title", insightIds: [] },
        { type: "investigate", title: "Look into churn", insightIds: [] },
      ]),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.ideas.map((entry) => entry.title)).toEqual(["Retry payments"])
    expect(result.dropped).toBe(3)
  })

  it("normalizes type casing and non-string insightIds", () => {
    const result = parseFencedIdeas(
      block([{ ...good, type: "NEEDS-DETAIL", insightIds: ["i-1", 7, "", " i-2 "] }]),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.ideas[0]?.type).toBe("needs-detail")
    expect(result.ideas[0]?.insightIds).toEqual(["i-1", "i-2"])
  })

  it("fails when nothing survives, when the JSON is invalid, and when the fence is missing", () => {
    const allBad = parseFencedIdeas(block([{ type: "nope", title: "x", rationale: "y", insightIds: [] }]))
    expect(allBad.ok).toBe(false)
    if (!allBad.ok) expect(allBad.error).toContain("none in the required shape")

    expect(parseFencedIdeas("```json\n[{type:'build'}\n```").ok).toBe(false)
    expect(parseFencedIdeas(block([])).ok).toBe(false)

    const noFence = parseFencedIdeas(`[${JSON.stringify(good)}]`)
    expect(noFence.ok).toBe(false)
    if (!noFence.ok) expect(noFence.error).toContain("no fenced JSON block")
  })
})

describe("buildResearchBrief", () => {
  const promoted: ZooIdea = {
    id: "d-1",
    type: "build",
    title: "Retry failed payments",
    rationale: "Three independent reports of silent card declines.",
    status: "proposed",
    insightIds: ["i-1"],
    createdAt: 1000,
  }
  const insights: ZooInsight[] = [
    {
      id: "i-1",
      passId: "p-1",
      title: "Checkout is fragile",
      summary: "Payments fail without explanation.",
      evidence: [
        { artifactId: "a-1", quote: "my card was declined with no message" },
        { artifactId: "a-2", quote: "had to retry four times" },
      ],
      createdAt: 2000,
    },
    {
      id: "i-9",
      passId: "p-1",
      title: "Unrelated insight",
      summary: "Should not appear.",
      evidence: [{ artifactId: "a-3", quote: "irrelevant quote" }],
      createdAt: 2000,
    },
  ]

  it("includes the title, rationale, and the cited insights' evidence quotes", () => {
    const brief = buildResearchBrief(promoted, insights)
    expect(brief).toContain("Retry failed payments")
    expect(brief).toContain("Three independent reports of silent card declines.")
    expect(brief).toContain("Checkout is fragile")
    expect(brief).toContain("my card was declined with no message")
    expect(brief).toContain("had to retry four times")
    expect(brief).toContain("Proposed disposition: build")
  })

  it("ignores insights the idea does not cite", () => {
    const brief = buildResearchBrief(promoted, insights)
    expect(brief).not.toContain("Unrelated insight")
    expect(brief).not.toContain("irrelevant quote")
  })

  it("says so plainly when no evidence is attached", () => {
    const brief = buildResearchBrief({ ...promoted, insightIds: [] }, insights)
    expect(brief).toContain("No recorded insight evidence")
    expect(brief).not.toContain("irrelevant quote")
  })

  it("caps the quotes it copies in", () => {
    const many: ZooInsight[] = [
      {
        ...insights[0]!,
        evidence: Array.from({ length: 30 }, (_, index) => ({
          artifactId: `a-${index}`,
          quote: `quote number ${index}`,
        })),
      },
    ]
    const brief = buildResearchBrief(promoted, many)
    expect(brief).toContain("quote number 0")
    expect(brief).not.toContain("quote number 20")
  })
})

describe("nextStage", () => {
  it("walks research to shipped and stops at the ends", () => {
    expect(nextStage("research")).toBe("decision")
    expect(nextStage("decision")).toBe("building")
    expect(nextStage("building")).toBe("review")
    expect(nextStage("review")).toBe("shipped")
    expect(nextStage("shipped")).toBeNull()
    expect(nextStage("dropped")).toBeNull()
  })
})

describe("startResearchSession", () => {
  it("starts and links a full-evidence goal for an un-sessioned research item", async () => {
    let objective = ""
    const result = await startResearchSessionWithDeps({ ...item, stage: "research" as const, sessionIds: [], decisions: [] }, { ...idea, status: "promoted" }, "repo-1", { baseUrl: "http://chunky" }, {
      resolveBaseUrl: async (url) => url ?? null,
      listInsights: async () => ({ ok: true, insights: [{ id: "i-1", passId: "p", title: "Signal", summary: "Summary", evidence: [{ artifactId: "a", quote: "Quote" }], createdAt: 1 }] }),
      create: async (_url, repo) => ({ sessionId: `session-${repo}`, incognito: false }),
      goal: async (_url, _id, body) => { objective = body.objective ?? ""; return null },
      update: async (_id, update) => ({ ok: true, item: { ...item, stage: "research", sessionIds: [String(update.addSessionId)], decisions: [update.addDecision! as any] } }),
    })
    expect(result).toMatchObject({ ok: true, sessionId: "session-repo-1" })
    expect(objective).toContain("Retry failed payments")
    expect(objective).toContain("Quote")
  })

  it("rejects non-research and already-sessioned items", async () => {
    const unused: any = { resolveBaseUrl: async () => null, listInsights: async () => ({ ok: true, insights: [] }), create: async () => { throw new Error() }, goal: async () => null, update: async () => ({ ok: false, error: "no" }) }
    const typedItem = { ...item, stage: "research" as const, decisions: [] }
    expect(await startResearchSessionWithDeps({ ...typedItem, stage: "decision" }, idea, "repo", {}, unused)).toMatchObject({ ok: false, error: expect.stringContaining("research-stage") })
    expect(await startResearchSessionWithDeps(typedItem, idea, "repo", {}, unused)).toMatchObject({ ok: false, error: expect.stringContaining("already") })
  })
})
