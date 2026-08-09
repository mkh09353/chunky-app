// The Zoo's attention queue: what lands in the Inbox and in which order.
// Run with: bun test src/mainview/lib/zooInbox.test.ts
import { describe, expect, it } from "bun:test"
import {
  buildInbox,
  citedInsightIds,
  ideaForItem,
  inFlightItems,
  insightsForIdea,
  itemsByStage,
} from "./zooInbox"
import type { ZooIdea, ZooInsight, ZooItem } from "./zoo"

const insight = (over: Partial<ZooInsight> & { id: string }): ZooInsight => ({
  passId: "p-1",
  title: `Insight ${over.id}`,
  summary: "Something users keep hitting.",
  evidence: [{ artifactId: "a-1", quote: "It failed silently again." }],
  createdAt: 1000,
  ...over,
})

const idea = (over: Partial<ZooIdea> & { id: string }): ZooIdea => ({
  type: "build",
  title: `Idea ${over.id}`,
  rationale: "Because the evidence says so.",
  status: "proposed",
  insightIds: [],
  createdAt: 1000,
  ...over,
})

const item = (over: Partial<ZooItem> & { id: string }): ZooItem => ({
  ideaId: "d-1",
  title: `Item ${over.id}`,
  stage: "research",
  sessionIds: [],
  decisions: [],
  createdAt: 1000,
  updatedAt: 1000,
  ...over,
})

describe("buildInbox", () => {
  it("puts waiting items ahead of proposed ideas ahead of loose insights", () => {
    const entries = buildInbox({
      ideas: [idea({ id: "d-1", createdAt: 5000 })],
      items: [item({ id: "t-1", stage: "decision", updatedAt: 100 })],
      insights: [insight({ id: "i-1", passId: "p-9", createdAt: 9000 })],
    })
    expect(entries.map((entry) => entry.id)).toEqual(["item:t-1", "idea:d-1", "insights:p-9"])
    expect(entries[0]?.kind).toBe("item")
    expect(entries[0]?.why).toContain("Research came back")
  })

  it("only queues items parked on a human decision", () => {
    const entries = buildInbox({
      ideas: [],
      items: [
        item({ id: "t-1", stage: "research" }),
        item({ id: "t-2", stage: "decision" }),
        item({ id: "t-3", stage: "building" }),
        item({ id: "t-4", stage: "review" }),
        item({ id: "t-5", stage: "shipped" }),
        item({ id: "t-6", stage: "dropped" }),
      ],
      insights: [],
    })
    expect(entries.map((entry) => entry.item?.id)).toEqual(["t-2", "t-4"])
  })

  it("only queues proposed ideas", () => {
    const entries = buildInbox({
      ideas: [
        idea({ id: "d-1", status: "proposed" }),
        idea({ id: "d-2", status: "promoted" }),
        idea({ id: "d-3", status: "dismissed" }),
      ],
      items: [],
      insights: [],
    })
    expect(entries.map((entry) => entry.idea?.id)).toEqual(["d-1"])
  })

  it("attaches cited evidence to an idea card and to the item it became", () => {
    const insights = [insight({ id: "i-1" }), insight({ id: "i-2" }), insight({ id: "i-3" })]
    const ideas = [idea({ id: "d-1", status: "promoted", insightIds: ["i-1", "i-2", "gone"] })]
    const entries = buildInbox({
      ideas,
      items: [item({ id: "t-1", ideaId: "d-1", stage: "review" })],
      insights,
    })
    expect(entries).toHaveLength(2)
    expect(entries[0]?.insights.map((row) => row.id)).toEqual(["i-1", "i-2"])
    expect(entries[0]?.idea?.id).toBe("d-1")
    // i-3 is cited by nobody, so it becomes the loose-signal card.
    expect(entries[1]?.kind).toBe("insights")
    expect(entries[1]?.insights.map((row) => row.id)).toEqual(["i-3"])
  })

  it("groups uncited insights per pass and titles them by count", () => {
    const entries = buildInbox({
      ideas: [],
      items: [],
      insights: [
        insight({ id: "i-1", passId: "p-1", createdAt: 10 }),
        insight({ id: "i-2", passId: "p-1", createdAt: 30 }),
        insight({ id: "i-3", passId: "p-2", createdAt: 20 }),
      ],
    })
    expect(entries.map((entry) => entry.id)).toEqual(["insights:p-1", "insights:p-2"])
    expect(entries[0]?.title).toBe("2 fresh signals with nothing proposed yet")
    expect(entries[1]?.title).toBe("1 fresh signal with nothing proposed yet")
    // Newest pass first, and newest insight first inside the group.
    expect(entries[0]?.at).toBe(30)
    expect(entries[0]?.insights.map((row) => row.id)).toEqual(["i-2", "i-1"])
  })

  it("sorts same-urgency entries newest first, with a deterministic tiebreak", () => {
    const entries = buildInbox({
      ideas: [
        idea({ id: "d-1", createdAt: 100 }),
        idea({ id: "d-2", createdAt: 900 }),
        idea({ id: "d-3", createdAt: 900 }),
      ],
      items: [],
      insights: [],
    })
    expect(entries.map((entry) => entry.idea?.id)).toEqual(["d-2", "d-3", "d-1"])
  })

  it("drops entries the user set aside in this session", () => {
    const input = {
      ideas: [idea({ id: "d-1" })],
      items: [item({ id: "t-1", stage: "decision" })],
      insights: [insight({ id: "i-1", passId: "p-3" })],
    }
    expect(buildInbox({ ...input, dismissed: ["idea:d-1", "insights:p-3"] }).map((e) => e.id)).toEqual([
      "item:t-1",
    ])
  })

  it("carries the origin of a signal group so a watch's card can name the repo", () => {
    const entries = buildInbox({
      ideas: [],
      items: [],
      insights: [
        insight({ id: "i-1", passId: "p-1", sourceLabels: ["sst/opencode"] }),
        insight({ id: "i-2", passId: "p-1", sourceLabels: ["sst/opencode", "openai/codex"] }),
        insight({ id: "i-3", passId: "p-2" }),
      ],
    })
    const byId = new Map(entries.map((entry) => [entry.id, entry]))
    expect(byId.get("insights:p-1")?.sourceLabels).toEqual(["sst/opencode", "openai/codex"])
    expect(byId.get("insights:p-2")?.sourceLabels).toBeUndefined()
  })

  it("carries an X-watch source label through the same Inbox attribution path", () => {
    const entries = buildInbox({ ideas: [], items: [], insights: [insight({ id: "i-x", passId: "p-x", sourceLabels: ["@theo"] })] })
    expect(entries[0]?.sourceLabels).toEqual(["@theo"])
  })

  it("returns nothing for an empty board", () => {
    expect(buildInbox({ ideas: [], items: [], insights: [] })).toEqual([])
  })
})

