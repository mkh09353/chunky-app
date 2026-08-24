// Stopping a delegate from its anchor card, and what a stopped one looks like.
//
// There is no DOM in this runner (no happy-dom/jsdom installed — see
// SessionPortsPopover.test.tsx), so these render to static markup and assert on
// the control's own hooks (`data-run-stop`, `data-run-cancelled`) plus the pure
// targeting rule the components gate on.
import { describe, expect, test } from "bun:test"
import type { AgentEvent } from "@chunky/protocol"
import { renderToStaticMarkup } from "react-dom/server"
import { AgentCard } from "./AgentCard"
import { LiveRunSection, LiveRunsProvider, StopRunButton } from "./LiveRun"
import { MessageView } from "./Message"
import type { LiveRunsValue } from "./LiveRun"
import type { LiveRunView } from "~/lib/runs"
import type { Message } from "~/lib/mock"
import { initialState, MAIN, reduce } from "~/lib/transcript"
import type { TranscriptState } from "~/lib/transcript"
import { applyRunAnchors, itemsToMessages } from "~/lib/mapTranscript"
import { liveRunViews, runAnchors, runsById } from "~/lib/runs"

function html(node: React.ReactNode): string {
  return renderToStaticMarkup(node)
}

const VIEW = (overrides: Partial<LiveRunView> = {}): LiveRunView => ({
  runId: "sess-1:sidekick:frontend#0",
  threadId: "sess-1:sidekick:frontend",
  title: "Sidekick (frontend)",
  toolCount: 2,
  lines: [{ text: "› bash bun test", tone: "cmd" }],
  ...overrides,
})

describe("StopRunButton", () => {
  test("is a labelled control, not a link or a form submit", () => {
    const markup = html(<StopRunButton onStop={() => {}} label="Stop Sidekick (frontend)" />)
    expect(markup).toContain('type="button"')
    expect(markup).toContain('data-run-stop=""')
    expect(markup).toContain('aria-label="Stop Sidekick (frontend)"')
  })

  test("the live section shows it only when a stop handler is given", () => {
    expect(html(<LiveRunSection view={VIEW()} onStop={() => {}} />)).toContain("data-run-stop")
    // No handler (demo/offline, or a server without the endpoint): no control.
    expect(html(<LiveRunSection view={VIEW()} />)).not.toContain("data-run-stop")
  })
})

/** A turn that briefs a sidekick, plus whatever happens to it next. */
function play(events: AgentEvent[]): TranscriptState {
  return events.reduce(reduce, initialState)
}

const BRIEFED: AgentEvent[] = [
  { type: "message.start", role: "assistant" },
  { type: "message.delta", text: "Handing off." },
  { type: "tool.start", id: "t1", name: "sidekick", input: { seat: "frontend" } },
  {
    type: "thread.spawn",
    threadId: "sess-1:sidekick:frontend",
    parentThreadId: MAIN,
    title: "Sidekick (frontend)",
  },
  { type: "message.start", role: "assistant", threadId: "sess-1:sidekick:frontend" },
  { type: "message.delta", text: "On it.", threadId: "sess-1:sidekick:frontend" },
]

/** Render the main transcript the way ChatView does: anchors applied, runs
 *  context supplied. */
function renderTranscript(state: TranscriptState, onStopRun?: LiveRunsValue["onStopRun"]): string {
  const messages: Message[] = applyRunAnchors(
    itemsToMessages(state.threads[MAIN]!.items),
    runAnchors(state),
  )
  const value: LiveRunsValue = {
    views: liveRunViews(state),
    elapsedOf: () => undefined,
    runs: runsById(state),
    ...(onStopRun ? { onStopRun } : {}),
  }
  return html(
    <LiveRunsProvider value={value}>
      {messages.map((message) => (
        <MessageView key={message.id} message={message} />
      ))}
    </LiveRunsProvider>,
  )
}

describe("the delegate pill", () => {
  test("offers Stop while a targetable delegate is running", () => {
    const markup = renderTranscript(play(BRIEFED), () => {})
    expect(markup).toContain("data-run-stop")
    expect(markup).toContain("Sidekick (frontend)")
  })

  test("hides Stop when the run cannot be targeted — with the card still there", () => {
    // A plain spawned child: no stable seat, and no detached run id in the
    // spawning call's output, so there is nothing to send the server.
    const untargetable = play([
      { type: "tool.start", id: "t1", name: "spawn_thread", input: { title: "Recon" } },
      { type: "thread.spawn", threadId: "child-abc", parentThreadId: MAIN, title: "Recon" },
    ])
    const markup = renderTranscript(untargetable, () => {})
    // The pill itself MUST be on screen — otherwise this asserts nothing.
    expect(markup).toContain("data-run-pill")
    expect(markup).toContain("Recon")
    expect(markup).not.toContain("data-run-stop")
  })

  test("offers Stop for a DETACHED spawn, named by the run id in its own output", () => {
    const detached = play([
      { type: "tool.start", id: "t1", name: "spawn_thread", input: { title: "Recon" } },
      {
        type: "tool.end",
        id: "t1",
        ok: true,
        output:
          'Detached child "Recon" launched: 3f1c2a44-9b1e-4c77-8a55-1f2e3d4c5b6a. It runs concurrently.',
      },
      { type: "thread.spawn", threadId: "child-abc", parentThreadId: MAIN, title: "Recon" },
    ])
    expect(renderTranscript(detached, () => {})).toContain("data-run-stop")
    // …and nothing at all when the app has no handler to give it.
    expect(renderTranscript(detached)).not.toContain("data-run-stop")
  })

  test("hides Stop once the run has settled, and marks it cancelled", () => {
    const stopped = play([
      ...BRIEFED,
      { type: "thread.status", threadId: "sess-1:sidekick:frontend", status: "cancelled" },
    ])
    const markup = renderTranscript(stopped, () => {})
    expect(markup).not.toContain("data-run-stop")
    // The pill stays (a settled run keeps its card, titled by its delegate),
    // and says cancelled — not the destructive failure red. `data-run-pill` is
    // deliberately not asserted: applyRunAnchors sets it for LIVE runs only.
    expect(markup).toContain("Sidekick (frontend)")
    expect(markup).toContain("data-run-cancelled")
    expect(markup).toContain("Cancelled")
    expect(markup).not.toContain("text-destructive")
  })

  test("a run that finished normally says Done, with no cancelled marker", () => {
    const done = play([
      ...BRIEFED,
      { type: "thread.status", threadId: "sess-1:sidekick:frontend", status: "idle" },
    ])
    expect(renderTranscript(done, () => {})).not.toContain("data-run-cancelled")
  })
})

