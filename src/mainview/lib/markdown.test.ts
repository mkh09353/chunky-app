// Markdown renderer: pure block-parsing helpers plus static-markup checks of
// the rendered output. Run with:
//   bun test src/mainview/lib/markdown.test.ts
import { describe, expect, it } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { ReactElement } from "react"
import {
  buildListTree,
  isHorizontalRule,
  parseAlignRow,
  parseBullet,
  parseTable,
  renderMarkdown,
  splitTableRow,
  splitTrailingPunctuation,
} from "./markdown"

/** Rendered HTML for a markdown source — the transcript's actual output. */
const html = (src: string) => renderToStaticMarkup(renderMarkdown(src) as ReactElement)

/** Tag-stripped text, for asserting on content without class churn. */
const text = (src: string) => html(src).replace(/<[^>]+>/g, "")

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

describe("splitTableRow", () => {
  it("drops the optional outer pipes", () => {
    expect(splitTableRow("| a | b | c |")).toEqual(["a", "b", "c"])
    expect(splitTableRow("a | b | c")).toEqual(["a", "b", "c"])
    expect(splitTableRow("| a | b")).toEqual(["a", "b"])
  })

  it("keeps empty middle cells", () => {
    expect(splitTableRow("| a |  | c |")).toEqual(["a", "", "c"])
  })

  it("treats an escaped pipe as content", () => {
    expect(splitTableRow("| a \\| b | c |")).toEqual(["a | b", "c"])
    expect(splitTableRow("| `a \\| b` |")).toEqual(["`a | b`"])
  })
})

describe("parseAlignRow", () => {
  it("reads alignment markers", () => {
    expect(parseAlignRow("|:---|:---:|---:|---|")).toEqual(["left", "center", "right", null])
  })

  it("accepts short dashes and missing outer pipes", () => {
    expect(parseAlignRow("- | -")).toEqual([null, null])
  })

  it("rejects anything that is not a delimiter row", () => {
    expect(parseAlignRow("| a | b |")).toBeNull()
    expect(parseAlignRow("| --- x | --- |")).toBeNull()
    expect(parseAlignRow("")).toBeNull()
  })
})

describe("parseTable", () => {
  const lines = (s: string) => s.split("\n")

  it("parses a header, alignment and body rows", () => {
    const src = lines("| Tool | Use |\n| :--- | ---: |\n| grep | search |\n| rg | faster |\n\nafter")
    const parsed = parseTable(src, 0)
    expect(parsed).not.toBeNull()
    expect(parsed?.table.header).toEqual(["Tool", "Use"])
    expect(parsed?.table.align).toEqual(["left", "right"])
    expect(parsed?.table.rows).toEqual([
      ["grep", "search"],
      ["rg", "faster"],
    ])
    expect(parsed?.next).toBe(4) // stops at the blank line
  })

  it("refuses prose that merely contains a pipe", () => {
    expect(parseTable(lines("a | b\nnot a delimiter"), 0)).toBeNull()
    expect(parseTable(lines("just | text"), 0)).toBeNull()
  })

  it("refuses a delimiter row with a different column count", () => {
    expect(parseTable(lines("| a | b |\n| --- |"), 0)).toBeNull()
  })

  it("pads a half-streamed row instead of going ragged", () => {
    const parsed = parseTable(lines("| a | b | c |\n| --- | --- | --- |\n| 1 | 2"), 0)
    expect(parsed?.table.rows).toEqual([["1", "2", ""]])
  })

  it("handles a header-only table mid-stream", () => {
    const parsed = parseTable(lines("| a | b |\n| --- | --- |"), 0)
    expect(parsed?.table.rows).toEqual([])
    expect(parsed?.next).toBe(2)
  })
})

describe("isHorizontalRule", () => {
  it("accepts the three rule spellings", () => {
    for (const rule of ["---", "***", "___", "- - -", "*****"]) {
      expect(isHorizontalRule(rule)).toBe(true)
    }
  })

  it("rejects table delimiters, bullets and emphasis", () => {
    expect(isHorizontalRule("|---|---|")).toBe(false)
    expect(isHorizontalRule("- item")).toBe(false)
    expect(isHorizontalRule("***bold***")).toBe(false)
    expect(isHorizontalRule("--")).toBe(false)
  })
})

describe("bullet nesting", () => {
  it("reads the indent of a bullet", () => {
    expect(parseBullet("- top")).toEqual({ indent: 0, text: "top" })
    expect(parseBullet("  - child")).toEqual({ indent: 2, text: "child" })
    expect(parseBullet("\t* tabbed")).toEqual({ indent: 2, text: "tabbed" })
    expect(parseBullet("plain text")).toBeNull()
    expect(parseBullet("---")).toBeNull()
  })

  it("folds indents into a tree", () => {
    const tree = buildListTree([
      { indent: 0, text: "a" },
      { indent: 2, text: "a1" },
      { indent: 4, text: "a1a" },
      { indent: 2, text: "a2" },
      { indent: 0, text: "b" },
    ])
    expect(tree.map((n) => n.text)).toEqual(["a", "b"])
    expect(tree[0]?.children.map((n) => n.text)).toEqual(["a1", "a2"])
    expect(tree[0]?.children[0]?.children.map((n) => n.text)).toEqual(["a1a"])
    expect(tree[1]?.children).toEqual([])
  })

  it("attaches an odd indent to the nearest shallower item", () => {
    const tree = buildListTree([
      { indent: 0, text: "a" },
      { indent: 3, text: "a1" },
      { indent: 2, text: "a2" },
    ])
    expect(tree).toHaveLength(1)
    expect(tree[0]?.children.map((n) => n.text)).toEqual(["a1", "a2"])
  })
})

