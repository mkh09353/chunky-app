import { describe, expect, test } from "bun:test"
import type { ListeningPort } from "@chunky/protocol"
import { renderToStaticMarkup } from "react-dom/server"
import {
  PortsList,
  portRowActions,
  portSubtitle,
  SessionPortsPopover,
  type PortOpeners,
} from "./SessionPortsPopover"
import { TooltipProvider } from "./ui/tooltip"

const PORT = (overrides: Partial<ListeningPort> = {}): ListeningPort => ({
  port: 3000,
  address: "127.0.0.1",
  pid: 4242,
  command: "ruby",
  taskId: "task-1",
  url: "http://localhost:3000/",
  ...overrides,
})

/** There is no DOM in this test runner (no happy-dom/jsdom installed), so the
 *  markup assertions go through the server renderer and the click behaviour is
 *  asserted on `portRowActions` — the same descriptors the buttons render. */
function html(node: React.ReactNode): string {
  return renderToStaticMarkup(<TooltipProvider>{node}</TooltipProvider>)
}

function spyOpeners(): PortOpeners & { app: string[]; external: string[] } {
  const app: string[] = []
  const external: string[] = []
  return {
    app,
    external,
    openInApp: (url) => app.push(url),
    openExternally: (url) => external.push(url),
  }
}

describe("SessionPortsPopover", () => {
  test("renders nothing at all when the session is listening on nothing", () => {
    expect(html(<SessionPortsPopover ports={[]} />)).toBe("")
  })

  test("renders a header trigger with a port count once ports exist", () => {
    const markup = html(
      <SessionPortsPopover ports={[PORT(), PORT({ port: 5173, taskId: "task-2" })]} />,
    )
    expect(markup).toContain('aria-label="Forwarded ports"')
    // Count badge on the icon.
    expect(markup).toContain('data-slot="ports-count"')
    expect(markup).toContain(">2<")
    // The header is a native drag region: the trigger must opt out.
    expect(markup).toContain("electrobun-webkit-app-region-no-drag")
  })

  test("renders one row per port with its command and address", () => {
    const markup = html(
      <PortsList
        ports={[
          PORT(),
          PORT({ port: 5173, command: "bun", address: "0.0.0.0", taskId: "task-2" }),
        ]}
      />,
    )
    expect(markup).toContain("Ports")
    expect(markup).toContain(">3000<")
    expect(markup).toContain("ruby · 127.0.0.1")
    expect(markup).toContain(">5173<")
    expect(markup).toContain("bun · 0.0.0.0")
    expect(markup).toContain('aria-label="Open port 3000 in Chunky browser"')
    expect(markup).toContain('aria-label="Open port 3000 in default browser"')
  })

  test("a port with no URL renders both actions disabled", () => {
    const markup = html(<PortsList ports={[PORT({ port: 6379, command: "redis", url: null })]} />)
    expect(markup).toContain(">6379<")
    expect(markup).toContain("redis · 127.0.0.1")
    // Two disabled buttons in that row, and nothing else in the list.
    expect(markup.match(/disabled=""/g)?.length).toBe(2)

    const openers = spyOpeners()
    for (const action of portRowActions(PORT({ url: null }), openers)) {
      expect(action.disabled).toBe(true)
      // Even if something managed to invoke it, there is no URL to open.
      action.run()
    }
    expect(openers.app).toEqual([])
    expect(openers.external).toEqual([])
  })

  test("the row actions call the in-app and system browser openers", () => {
    const openers = spyOpeners()
    const [inApp, external] = portRowActions(PORT(), openers)

    expect(inApp!.disabled).toBe(false)
    expect(external!.disabled).toBe(false)
    inApp!.run()
    external!.run()

    expect(openers.app).toEqual(["http://localhost:3000/"])
    expect(openers.external).toEqual(["http://localhost:3000/"])
  })

  test("the subtitle tolerates a port with no command or address", () => {
    expect(portSubtitle(PORT({ command: "", address: "" }))).toBe("")
    expect(portSubtitle(PORT({ command: "node", address: "" }))).toBe("node")
  })
})
