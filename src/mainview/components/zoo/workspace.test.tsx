// Render smoke tests for the Zoo workspace: the shell, a full decision card,
// and the detail pane. They catch the failures a type check cannot — a card
// that forgets its evidence, actions, or decision log.
// Run with: bun test src/mainview/components/zoo
import { expect, describe, it } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { TooltipProvider } from "../ui/tooltip"
import { ZooWorkspace } from "./ZooWorkspace"
import { InboxView, invokeInboxJam } from "./InboxView"
import { BoardView, invokeBoardJam } from "./BoardView"
import { DetailPane } from "./DetailPane"
import { addPaths, createAndAssignArea, togglePath } from "./AreaSwitcher"
import { IDLE_RUNS, SourcesView } from "./SourcesView"
import { buildInbox } from "~/lib/zooInbox"
import type { ZooArea, ZooIdea, ZooInsight, ZooItem } from "~/lib/zoo"

const areas: ZooArea[] = [
  { id: "a-pay", name: "Payments", repoPaths: ["/tmp/payments"], createdAt: 900 },
  { id: "a-growth", name: "Growth", createdAt: 950 },
]

const insights: ZooInsight[] = [
  {
    id: "i-1",
    passId: "p-1",
    title: "Silent card declines",
    summary: "Three teams reported payments failing with no error.",
    priority: 1,
    evidence: [{ artifactId: "a-1", quote: "The charge just vanished, no email, nothing." }],
    createdAt: 1000,
  },
  {
    id: "i-2",
    passId: "p-2",
    title: "Nobody finds the export button",
    summary: "Support keeps pasting the same screenshot.",
    evidence: [{ artifactId: "a-2", quote: "Where do I download the CSV?" }],
    createdAt: 2000,
  },
]

const ideas: ZooIdea[] = [
  {
    id: "d-1",
    type: "build",
    title: "Retry failed payments",
    rationale: "Silent declines cost real money.",
    status: "promoted",
    insightIds: ["i-1"],
    areaId: "a-pay",
    createdAt: 1000,
    itemId: "t-1",
  },
  {
    id: "d-2",
    type: "investigate",
    title: "Move the export button",
    rationale: "Support cost is measurable.",
    status: "proposed",
    insightIds: [],
    createdAt: 3000,
  },
]

const items: ZooItem[] = [
  {
    id: "t-1",
    ideaId: "d-1",
    title: "Retry failed payments",
    stage: "decision",
    areaId: "a-pay",
    sessionIds: ["s-42"],
    decisions: [
      { at: 1500, actor: "user", note: "Promoted for research" },
      { at: 2500, actor: "agent", note: "Research done: the retry hook already exists." },
    ],
    createdAt: 1000,
    updatedAt: 2500,
  },
]

const entries = buildInbox({ ideas, items, insights })

describe("ZooWorkspace", () => {
  it("renders the three zones and the Talk to the Factory affordance", () => {
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <ZooWorkspace baseUrl={null} repoId={null} onOpenChat={() => {}} />
      </TooltipProvider>,
    )
    expect(html).toContain("The Zoo")
    expect(html).toContain("Inbox")
    expect(html).toContain("Board")
    expect(html).toContain("Sources")
    expect(html).toContain("Talk to the Factory")
  })

  it("degrades to an explanation instead of crashing without the native bridge", () => {
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <ZooWorkspace baseUrl={null} repoId={null} onOpenChat={() => {}} />
      </TooltipProvider>,
    )
    expect(html).toContain("requires the desktop app")
    expect(html).toContain("Open chat instead")
  })
})