describe("board helpers", () => {
  it("indexes cited insights and resolves them in citation order", () => {
    const ideas = [idea({ id: "d-1", insightIds: ["i-2", "i-1"] })]
    expect([...citedInsightIds(ideas)]).toEqual(["i-2", "i-1"])
    const resolved = insightsForIdea(ideas[0]!, new Map([["i-1", insight({ id: "i-1" })]]))
    expect(resolved.map((row) => row.id)).toEqual(["i-1"])
  })

  it("finds the idea behind an item, or null", () => {
    const ideas = [idea({ id: "d-1" })]
    expect(ideaForItem(item({ id: "t-1", ideaId: "d-1" }), ideas)?.id).toBe("d-1")
    expect(ideaForItem(item({ id: "t-1", ideaId: "nope" }), ideas)).toBeNull()
  })

  it("lists in-flight work newest first and groups the board by stage", () => {
    const items = [
      item({ id: "t-1", stage: "research", updatedAt: 10 }),
      item({ id: "t-2", stage: "building", updatedAt: 40 }),
      item({ id: "t-3", stage: "shipped", updatedAt: 50 }),
    ]
    expect(inFlightItems(items).map((row) => row.id)).toEqual(["t-2", "t-1"])
    const columns = itemsByStage(items, ["research", "shipped", "dropped"])
    expect(columns.map((column) => [column.stage, column.items.length])).toEqual([
      ["research", 1],
      ["shipped", 1],
      ["dropped", 0],
    ])
  })
})

// ---- Areas: scoping the queue without partitioning the board ---------------

