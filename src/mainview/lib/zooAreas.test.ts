// Area scoping rules, repo binding, and the stored selection.
// Run with: bun test src/mainview/lib/zooAreas.test.ts
import { describe, expect, it } from "bun:test"
import {
  areaCounts,
  areaName,
  inArea,
  knownArea,
  loadSelectedArea,
  repoIdForArea,
  resolveSelection,
  saveSelectedArea,
  scopeBoard,
} from "./zooAreas"
import type { ZooArea, ZooIdea, ZooInsight, ZooItem, ZooSource } from "../../shared/zooTypes"

const area = (id: string, name: string, repoPaths?: string[]): ZooArea => ({
  id,
  name,
  ...(repoPaths ? { repoPaths } : {}),
  createdAt: 1000,
})

const source = (id: string, areaId?: string): ZooSource => ({
  id,
  kind: "linear",
  label: id,
  ...(areaId ? { areaId } : {}),
  createdAt: 1000,
  backfill: { state: "done", fetched: 1 },
})
const insight = (id: string, areaId?: string): ZooInsight => ({
  id,
  passId: "p-1",
  title: id,
  summary: "s",
  evidence: [],
  ...(areaId ? { areaId } : {}),
  createdAt: 1000,
})
const idea = (id: string, areaId?: string): ZooIdea => ({
  id,
  type: "build",
  title: id,
  rationale: "r",
  status: "proposed",
  insightIds: [],
  ...(areaId ? { areaId } : {}),
  createdAt: 1000,
})
const item = (id: string, areaId?: string): ZooItem => ({
  id,
  ideaId: "d-1",
  title: id,
  stage: "research",
  sessionIds: [],
  decisions: [],
  ...(areaId ? { areaId } : {}),
  createdAt: 1000,
  updatedAt: 1000,
})

describe("inArea", () => {
  it("shows everything under All areas", () => {
    expect(inArea({ areaId: "a-1" }, null)).toBe(true)
    expect(inArea({}, null)).toBe(true)
  })

  it("keeps unassigned rows visible inside every area", () => {
    expect(inArea({}, "a-1")).toBe(true)
  })

  it("hides only rows belonging to a different area", () => {
    expect(inArea({ areaId: "a-1" }, "a-1")).toBe(true)
    expect(inArea({ areaId: "a-2" }, "a-1")).toBe(false)
  })
})

describe("scopeBoard", () => {
  const board = {
    sources: [source("s-1", "a-1"), source("s-2", "a-2"), source("s-3")],
    insights: [insight("i-1", "a-1"), insight("i-2", "a-2"), insight("i-3")],
    ideas: [idea("d-1", "a-1"), idea("d-2", "a-2"), idea("d-3")],
    items: [item("t-1", "a-1"), item("t-2", "a-2"), item("t-3")],
  }

  it("returns the board untouched for All areas", () => {
    expect(scopeBoard(board, null)).toBe(board)
  })

  it("keeps the selected area plus everything unassigned", () => {
    const scoped = scopeBoard(board, "a-1")
    expect(scoped.sources.map((row) => row.id)).toEqual(["s-1", "s-3"])
    expect(scoped.insights.map((row) => row.id)).toEqual(["i-1", "i-3"])
    expect(scoped.ideas.map((row) => row.id)).toEqual(["d-1", "d-3"])
    expect(scoped.items.map((row) => row.id)).toEqual(["t-1", "t-3"])
  })

  it("counts only what an area actually owns", () => {
    expect(areaCounts(board, "a-1")).toEqual({ ideas: 1, items: 1 })
    expect(areaCounts(board, "a-9")).toEqual({ ideas: 0, items: 0 })
  })
})

describe("area lookup", () => {
  const areas = [area("a-1", "Payments"), area("a-2", "Growth")]

  it("resolves names and tolerates unknown or absent ids", () => {
    expect(areaName(areas, "a-2")).toBe("Growth")
    expect(areaName(areas, "gone")).toBeNull()
    expect(areaName(areas, undefined)).toBeNull()
    expect(knownArea(areas, "a-1")?.name).toBe("Payments")
  })

  it("falls back to All areas when the stored area is gone", () => {
    expect(resolveSelection("a-1", areas)).toBe("a-1")
    expect(resolveSelection("deleted", areas)).toBeNull()
    expect(resolveSelection(null, areas)).toBeNull()
  })
})

describe("repoIdForArea", () => {
  const repos = [
    { id: "r-pay", path: "/Users/me/code/payments" },
    { id: "r-web", path: "/Users/me/code/web" },
  ]

  it("binds to the area's first configured path that is a registered repo", () => {
    expect(repoIdForArea(area("a-1", "Payments", ["/nope", "/Users/me/code/payments"]), repos)).toBe("r-pay")
  })

  it("ignores a trailing slash", () => {
    expect(repoIdForArea(area("a-1", "Payments", ["/Users/me/code/payments/"]), repos)).toBe("r-pay")
  })

  it("returns null with no area, no paths, or no match, so the caller can fall back", () => {
    expect(repoIdForArea(null, repos)).toBeNull()
    expect(repoIdForArea(area("a-1", "Payments"), repos)).toBeNull()
    expect(repoIdForArea(area("a-1", "Payments", ["/somewhere/else"]), repos)).toBeNull()
    expect(repoIdForArea(area("a-1", "Payments", ["/Users/me/code/payments"]), [])).toBeNull()
  })
})

describe("selected-area preference", () => {
  it("round-trips through storage and defaults to All areas", () => {
    const store = new Map<string, string>()
    const original = globalThis.localStorage
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => void store.set(key, value),
        removeItem: (key: string) => void store.delete(key),
      },
    })
    try {
      expect(loadSelectedArea()).toBeNull()
      saveSelectedArea("a-1")
      expect(store.get("zoo.area")).toBe("a-1")
      expect(loadSelectedArea()).toBe("a-1")
      saveSelectedArea(null)
      expect(store.has("zoo.area")).toBe(false)
      expect(loadSelectedArea()).toBeNull()
    } finally {
      if (original) Object.defineProperty(globalThis, "localStorage", { configurable: true, value: original })
      else Reflect.deleteProperty(globalThis, "localStorage")
    }
  })

  it("survives storage being unavailable", () => {
    const original = globalThis.localStorage
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: () => {
          throw new Error("denied")
        },
        setItem: () => {
          throw new Error("denied")
        },
        removeItem: () => {
          throw new Error("denied")
        },
      },
    })
    try {
      expect(loadSelectedArea()).toBeNull()
      expect(() => saveSelectedArea("a-1")).not.toThrow()
    } finally {
      if (original) Object.defineProperty(globalThis, "localStorage", { configurable: true, value: original })
      else Reflect.deleteProperty(globalThis, "localStorage")
    }
  })
})
