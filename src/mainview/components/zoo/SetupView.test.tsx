import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { TooltipProvider } from "../ui/tooltip"
import { SetupView } from "./SetupView"

test("renders guided repository setup and the dedicated names-only password surface", () => {
  const html = renderToStaticMarkup(<TooltipProvider><SetupView baseUrl="http://chunky" repoId={null} repositoryMessage="Choose a repository" onBack={() => {}} /></TooltipProvider>)
  expect(html).toContain("Add source")
  expect(html).toContain("New setup conversation")
  expect(html).toContain("Do not paste passwords, API keys, tokens")
  expect(html).toContain("Choose a repository")
  expect(html).toContain("Setup conversations")
  expect(html).toContain("Named source credentials")
  expect(html).toContain("never displayed after saving")
  expect(html).toContain('type="password"')
  expect(html).toContain("Provider and Linear keys")
  expect(html).toContain("Back to Sources")
})
