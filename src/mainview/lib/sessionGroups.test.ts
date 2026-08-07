// The adaptive rule behind sidebar worktree grouping.
//
// The single most important assertion in this file is the boring one: a list
// that should not be grouped returns `null`, because that is what guarantees the
// flat render stays byte-identical to what shipped before grouping existed.
//
// Run with: bun test src/mainview/lib/sessionGroups.test.ts
import { expect, test } from "bun:test"
import { groupByWorktree, groupKeyOf, type GroupableThread } from "./sessionGroups"

const row = (id: string, fields: Partial<GroupableThread> = {}): GroupableThread => ({ id, ...fields })

// ---- flat cases: every one of these must render exactly as today -----------

test("an empty list is not grouped", () => {
  expect(groupByWorktree([])).toBeNull()
})

test("a single row is not grouped", () => {
  expect(groupByWorktree([row("a", { gitBranch: "main" })])).toBeNull()
})

test("rows all on one branch are not grouped — that is just the repo tab again", () => {
  const rows = [row("a", { gitBranch: "main" }), row("b", { gitBranch: "main" }), row("c", { gitBranch: "main" })]
  expect(groupByWorktree(rows)).toBeNull()
})

test("rows from an OLDER SERVER (no grouping fields at all) are not grouped", () => {
  // SessionSummary.branch/worktree are optional precisely so this degrades to
  // the pre-worktree render instead of erroring or inventing groups.
  const rows = [row("a"), row("b"), row("c")]
  expect(groupByWorktree(rows)).toBeNull()
})

test("a list where only SOME rows resolved stays flat rather than half-grouped", () => {
  // A partial grouping would quietly imply the unplaceable rows belong nowhere.
  const rows = [row("a", { gitBranch: "main" }), row("b", { gitBranch: "feature" }), row("c")]
  expect(groupByWorktree(rows)).toBeNull()
})

test("an empty-string branch counts as absent, not as a group named \"\"", () => {
  expect(groupByWorktree([row("a", { gitBranch: "" }), row("b", { gitBranch: "main" })])).toBeNull()
})

// ---- grouped cases ---------------------------------------------------------

test("two branches produce two groups, in first-appearance order", () => {
  const rows = [
    row("a", { gitBranch: "main" }),
    row("b", { gitBranch: "feature" }),
    row("c", { gitBranch: "main" }),
  ]
  const groups = groupByWorktree(rows)
  expect(groups).not.toBeNull()
  expect(groups!.map((g) => g.label)).toEqual(["main", "feature"])
  expect(groups!.map((g) => g.rows.map((r) => r.id))).toEqual([["a", "c"], ["b"]])
})

test("a linked worktree is grouped apart and marked linked", () => {
  const rows = [
    row("a", { gitBranch: "main" }),
    row("b", { gitBranch: "chunky/fix", worktreePath: "/state/worktrees/widget-fix" }),
  ]
  const groups = groupByWorktree(rows)!
  expect(groups).toHaveLength(2)
  expect(groups[0]).toMatchObject({ label: "main", linked: false })
  expect(groups[1]).toMatchObject({ label: "chunky/fix", linked: true })
})

test("row order inside a group is preserved exactly", () => {
  const rows = [
    row("a", { gitBranch: "main" }),
    row("b", { gitBranch: "other" }),
    row("c", { gitBranch: "main" }),
    row("d", { gitBranch: "main" }),
  ]
  expect(groupByWorktree(rows)![0]!.rows.map((r) => r.id)).toEqual(["a", "c", "d"])
})

test("group keys are distinct and stable", () => {
  const groups = groupByWorktree([
    row("a", { gitBranch: "main" }),
    row("b", { gitBranch: "feature" }),
  ])!
  expect(new Set(groups.map((g) => g.key)).size).toBe(2)
  // Same input, same keys — React must not see them churn between renders.
  const again = groupByWorktree([
    row("a", { gitBranch: "main" }),
    row("b", { gitBranch: "feature" }),
  ])!
  expect(again.map((g) => g.key)).toEqual(groups.map((g) => g.key))
})

// ---- key preference: worktreePath ?? branch --------------------------------

test("worktreePath takes precedence over branch when both are present", () => {
  expect(groupKeyOf(row("a", { gitBranch: "main", worktreePath: "/wt/one" }))).toBe("wt:/wt/one")
  expect(groupKeyOf(row("b", { gitBranch: "main" }))).toBe("br:main")
  expect(groupKeyOf(row("c"))).toBeNull()
})

test("two worktrees on the SAME branch are still two groups", () => {
  // They are separate working copies with separate files; merging them by branch
  // name would tell the reader something untrue.
  const rows = [
    row("a", { gitBranch: "main", worktreePath: "/wt/one" }),
    row("b", { gitBranch: "main", worktreePath: "/wt/two" }),
  ]
  const groups = groupByWorktree(rows)!
  expect(groups).toHaveLength(2)
  expect(groups.map((g) => g.key)).toEqual(["wt:/wt/one", "wt:/wt/two"])
})

test("a worktree with no branch (detached) is labelled by its folder", () => {
  const rows = [
    row("a", { gitBranch: "main" }),
    row("b", { worktreePath: "/state/worktrees/widget-detached" }),
  ]
  expect(groupByWorktree(rows)![1]).toMatchObject({
    label: "widget-detached",
    linked: true,
  })
})

test("the main checkout and a worktree on the same branch do not collapse together", () => {
  const rows = [
    row("a", { gitBranch: "main" }),
    row("b", { gitBranch: "main", worktreePath: "/wt/copy" }),
  ]
  const groups = groupByWorktree(rows)!
  expect(groups.map((g) => g.key)).toEqual(["br:main", "wt:/wt/copy"])
})

// ---- search-then-group -----------------------------------------------------

test("filtering BEFORE grouping collapses a narrowed list back to flat", () => {
  // The Sidebar filters by query and only then groups. A search that lands
  // inside one branch must stop showing headers, not show one lonely header.
  const all = [
    row("a", { gitBranch: "main" }),
    row("b", { gitBranch: "feature" }),
    row("c", { gitBranch: "feature" }),
  ]
  expect(groupByWorktree(all)).not.toBeNull()
  const narrowed = all.filter((r) => r.gitBranch === "feature")
  expect(groupByWorktree(narrowed)).toBeNull()
})

test("filtering that still spans branches keeps its headers", () => {
  const all = [
    row("a", { gitBranch: "main" }),
    row("b", { gitBranch: "feature" }),
    row("c", { gitBranch: "feature" }),
  ]
  const narrowed = all.filter((r) => r.id !== "c")
  expect(groupByWorktree(narrowed)!.map((g) => g.label)).toEqual(["main", "feature"])
})

// ---- no row is ever lost ---------------------------------------------------

test("grouping never drops or duplicates a row", () => {
  const rows = [
    row("a", { gitBranch: "main" }),
    row("b", { gitBranch: "feature", worktreePath: "/wt/f" }),
    row("c", { gitBranch: "main" }),
    row("d", { gitBranch: "third" }),
  ]
  const groups = groupByWorktree(rows)!
  const flattened = groups.flatMap((g) => g.rows.map((r) => r.id))
  expect(flattened.sort()).toEqual(["a", "b", "c", "d"])
  expect(flattened).toHaveLength(rows.length)
})