describe("Inbox decision cards", () => {
  const html = renderToStaticMarkup(
    <TooltipProvider>
      <InboxView
        entries={entries}
        inFlight={[]}
        selectedId={entries[0]?.id ?? null}
        onSelect={() => {}}
        context={{ repoId: "r-1", baseUrl: "http://localhost:4620" }}
        areas={areas}
        showAreas
        onRefresh={async () => {}}
        onSetAside={() => {}}
        onSynthesize={() => {}}
        onOpenSession={() => {}}
        loading={false}
      />
    </TooltipProvider>,
  )

  it("shows every waiting decision with its verdict actions", () => {
    expect(html).toContain("3 decisions waiting on you")
    expect(html).toContain("Retry failed payments")
    expect(html).toContain("Move the export button")
    expect(html).toContain("Go — approve")
    expect(html).toContain("Go — promote it")
    expect(html).toContain("Not now")
    expect(html).toContain("Add a note")
  })

  it("carries the evidence inline", () => {
    expect(html).toContain("Silent card declines")
    expect(html).toContain("The charge just vanished, no email, nothing.")
  })

  it("offers synthesis on signals nothing cites yet", () => {
    expect(html).toContain("1 fresh signal with nothing proposed yet")
    expect(html).toContain("Synthesize ideas")
  })

  it("gives an ordinary proposed idea a direct Jam action without selecting or promoting it", () => {
    const ideaEntry = entries.find((entry) => entry.kind === "idea" && entry.idea?.status === "proposed")!
    const direct = renderToStaticMarkup(<TooltipProvider><InboxView entries={[ideaEntry]} inFlight={[]} selectedId={null} onSelect={() => {}} context={{ repoId: "r-1", baseUrl: "http://chunky" }} areas={areas} showAreas={false} onRefresh={async () => {}} onSetAside={() => {}} loading={false} onStartJam={() => {}} /></TooltipProvider>)
    expect(direct).toContain("Go — promote it")
    expect(direct).toContain("Jam")
    const calls = { jammed: "", selected: false, prevented: 0, stopped: 0 }
    invokeInboxJam({ preventDefault: () => { calls.prevented++ }, stopPropagation: () => { calls.stopped++ } }, ideaEntry, (entry) => { calls.jammed = entry.idea?.id ?? "" })
    expect(calls.jammed).toBe("d-2"); expect(calls.selected).toBe(false); expect(ideaEntry.idea?.status).toBe("proposed"); expect(calls.prevented).toBe(1); expect(calls.stopped).toBe(1)
  })

  it("gives an ordinary item a direct Jam action without selecting or advancing it", () => {
    const itemEntry = entries.find((entry) => entry.kind === "item")!
    const direct = renderToStaticMarkup(<TooltipProvider><InboxView entries={[itemEntry]} inFlight={[]} selectedId={null} onSelect={() => {}} context={{ repoId: "r-1", baseUrl: "http://chunky" }} areas={areas} showAreas={false} onRefresh={async () => {}} onSetAside={() => {}} loading={false} onStartJam={() => {}} /></TooltipProvider>)
    expect(direct).toContain("Go — approve")
    expect(direct).toContain("Jam")
    const calls = { jammed: "", selected: false }
    invokeInboxJam({ preventDefault: () => {}, stopPropagation: () => {} }, itemEntry, (entry) => { calls.jammed = entry.item?.id ?? "" })
    expect(calls.jammed).toBe("t-1"); expect(calls.selected).toBe(false); expect(itemEntry.item?.stage).toBe("decision")
  })
})

describe("Board direct Jam actions", () => {
  it("offers proposed ideas a direct Jam callback without selecting or promoting", () => {
    const idea = ideas.find((entry) => entry.status === "proposed")!
    const html = renderToStaticMarkup(<TooltipProvider><BoardView ideas={ideas} items={items} areas={areas} showAreas selectedId={null} onSelectIdea={() => {}} onSelectItem={() => {}} onStartIdeaJam={() => {}} onStartItemJam={() => {}} /></TooltipProvider>)
    expect(html).toContain("Move the export button")
    expect((html.match(/Jam/g) ?? []).length).toBe(2)
    const calls = { jammed: "", selected: false, stopped: 0 }
    invokeBoardJam({ preventDefault: () => {}, stopPropagation: () => { calls.stopped++ } }, idea, (target) => { calls.jammed = target.id })
    expect(calls.jammed).toBe("d-2"); expect(calls.selected).toBe(false); expect(idea.status).toBe("proposed"); expect(calls.stopped).toBe(1)
  })

  it("offers items a direct Jam callback without selecting or advancing", () => {
    const item = items[0]!
    const calls = { jammed: "", selected: false, prevented: 0 }
    invokeBoardJam({ preventDefault: () => { calls.prevented++ }, stopPropagation: () => {} }, item, (target) => { calls.jammed = target.id })
    expect(calls.jammed).toBe("t-1"); expect(calls.selected).toBe(false); expect(item.stage).toBe("decision"); expect(calls.prevented).toBe(1)
  })
})

describe("DetailPane", () => {
  it("shows the full evidence and the decision log for the selected item", () => {
    const entry = entries.find((row) => row.item?.id === "t-1")!
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <DetailPane entry={entry} areas={areas} onAssignArea={() => {}} onClose={() => {}} onOpenSession={() => {}} />
      </TooltipProvider>,
    )
    expect(html).toContain("Retry failed payments")
    expect(html).toContain("Evidence · 1")
    expect(html).toContain("Silent card declines")
    expect(html).toContain("Decision log · 2")
    expect(html).toContain("Research done: the retry hook already exists.")
    expect(html).toContain("Sessions · 1")
    expect(html).toContain("s-42")
    expect(html).toContain("Jam")
  })

  it("becomes a full-width detail surface with an explicit Back label in narrow Zoo containers", () => {
    const entry = entries.find((row) => row.idea?.id === "d-2")!
    const html = renderToStaticMarkup(<TooltipProvider><DetailPane entry={entry} areas={areas} onClose={() => {}} /></TooltipProvider>)
    expect(html).toContain("@max-[46rem]/zoo-body:min-w-0")
    expect(html).toContain("@max-[46rem]/zoo-body:w-auto")
    expect(html).toContain("@max-[46rem]/zoo-body:flex-1")
    expect(html).toContain("@max-[46rem]/zoo-body:basis-0")
    expect(html).toContain("@max-[46rem]/zoo-body:shrink")
    expect(html).toContain("@max-[46rem]/zoo-body:border-l-0")
    expect(html).toContain("Back")
    expect(html).toContain('aria-label="Close detail"')
  })
})