describe("area scoping", () => {
  const board = {
    ideas: [
      idea({ id: "d-pay", areaId: "a-pay", createdAt: 100 }),
      idea({ id: "d-growth", areaId: "a-growth", createdAt: 200 }),
      idea({ id: "d-legacy", createdAt: 300 }),
    ],
    items: [
      item({ id: "t-pay", stage: "decision", areaId: "a-pay" }),
      item({ id: "t-growth", stage: "review", areaId: "a-growth" }),
      item({ id: "t-legacy", stage: "decision" }),
    ],
    insights: [
      insight({ id: "i-pay", passId: "p-pay", areaId: "a-pay" }),
      insight({ id: "i-growth", passId: "p-growth", areaId: "a-growth" }),
      insight({ id: "i-legacy", passId: "p-legacy" }),
    ],
  }

  it("shows everything under All areas", () => {
    expect(buildInbox(board).map((entry) => entry.id).sort()).toEqual([
      "idea:d-growth",
      "idea:d-legacy",
      "idea:d-pay",
      "insights:p-growth",
      "insights:p-legacy",
      "insights:p-pay",
      "item:t-growth",
      "item:t-legacy",
      "item:t-pay",
    ])
  })

  it("scopes to one area and keeps unassigned rows visible in it", () => {
    const ids = buildInbox({ ...board, areaId: "a-pay" }).map((entry) => entry.id)
    expect(ids).toContain("item:t-pay")
    expect(ids).toContain("idea:d-pay")
    expect(ids).toContain("insights:p-pay")
    // Rows stored before areas existed belong to no product, so every area sees them.
    expect(ids).toContain("item:t-legacy")
    expect(ids).toContain("idea:d-legacy")
    expect(ids).toContain("insights:p-legacy")
    // Another area's work is the only thing hidden.
    expect(ids).not.toContain("item:t-growth")
    expect(ids).not.toContain("idea:d-growth")
    expect(ids).not.toContain("insights:p-growth")
  })

  it("carries the area onto each entry so cards can be badged", () => {
    const entries = buildInbox(board)
    const byId = new Map(entries.map((entry) => [entry.id, entry]))
    expect(byId.get("item:t-pay")?.areaId).toBe("a-pay")
    expect(byId.get("idea:d-growth")?.areaId).toBe("a-growth")
    expect(byId.get("insights:p-pay")?.areaId).toBe("a-pay")
    // Unassigned entries carry no area at all rather than a fake one.
    expect(byId.get("item:t-legacy")?.areaId).toBeUndefined()
    expect(byId.get("insights:p-legacy")?.areaId).toBeUndefined()
  })

  it("still resolves evidence cited across areas", () => {
    // A payments idea citing a growth insight: the link renders, and the
    // insight does NOT come back as an uncited signal in either area.
    const crossing = {
      ideas: [idea({ id: "d-pay", areaId: "a-pay", insightIds: ["i-growth"] })],
      items: [],
      insights: [insight({ id: "i-growth", passId: "p-growth", areaId: "a-growth" })],
    }
    const scoped = buildInbox({ ...crossing, areaId: "a-pay" })
    expect(scoped.map((entry) => entry.id)).toEqual(["idea:d-pay"])
    expect(scoped[0]?.insights.map((row) => row.id)).toEqual(["i-growth"])
    expect(buildInbox({ ...crossing, areaId: "a-growth" }).map((entry) => entry.id)).toEqual([])
  })

  it("treats a board with no areas at all exactly as before", () => {
    const legacy = {
      ideas: [idea({ id: "d-1" })],
      items: [item({ id: "t-1", stage: "decision" })],
      insights: [insight({ id: "i-1", passId: "p-1" })],
    }
    const unscoped = buildInbox(legacy)
    expect(unscoped.map((entry) => entry.id)).toEqual(["item:t-1", "idea:d-1", "insights:p-1"])
    // Selecting any area still shows all of it — nothing is lost or hidden.
    expect(buildInbox({ ...legacy, areaId: "a-anything" }).map((entry) => entry.id)).toEqual(
      unscoped.map((entry) => entry.id),
    )
  })

  it("scopes the in-flight strip the same way", () => {
    const items = [
      item({ id: "t-pay", stage: "building", areaId: "a-pay", updatedAt: 10 }),
      item({ id: "t-growth", stage: "research", areaId: "a-growth", updatedAt: 20 }),
      item({ id: "t-legacy", stage: "building", updatedAt: 30 }),
    ]
    expect(inFlightItems(items).map((row) => row.id)).toEqual(["t-legacy", "t-growth", "t-pay"])
    expect(inFlightItems(items, "a-pay").map((row) => row.id)).toEqual(["t-legacy", "t-pay"])
  })
})