describe("renderMarkdown blocks", () => {
  it("renders a table with alignment inside a scrollable wrapper", () => {
    const out = html("| Tool | Use |\n| :--- | ---: |\n| `rg` | **fast** |")
    expect(out).toContain("<table")
    expect(out).toContain("overflow-x-auto")
    expect(out).toContain("<th")
    expect(out).toMatch(/<th[^>]*text-left/)
    expect(out).toMatch(/<th[^>]*text-right/)
    expect(out).toMatch(/<td[^>]*text-right/)
    // Cells run through the inline renderer.
    expect(out).toContain("<code")
    expect(out).toContain("<strong")
    expect(text("| a |\n| --- |\n| v |")).toContain("v")
  })

  it("keeps a table from swallowing the prose around it", () => {
    const out = text("Before:\n| a | b |\n| --- | --- |\n| 1 | 2 |\nAfter.")
    expect(out).toContain("Before:")
    expect(out).toContain("After.")
  })

  it("does not crash or table-ify a half-streamed table", () => {
    for (const partial of ["| a", "| a | b |", "| a | b |\n| ---", "| a | b |\n| --- | --- |"]) {
      expect(() => html(partial)).not.toThrow()
    }
    // Only once the delimiter row is complete does it become a table.
    expect(html("| a | b |\n| ---")).not.toContain("<table")
    expect(html("| a | b |\n| --- | --- |")).toContain("<table")
  })

  it("renders a multi-line blockquote with inline formatting", () => {
    const out = html("> quoted **line**\n> second line")
    expect(out).toContain("<blockquote")
    expect(out).toContain("border-l-2")
    expect(out).toContain("<strong")
    expect(text("> quoted **line**\n> second line")).toContain("quoted line second line")
  })

  it("renders block structure inside a blockquote", () => {
    const out = html("> - one\n> - two")
    expect(out).toContain("<blockquote")
    expect(out).toContain("<ul")
  })

  it("renders thematic breaks but not table delimiters", () => {
    expect(html("a\n\n---\n\nb")).toContain("<hr")
    expect(html("a\n\n***\n\nb")).toContain("<hr")
    expect(html("| a | b |\n| --- | --- |\n| 1 | 2 |")).not.toContain("<hr")
  })

  it("renders headings through level 6 as headings, not paragraphs", () => {
    for (const [src, size] of [
      ["# one", "text-[16px]"],
      ["### three", "text-[14.5px]"],
      ["#### four", "text-[13.5px]"],
      ["###### six", "text-[13.5px]"],
    ] as const) {
      const out = html(src)
      expect(out).toContain("font-semibold")
      expect(out).toContain(size)
      expect(out).not.toContain("<p ")
    }
    // Not a heading without the space, so it stays prose.
    expect(html("#nope")).toContain("<p ")
  })

  it("nests indented bullets and leaves flat lists alone", () => {
    const nested = html("- parent\n  - child\n    - grandchild\n- sibling")
    expect(nested.match(/<ul/g)?.length).toBe(3)
    expect(nested.match(/<li/g)?.length).toBe(4)
    expect(text("- parent\n  - child")).toContain("parentchild")

    const flat = html("- a\n- b\n- c")
    expect(flat.match(/<ul/g)?.length).toBe(1)
    expect(flat.match(/<li/g)?.length).toBe(3)
  })

  it("renders strikethrough", () => {
    const out = html("~~gone~~ but here")
    expect(out).toContain("<s ")
    expect(out).toContain("line-through")
    expect(text("~~gone~~ but here")).toBe("gone but here")
  })

  it("survives every prefix of a streamed document", () => {
    // Deltas arrive mid-word, mid-row and mid-fence; each intermediate state is
    // rendered, so none of them may throw.
    const doc = [
      "## Report",
      "",
      "| Seat | Runs | Avg |",
      "| :--- | ---: | :-: |",
      "| backend | 12 | 8.4 |",
      "| web \\| ui | 7 | 7.9 |",
      "",
      "> quoted ~~note~~",
      "",
      "---",
      "",
      "###### tiny heading",
      "",
      "- parent",
      "  - child",
      "",
      "```ts",
      "const x = 1",
      "```",
    ].join("\n")
    for (let n = 0; n <= doc.length; n++) {
      expect(() => html(doc.slice(0, n))).not.toThrow()
    }
    // The finished document has every block.
    const final = html(doc)
    for (const tag of ["<table", "<blockquote", "<hr", "<ul", "<s ", "<pre"]) {
      expect(final).toContain(tag)
    }
  })

  it("still renders the pre-existing constructs", () => {
    const out = html("# Title\n\npara with `code` and [a](https://x.dev)\n\n1. first\n2. second")
    expect(out).toContain("<code")
    expect(out).toContain('href="https://x.dev"')
    expect(out).toContain("<ol")
    expect(out.match(/<li/g)?.length).toBe(2)
  })
})
