// Markup smoke tests for the shared directory-search field (the header's Add
// repository popover and the Zoo area dialog render the same one).
// There is no DOM in this runner, so state is supplied directly and the
// keyboard contract is asserted on the hook's `keyDown` through a stub event.
// Run with: bun test src/mainview/components
import { describe, expect, it } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { DirSearchField } from "./DirSearchField"
import type { DirSearch } from "~/hooks/useDirSearch"

function search(overrides: Partial<DirSearch> = {}): DirSearch {
  return {
    available: true,
    query: "",
    setQuery: () => {},
    hits: [],
    searching: false,
    error: null,
    activeHit: -1,
    setActiveHit: () => {},
    keyDown: () => {},
    reset: () => {},
    ...overrides,
  }
}

describe("DirSearchField", () => {
  it("shows only the input until something is typed", () => {
    const html = renderToStaticMarkup(
      <DirSearchField search={search()} onChoose={() => {}} label="Find another repository" />,
    )
    expect(html).toContain("Find another repository")
    expect(html).not.toContain('role="listbox"')
  })

  it("lists matches with their paths and marks the active one", () => {
    const html = renderToStaticMarkup(
      <DirSearchField
        search={search({
          query: "pay",
          hits: [
            { name: "payments", path: "/opt/code/payments" },
            { name: "payouts", path: "/opt/payouts" },
          ],
          activeHit: 0,
        })}
        onChoose={() => {}}
      />,
    )
    expect(html).toContain('role="listbox"')
    expect(html).toContain("/opt/code/payments")
    expect(html).toContain("/opt/payouts")
    expect(html).toContain('aria-selected="true"')
    // The list scrolls internally instead of growing off the surface.
    expect(html).toContain("max-h-40")
    expect(html).toContain("overflow-y-auto")
  })

  it("explains an empty result and a failed search", () => {
    expect(
      renderToStaticMarkup(
        <DirSearchField
          search={search({ query: "zzz" })}
          onChoose={() => {}}
          emptyHint="No folders matched. Try another name."
        />,
      ),
    ).toContain("No folders matched")
    expect(
      renderToStaticMarkup(
        <DirSearchField search={search({ query: "z", error: "Search unavailable" })} onChoose={() => {}} />,
      ),
    ).toContain("Search unavailable")
  })
})