/** The case the first pass got wrong: a delegate stopped WHILE A TOOL WAS
 *  RUNNING. The reducer has to close that call, and everything that summarizes
 *  it must stay neutral instead of borrowing the failure treatment. */
const STOPPED_MID_TOOL = play([
  ...BRIEFED,
  {
    type: "tool.start",
    id: "t2",
    name: "bash",
    input: { command: "bun test" },
    threadId: "sess-1:sidekick:frontend",
  },
  { type: "thread.status", threadId: "sess-1:sidekick:frontend", status: "cancelled" },
])

describe("a delegate stopped mid-tool never renders as a failure", () => {
  test("the parked card's gist says cancelled, with no destructive styling", () => {
    const markup = html(
      <AgentCard
        variant="parked"
        transcript={STOPPED_MID_TOOL}
        threadId="sess-1:sidekick:frontend"
        run={STOPPED_MID_TOOL.runs[0]!}
      />,
    )
    expect(markup).toContain("Cancelled")
    expect(markup).toContain("cancelled")
    expect(markup).not.toContain("failed")
    expect(markup).not.toContain("✗")
    expect(markup).not.toContain("text-destructive")
  })

  test("the expanded delegate transcript marks the stopped call neutrally", () => {
    // ThreadDetail renders the delegate's own items; the stopped `bash` call is
    // the one that used to wear the red ✗.
    const markup = html(
      <MessageView
        message={
          itemsToMessages(STOPPED_MID_TOOL.threads["sess-1:sidekick:frontend"]!.items)[0]!
        }
      />,
    )
    expect(markup).toContain("data-tool-cancelled")
    expect(markup).not.toContain("text-destructive")
  })

  test("a call that genuinely failed keeps the failure treatment", () => {
    const failedThenStopped = play([
      ...BRIEFED,
      {
        type: "tool.start",
        id: "t2",
        name: "bash",
        input: { command: "bun test" },
        threadId: "sess-1:sidekick:frontend",
      },
      {
        type: "tool.end",
        id: "t2",
        ok: false,
        output: "error: 3 tests failed",
        threadId: "sess-1:sidekick:frontend",
      },
      { type: "thread.status", threadId: "sess-1:sidekick:frontend", status: "cancelled" },
    ])
    const markup = html(
      <MessageView
        message={
          itemsToMessages(failedThenStopped.threads["sess-1:sidekick:frontend"]!.items)[0]!
        }
      />,
    )
    expect(markup).toContain("text-destructive")
    expect(markup).not.toContain("data-tool-cancelled")
  })
})

describe("AgentCard status", () => {
  const stopped = play([
    ...BRIEFED,
    { type: "thread.status", threadId: "sess-1:sidekick:frontend", status: "cancelled" },
  ])

  test("a cancelled run reads Cancelled, quietly, and keeps its transcript", () => {
    const markup = html(
      <AgentCard
        variant="parked"
        transcript={stopped}
        threadId="sess-1:sidekick:frontend"
        run={stopped.runs[0]!}
      />,
    )
    expect(markup).toContain("data-run-cancelled")
    expect(markup).toContain("Cancelled")
    expect(markup).not.toContain(">Done<")
    // Distinct from a failure: muted, never destructive.
    expect(markup).toContain("text-muted-foreground")
    expect(markup).not.toContain("text-destructive")
    // The work it did before being stopped is still there.
    expect(markup).toContain("On it.")
  })

  test("a run that finished on its own still reads Done", () => {
    const done = play([
      ...BRIEFED,
      { type: "thread.status", threadId: "sess-1:sidekick:frontend", status: "idle" },
    ])
    const markup = html(
      <AgentCard
        variant="parked"
        transcript={done}
        threadId="sess-1:sidekick:frontend"
        run={done.runs[0]!}
      />,
    )
    expect(markup).toContain("Done")
    expect(markup).not.toContain("data-run-cancelled")
  })
})