describe("card working sessions", () => {
  it("offers jam for a proposed idea and research repair for an un-sessioned item", () => {
    const proposed = entries.find((entry) => entry.idea?.id === "d-2")!
    const ideaHtml = renderToStaticMarkup(<TooltipProvider><DetailPane entry={proposed} areas={areas} onClose={() => {}} onStartJam={() => {}} /></TooltipProvider>)
    expect(ideaHtml).toContain("Working sessions")
    expect(ideaHtml).toContain("Jam")
    const repair = { ...items[0]!, stage: "research" as const, sessionIds: [] }
    const repairEntry = { ...entries.find((entry) => entry.item?.id === "t-1")!, item: repair }
    const itemHtml = renderToStaticMarkup(<TooltipProvider><DetailPane entry={repairEntry} areas={areas} onClose={() => {}} onStartJam={() => {}} onStartResearch={() => {}} /></TooltipProvider>)
    expect(itemHtml).toContain("Start research session")
  })
})

// ---- Areas in the workspace ------------------------------------------------

function inbox(showAreas: boolean) {
  return renderToStaticMarkup(
    <TooltipProvider>
      <InboxView
        entries={entries}
        inFlight={[]}
        selectedId={null}
        onSelect={() => {}}
        context={{ repoId: "r-1", baseUrl: "http://localhost:4620" }}
        areas={areas}
        showAreas={showAreas}
        onRefresh={async () => {}}
        onSetAside={() => {}}
        onSynthesize={() => {}}
        onOpenSession={() => {}}
        loading={false}
      />
    </TooltipProvider>,
  )
}

describe("area switcher", () => {
  it("opens on All areas and keeps the menu itself out of the way", () => {
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <ZooWorkspace baseUrl={null} repoId={null} onOpenChat={() => {}} />
      </TooltipProvider>,
    )
    expect(html).toContain("All areas")
    expect(html).toContain('aria-label="Switch area"')
  })
})

describe("area badges", () => {
  it("badges each card with its area under All areas", () => {
    const html = inbox(true)
    expect(html).toContain("Area: Payments")
  })

  it("drops the badge when a single area is already selected", () => {
    expect(inbox(false)).not.toContain("Area: Payments")
  })

  it("badges board cards the same way", () => {
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <BoardView
          ideas={ideas}
          items={items}
          areas={areas}
          showAreas
          selectedId={null}
          onSelectIdea={() => {}}
          onSelectItem={() => {}}
        />
      </TooltipProvider>,
    )
    expect(html).toContain("Area: Payments")
    expect(html).toContain("Retry failed payments")
  })
})

describe("DetailPane area assignment", () => {
  it("shows the item's area and offers to move it", () => {
    const entry = entries.find((row) => row.item?.id === "t-1")!
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <DetailPane entry={entry} areas={areas} onAssignArea={() => {}} onClose={() => {}} />
      </TooltipProvider>,
    )
    expect(html).toContain("Area")
    expect(html).toContain("Payments")
    expect(html).toContain('aria-label="Change area"')
  })

  it("says so plainly when a row belongs to no area", () => {
    const unassigned = entries.find((row) => row.idea?.id === "d-2")!
    expect(unassigned.areaId).toBeUndefined()
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <DetailPane entry={unassigned} areas={areas} onAssignArea={() => {}} onClose={() => {}} />
      </TooltipProvider>,
    )
    expect(html).toContain("Unassigned")
    expect(html).toContain("visible in every area")
  })
})

describe("area repository binding", () => {
  it("allows triage when an area can supply the repository binding", () => {
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <SourcesView
          status={{ sources: [], artifactCount: 1, insightCount: 0, ideaCount: 0, itemCount: 0, passes: [] }}
          sources={[]}
          areaId="a-pay"
          areaName="Payments"
          runs={IDLE_RUNS}
          elapsed={0}
          onRun={() => {}}
          onRefresh={async () => {}}
          baseUrl="http://localhost:4620"
          canTriage
          insightCount={0}
          watches={[]}
          areas={areas}
          watchHour={8}
          xWatches={[]}
          xWatchIntervalMinutes={60}
          xWatchLastSuccessAt={null}
          watchLastRunAt={null}
          onAssignArea={() => {}}
          onOpenSetup={() => {}}
        />
      </TooltipProvider>,
    )
    expect(html).toContain("Triage backlog")
    expect(html).toContain("Add a source with Chunky")
    expect(html).toContain("Add source")
    expect(html).not.toContain("Select a repository or configure this area&#x27;s repo path")
  })
})

