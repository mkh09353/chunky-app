// The address field's two owners: the page and the person typing.
// Run with: bun test src/mainview/lib/browserAddressBar.test.ts
import { describe, expect, test } from "bun:test"
import { resolveAddressKey, shouldSyncAddressDraft } from "./browserAddressBar"

describe("shouldSyncAddressDraft", () => {
  test("a navigation updates the field when nobody is typing", () => {
    expect(
      shouldSyncAddressDraft({ editing: false, committed: "https://b.test/", draft: "https://a.test/" }),
    ).toBe(true)
  })

  test("NEVER clobbers in-progress typing", () => {
    // The regression this exists for: a redirect landing mid-typing used to
    // overwrite the half-typed address.
    expect(shouldSyncAddressDraft({ editing: true, committed: "https://b.test/", draft: "githu" })).toBe(false)
  })

  test("no pointless writes", () => {
    expect(
      shouldSyncAddressDraft({ editing: false, committed: "https://a.test/", draft: "https://a.test/" }),
    ).toBe(false)
    expect(shouldSyncAddressDraft({ editing: false, committed: "", draft: "https://a.test/" })).toBe(false)
  })
})

describe("resolveAddressKey", () => {
  test("Escape after typing restores the committed URL", () => {
    expect(resolveAddressKey({ key: "Escape", committed: "https://a.test/", draft: "half-typed" })).toEqual({
      type: "revert",
      url: "https://a.test/",
    })
  })

  test("Escape with nothing typed just leaves the field", () => {
    expect(resolveAddressKey({ key: "Escape", committed: "https://a.test/", draft: "https://a.test/" })).toEqual(
      { type: "blur" },
    )
  })

  test("other keys are not ours", () => {
    expect(resolveAddressKey({ key: "Enter", committed: "https://a.test/", draft: "x" })).toBeNull()
    expect(resolveAddressKey({ key: "a", committed: "https://a.test/", draft: "x" })).toBeNull()
  })
})
