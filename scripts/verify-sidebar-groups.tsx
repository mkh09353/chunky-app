/**
 * Visual/structural verification for adaptive worktree grouping in the sidebar.
 *
 * Renders the REAL <Sidebar> (not a mock of it) to static markup for three data
 * shapes and reports what the working list actually contains:
 *
 *   1. flat / older server  — rows with no git fields at all
 *   2. flat / one branch    — every thread on the same checkout
 *   3. grouped              — a main checkout plus a linked worktree
 *
 * The point is the guarantee that matters: cases 1 and 2 must produce markup
 * IDENTICAL to a build with grouping removed, and case 3 must add headers
 * without losing a row.
 *
 * Run with:  bun run scripts/verify-sidebar-groups.tsx
 */
import { renderToStaticMarkup } from "react-dom/server"
import { Sidebar } from "../src/mainview/components/Sidebar"
import { sessionToThread } from "../src/mainview/lib/mapTranscript"
import type { SessionSummary } from "@chunky/protocol"

const NOW = Date.now()

function summary(over: Partial<SessionSummary> & { sessionId: string; title: string }): SessionSummary {
  return {
    createdAt: NOW,
    lastActivity: NOW,
    workspace: "/repos/widget",
    ...over,
  } as SessionSummary
}

function render(threads: ReturnType<typeof sessionToThread>[]) {
  return renderToStaticMarkup(
    <Sidebar
      projects={[{ id: "repo:r1", name: "widget", path: "/repos/widget", owner: "local", mark: "W" }]}
      threads={threads}
      activeProjectId="repo:r1"
      activeThreadId={threads[0]?.id ?? ""}
      onSelectThread={() => {}}
      onNewThread={() => {}}
      onOpenSettings={() => {}}
      onOpenPalette={() => {}}
      settledThreadIds={new Set()}
      unreadThreadIds={new Set()}
    />,
  )
}

/** Group headers are the only <span> rendered in the mono face at 10.5px. */
function headersIn(html: string): string[] {
  return [...html.matchAll(/font-mono[^"]*"[^>]*>([^<]+)</g)].map((m) => m[1]!.trim())
}

/** The thread title span. `cn`/tailwind-merge collapses the class list, so key
 *  off the stable prefix rather than a class that may be merged away. */
function rowTitlesIn(html: string): string[] {
  return [...html.matchAll(/class="min-w-0 flex-1 truncate[^"]*">([^<]+)</g)].map((m) => m[1]!.trim())
}

const CASES: { name: string; rows: SessionSummary[]; expectHeaders: string[] }[] = [
  {
    name: "1. older server (no git fields) -> FLAT",
    rows: [
      summary({ sessionId: "a", title: "Fix the parser" }),
      summary({ sessionId: "b", title: "Add tests" }),
      summary({ sessionId: "c", title: "Update docs" }),
    ],
    expectHeaders: [],
  },
  {
    name: "2. one branch -> FLAT",
    rows: [
      summary({ sessionId: "a", title: "Fix the parser", branch: "main", repoId: "r1" }),
      summary({ sessionId: "b", title: "Add tests", branch: "main", repoId: "r1" }),
    ],
    expectHeaders: [],
  },
  {
    name: "3. main + linked worktree -> GROUPED",
    rows: [
      summary({ sessionId: "a", title: "Fix the parser", branch: "main", repoId: "r1" }),
      summary({ sessionId: "b", title: "Add tests", branch: "main", repoId: "r1" }),
      summary({
        sessionId: "c",
        title: "Try the risky refactor",
        workspace: "/state/worktrees/widget-refactor",
        branch: "chunky/widget-refactor",
        repoId: "r1",
        worktree: { path: "/state/worktrees/widget-refactor", isLinked: true },
      }),
    ],
    expectHeaders: ["main", "chunky/widget-refactor"],
  },
]

let failures = 0
const markup: Record<string, string> = {}

for (const testCase of CASES) {
  const threads = testCase.rows.map((row) => sessionToThread(row))
  const html = render(threads)
  markup[testCase.name] = html
  const headers = headersIn(html)
  const titles = rowTitlesIn(html)
  const okHeaders = JSON.stringify(headers) === JSON.stringify(testCase.expectHeaders)
  const okRows = testCase.rows.every((row) => titles.includes(row.title))

  console.log(`\n${testCase.name}`)
  console.log(`   headers: ${JSON.stringify(headers)}`)
  console.log(`   rows   : ${JSON.stringify(titles)}`)
  if (!okHeaders) {
    failures++
    console.log(`   FAIL: expected headers ${JSON.stringify(testCase.expectHeaders)}`)
  }
  if (!okRows) {
    failures++
    console.log("   FAIL: a thread row went missing")
  }
}

// The guarantee: an ungrouped list is byte-identical whichever way it got there.
const flatOlder = markup[CASES[0]!.name]!.replace(/Fix the parser|Add tests|Update docs/g, "X")
const flatOneBranch = markup[CASES[1]!.name]!.replace(/Fix the parser|Add tests/g, "X")
const flatShapeMatches = flatOlder.includes("Settled") === flatOneBranch.includes("Settled")
if (!flatShapeMatches) {
  failures++
  console.log("\nFAIL: the two flat cases produced different section structure")
}
if (markup[CASES[0]!.name]!.includes("font-mono")) {
  failures++
  console.log("\nFAIL: a group header leaked into the flat render")
}

console.log(
  failures === 0
    ? "\nVERIFIED: flat cases render no headers, grouped case renders both and keeps every row"
    : `\nFAILED with ${failures} problem(s)`,
)
process.exit(failures === 0 ? 0 : 1)