describe("competitor watch section", () => {
  it("renders seeded watches with status, area assignment, and pending synthesis", () => {
    const now = Date.now()
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <SourcesView
          status={{ sources: [], artifactCount: 1, insightCount: 0, ideaCount: 0, itemCount: 0, passes: [] }}
          sources={[]}
          areaId={null}
          areaName={null}
          runs={IDLE_RUNS}
          elapsed={0}
          onRun={() => {}}
          onRefresh={async () => {}}
          baseUrl="http://localhost:4620"
          canTriage
          insightCount={0}
          watches={[{ id: "w-1", sourceId: "s-1", owner: "pingdotgg", name: "t3code", label: "pingdotgg/t3code", areaId: "a-pay", lastCheckAt: now - 1000, lastStatus: "ok", lastNote: "Recorded 1 tag", lastArtifactAt: now - 1000, createdAt: now - 2000 }]}
          areas={areas}
          watchHour={8}
          xWatches={[]}
          xWatchIntervalMinutes={60}
          xWatchLastSuccessAt={null}
          watchLastRunAt={now - 1000}
          onAssignArea={() => {}}
          onOpenSetup={() => {}}
        />
      </TooltipProvider>,
    )
    expect(html).toContain("Competitor watch")
    expect(html).toContain("pingdotgg/t3code")
    expect(html).toContain("Recorded 1 tag")
    expect(html).toContain("Synthesize new activity")
    expect(html).toContain("Area: Payments")
    expect(html).toContain("@container/watch")
    expect(html).toContain("@min-[32rem]/watch:flex-row")
    expect(html).toContain("break-all")
  })
})

describe("X Watch section", () => {
  it("renders handles, interval, last status, area, and pending extraction", () => {
    const now = Date.now()
    const html = renderToStaticMarkup(<TooltipProvider><SourcesView status={{ sources: [], artifactCount: 1, insightCount: 0, ideaCount: 0, itemCount: 0, passes: [] }} sources={[]} areaId={null} areaName={null} runs={IDLE_RUNS} elapsed={0} onRun={() => {}} onRefresh={async () => {}} baseUrl="http://localhost:4620" canTriage insightCount={0} watches={[]} areas={areas} watchHour={8} watchLastRunAt={null} xWatches={[{ id: "x-1", sourceId: "sx-1", handle: "theo", label: "@theo", areaId: "a-pay", lastAttemptAt: now - 1000, lastSuccessAt: now - 2000, lastStatus: "ok", lastNote: "Recorded 1 new post", lastArtifactAt: now - 1000, createdAt: now - 3000 }]} xWatchIntervalMinutes={60} xWatchLastSuccessAt={now - 2000} onAssignArea={() => {}} onOpenSetup={() => {}} /></TooltipProvider>)
    expect(html).toContain("X Watch")
    expect(html).toContain("@theo")
    expect(html).toContain("Recorded 1 new post")
    expect(html).toContain("Extract new posts")
    expect(html).toContain("Area: Payments")
    expect(html).toContain("60 min")
    expect(html).toContain("@container/x-watch")
    expect(html).toContain("@min-[32rem]/x-watch:flex-row")
    expect(html).toContain("break-all")
  })
})

describe("inline area creation from the assignment menu", () => {
  it("assigns the row to the area it just created", async () => {
    const assigned: string[] = []
    const failure = await createAndAssignArea(
      async () => ({ ok: true, areaId: "a-new" }),
      (areaId) => assigned.push(areaId),
    )
    expect(failure).toBeNull()
    expect(assigned).toEqual(["a-new"])
  })

  it("leaves the row where it was when the create fails", async () => {
    const assigned: string[] = []
    const failure = await createAndAssignArea(
      async () => ({ ok: false, error: "An area named “Payments” already exists." }),
      (areaId) => assigned.push(areaId),
    )
    expect(failure).toContain("already exists")
    expect(assigned).toEqual([])
  })
})

describe("area repository picker", () => {
  it("checks and unchecks a registered repository, keeping order", () => {
    expect(togglePath(["/tmp/a"], "/tmp/b")).toEqual(["/tmp/a", "/tmp/b"])
    // Trailing slashes are the same repository, as the binding sees it.
    expect(togglePath(["/tmp/a", "/tmp/b"], "/tmp/a/")).toEqual(["/tmp/b"])
  })

  it("adds hand-typed paths without duplicating what is already configured", () => {
    expect(addPaths(["/tmp/a"], " /tmp/b \n/tmp/a\n\n")).toEqual(["/tmp/a", "/tmp/b"])
  })
})
