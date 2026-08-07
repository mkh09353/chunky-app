// Adaptive worktree/branch grouping for the sidebar's working list.
//
// Sessions are grouped by repository already (that is what the repo tab IS), so
// a second level only earns its pixels when the repo actually has more than one
// checkout in play: a `/fork --worktree` child, or threads sitting on different
// branches. One group is not a grouping — it is a header restating the tab.
//
// Hence the shape of this module: it returns `null` for "do not group", and the
// Sidebar renders EXACTLY what it renders today whenever it sees null. That way
// the flat case cannot drift as this rule changes, and the rule itself can be
// tested without React.
//
// `null` covers three separate situations that must all look identical on
// screen:
//
//   · an older server, which sends no `branch`/`worktree` fields at all
//     (SessionSummary's grouping fields are optional precisely so this degrades)
//   · a resolver that could not answer (no git, detached HEAD, path gone)
//   · a perfectly healthy repo where every thread is on one checkout
//
// The server is the only authority for which worktree/branch a session belongs
// to (see ../../../chunky/packages/server/src/worktrees.ts). Nothing here
// inspects paths, runs git, or infers identity — it only decides presentation
// from fields the row already carries.
//
// Pure — run with: bun test src/mainview/lib/sessionGroups.test.ts

/** The grouping fields a row must expose. Structural, so a `Thread` satisfies
 *  it and a test can pass three fields. */
export interface GroupableThread {
  id: string
  /** Real git branch for this session's workspace, when the server resolved one. */
  gitBranch?: string
  /** Set only when the session runs in a LINKED worktree, not the main checkout. */
  worktreePath?: string
}

export interface SessionGroup<T> {
  /** Stable React key. Distinct per group within one list. */
  key: string
  /** What the header reads. The branch when known, else the worktree folder. */
  label: string
  /** True for a linked worktree, so the header can mark it as one. */
  linked: boolean
  rows: T[]
}

/**
 * The grouping key for one row.
 *
 * `worktreePath` wins over `branch` deliberately. Two linked worktrees can sit
 * on the same branch name (or on none at all, detached), and they are still two
 * separate working copies with separate files — collapsing them into one group
 * would tell the reader something untrue. A row with neither field cannot be
 * placed and is what makes the whole list fall back to flat.
 */
export function groupKeyOf(thread: GroupableThread): string | null {
  if (thread.worktreePath) return `wt:${thread.worktreePath}`
  if (thread.gitBranch) return `br:${thread.gitBranch}`
  return null
}

/** The last path segment, for labelling a worktree that has no branch. */
function folderName(path: string): string {
  const parts = path.split("/").filter(Boolean)
  return parts[parts.length - 1] ?? path
}

/**
 * Group an already-ordered, already-filtered list by worktree/branch — or
 * return `null`, meaning "render this list exactly as it is".
 *
 * Null is returned when:
 *   · any row cannot be placed (missing fields → older server / failed
 *     resolution). Grouping a list while silently dropping rows into an
 *     "Other" bucket would be worse than not grouping at all.
 *   · fewer than two distinct groups exist. One group is the repo tab again.
 *
 * Order is never reinvented: groups appear in the order their first row appears
 * in `rows`, and rows keep their order inside a group. The server decides what
 * comes first; this only inserts headers.
 */
export function groupByWorktree<T extends GroupableThread>(
  rows: readonly T[],
): SessionGroup<T>[] | null {
  if (rows.length === 0) return null

  const groups = new Map<string, SessionGroup<T>>()
  for (const row of rows) {
    const key = groupKeyOf(row)
    // One unplaceable row means the grouping would be a partial truth. Flat.
    if (!key) return null
    const existing = groups.get(key)
    if (existing) {
      existing.rows.push(row)
      continue
    }
    groups.set(key, {
      key,
      label: row.gitBranch || (row.worktreePath ? folderName(row.worktreePath) : key),
      linked: !!row.worktreePath,
      rows: [row],
    })
  }

  // A single group is just the repo tab restated — not worth a header.
  if (groups.size < 2) return null
  return [...groups.values()]
}
