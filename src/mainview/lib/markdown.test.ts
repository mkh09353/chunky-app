// Trailing-punctuation trimming for bare-URL autolinks. Run with:
//   bun test src/mainview/lib/markdown.test.ts
import { describe, expect, it } from "bun:test"
import { splitTrailingPunctuation } from "./markdown"

describe("splitTrailingPunctuation", () => {
  it("leaves a clean URL alone", () => {
    expect(splitTrailingPunctuation("http://localhost:4700")).toEqual([
      "http://localhost:4700",
      "",
    ])
  })

  it("gives sentence punctuation back to the prose", () => {
    expect(splitTrailingPunctuation("https://a.dev/x.")).toEqual(["https://a.dev/x", "."])
    expect(splitTrailingPunctuation("https://a.dev/x,")).toEqual(["https://a.dev/x", ","])
    expect(splitTrailingPunctuation("https://a.dev/x;")).toEqual(["https://a.dev/x", ";"])
    expect(splitTrailingPunctuation("http://a.dev/x:")).toEqual(["http://a.dev/x", ":"])
    expect(splitTrailingPunctuation("http://a.dev/x?!")).toEqual(["http://a.dev/x", "?!"])
  })

  it("only releases an unbalanced closing paren", () => {
    expect(splitTrailingPunctuation("https://a.dev/x)")).toEqual(["https://a.dev/x", ")"])
    expect(splitTrailingPunctuation("https://w.org/Foo_(bar)")).toEqual([
      "https://w.org/Foo_(bar)",
      "",
    ])
    expect(splitTrailingPunctuation("https://w.org/Foo_(bar))")).toEqual([
      "https://w.org/Foo_(bar)",
      ")",
    ])
  })

  it("strips a run of trailing punctuation", () => {
    expect(splitTrailingPunctuation("http://a.dev/x).")).toEqual(["http://a.dev/x", ")."])
  })
})
