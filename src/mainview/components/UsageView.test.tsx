import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { UsageView } from "./UsageView"
import { TooltipProvider } from "./ui/tooltip"

/** Same constraint as SessionPortsPopover.test.tsx: no DOM in this runner, so
 *  the assertions go through the server renderer. Effects (and therefore the
 *  HTTP fetch and the app-sampler RPC) never run here — which is exactly the
 *  pre-endpoint state the Resources section must survive: it renders nothing at
 *  all, for both the server half and the app half. */
function html(node: React.ReactNode): string {
  return renderToStaticMarkup(<TooltipProvider>{node}</TooltipProvider>)
}

describe("UsageView — resources section", () => {
  test("renders without the resources endpoint and shows no section", () => {
    const markup = html(<UsageView baseUrl={null} sessionId={null} />)
    expect(markup).toContain("Usage")
    expect(markup).not.toContain("Server resources")
    expect(markup).not.toContain("App (this machine)")
    expect(markup).not.toContain("Collecting samples")
    expect(markup).not.toContain("excludes WebKit content processes")
  })

  test("a live base URL still renders no section before any response", () => {
    const markup = html(<UsageView baseUrl="http://localhost:4620" sessionId="s1" />)
    expect(markup).not.toContain("Server resources")
    expect(markup).not.toContain("App (this machine)")
  })
})
