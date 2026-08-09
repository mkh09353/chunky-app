// Markdown renderer: pure block-parsing helpers plus static-markup checks of
// the rendered output. Run with:
//   bun test src/mainview/lib/markdown.test.ts
import { describe, expect, it } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { createElement, Fragment, type ReactElement, type ReactNode } from "react"
import { FileLinkProvider } from "./fileLinkContext"
import {
  buildListTree,
  isHorizontalRule,
  Markdown,
  markdownFallback,
  parseAlignRow,
  parseBullet,
  parseTable,
  parseTaskItem,
  RenderErrorBoundary,
  renderMarkdown,
  splitTableRow,
  splitTrailingPunctuation,
  tableToMarkdown,
  type TableSpec,
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

  it("keeps a loose ordered list (blank lines between items) as one list", () => {
    const out = html("1. first item\n\n2. second item\n\n3. third item\n\nplain para after")
    expect(out.match(/<ol/g)?.length).toBe(1)
    expect(out.match(/<li/g)?.length).toBe(3)
    // Badges count up instead of repeating “1”.
    expect(out).toContain(">2<")
    expect(out).toContain(">3<")
    // The trailing paragraph is not swallowed into the list.
    expect(out).toContain("plain para after")
  })

  it("respects the starting number of an ordered list", () => {
    const out = html("3. third\n4. fourth")
    expect(out).toContain(">3<")
    expect(out).toContain(">4<")
  })
})

describe("parseTaskItem", () => {
  it("reads both checkbox states", () => {
    expect(parseTaskItem("[ ] todo")).toEqual({ checked: false, text: "todo" })
    expect(parseTaskItem("[x] done")).toEqual({ checked: true, text: "done" })
    expect(parseTaskItem("[X] done")).toEqual({ checked: true, text: "done" })
  })

  it("keeps the rest of the line, formatting included", () => {
    expect(parseTaskItem("[ ]   ship **it** now")).toEqual({
      checked: false,
      text: "ship **it** now",
    })
  })

  it("rejects anything that is not a GFM marker", () => {
    for (const notATask of ["[y] foo", "[] foo", "[ x] foo", "[xx] foo", "plain", "a [x] b"]) {
      expect(parseTaskItem(notATask)).toBeNull()
    }
  })

  it("degrades on half-streamed prefixes instead of throwing", () => {
    for (const partial of ["[", "[ ", "[x", "[X", "[ ] "]) {
      expect(() => parseTaskItem(partial)).not.toThrow()
    }
    expect(parseTaskItem("[")).toBeNull()
    expect(parseTaskItem("[ ")).toBeNull()
    expect(parseTaskItem("[x")).toBeNull()
  })
})

describe("task lists", () => {
  it("renders a checkbox instead of the dot bullet", () => {
    const out = html("- [ ] todo\n- [x] done")
    expect(out).toContain('role="checkbox"')
    expect(out).toContain('aria-checked="false"')
    expect(out).toContain('aria-checked="true"')
    expect(out).toContain("rounded-sm")
    // The literal brackets are gone; the text survives.
    expect(text("- [ ] todo\n- [x] done")).toBe("tododone")
    // A checked item is muted, never struck through.
    expect(out).not.toContain("line-through")
  })

  it("works at any nesting depth", () => {
    const out = html("- [ ] parent\n  - [x] child\n    - [ ] grandchild")
    expect(out.match(/role="checkbox"/g)?.length).toBe(3)
    expect(out.match(/<ul/g)?.length).toBe(3)
  })

  it("mixes plain bullets and task items in one list", () => {
    const out = html("- plain\n- [x] done")
    expect(out.match(/role="checkbox"/g)?.length).toBe(1)
    // The plain item keeps its dot marker.
    expect(out).toContain("rounded-full")
  })

  it("leaves a non-marker bracket as text", () => {
    const out = html("- [y] foo")
    expect(out).not.toContain('role="checkbox"')
    expect(text("- [y] foo")).toContain("[y] foo")
  })

  it("survives every prefix of a streamed task list", () => {
    const doc = ["## Plan", "", "- [x] done", "- [ ] todo", "  - [x] nested", "- [y] not a task"].join(
      "\n",
    )
    for (let n = 0; n <= doc.length; n++) {
      expect(() => html(doc.slice(0, n))).not.toThrow()
    }
    expect(html(doc).match(/role="checkbox"/g)?.length).toBe(3)
  })

  it("treats a half-streamed marker as plain text", () => {
    for (const partial of ["- [", "- [ ", "- [x", "- [x]", "- [ ]"]) {
      expect(() => html(partial)).not.toThrow()
    }
    expect(html("- [ ")).not.toContain('role="checkbox"')
    expect(text("- [x")).toContain("[x")
  })
})

describe("tableToMarkdown", () => {
  const spec: TableSpec = {
    header: ["Tool", "Use", "Note"],
    align: ["left", "right", null],
    rows: [
      ["grep", "search", ""],
      ["rg", "faster", "a | pipe"],
    ],
  }

  it("rebuilds pipes, the delimiter row and every cell", () => {
    expect(tableToMarkdown(spec).split("\n")).toEqual([
      "| Tool | Use | Note |",
      "| :--- | ---: | --- |",
      "| grep | search |  |",
      "| rg | faster | a \\| pipe |",
    ])
  })

  it("round-trips through the parser", () => {
    const parsed = parseTable(tableToMarkdown(spec).split("\n"), 0)
    expect(parsed?.table).toEqual(spec)
  })

  it("round-trips a table taken straight out of markdown", () => {
    const src = "| a | b |\n| :---: | ---: |\n| 1 | 2 |"
    const first = parseTable(src.split("\n"), 0)
    expect(first).not.toBeNull()
    const round = parseTable(tableToMarkdown(first?.table as TableSpec).split("\n"), 0)
    expect(round?.table).toEqual(first?.table as TableSpec)
  })

  it("pads a short or ragged spec to the header width", () => {
    const ragged: TableSpec = { header: ["a", "b"], align: [], rows: [["1"]] }
    expect(tableToMarkdown(ragged)).toBe("| a | b |\n| --- | --- |\n| 1 |  |")
    expect(parseTable(tableToMarkdown(ragged).split("\n"), 0)?.table).toEqual({
      header: ["a", "b"],
      align: [null, null],
      rows: [["1", ""]],
    })
  })
})

describe("table copy button", () => {
  it("is rendered next to the table, hover-revealed and labelled", () => {
    const out = html("| a | b |\n| --- | --- |\n| 1 | 2 |")
    expect(out).toContain('aria-label="Copy table as markdown"')
    expect(out).toContain("group-hover/table:opacity-100")
    // Icon-only: the button adds no text to the transcript.
    expect(text("| a | b |\n| --- | --- |\n| 1 | 2 |")).toBe("ab12")
  })

  it("leaves non-table markdown untouched", () => {
    expect(html("just prose")).not.toContain("aria-label=\"Copy table as markdown\"")
  })
})

describe("file-path code spans", () => {
  /** Rendered inside a scope that says the editor bridge exists. */
  const linked = (src: string, cwd?: string) =>
    renderToStaticMarkup(
      createElement(
        FileLinkProvider,
        { enabled: true, ...(cwd ? { cwd } : {}), children: renderMarkdown(src) },
      ) as ReactElement,
    )

  it("turns a path code span into a clickable chip", () => {
    const out = linked("see `src/mainview/lib/markdown.tsx` for the renderer", "/repo")
    expect(out).toContain('data-file-link="src/mainview/lib/markdown.tsx"')
    expect(out).toContain('title="Open in editor"')
    expect(out).toContain("<button")
    expect(out).toContain("cursor-pointer")
    // The chip keeps the code-span look.
    expect(out).toContain("font-mono")
    expect(out).toContain("bg-muted")
    expect(text("see `src/mainview/lib/markdown.tsx` for the renderer")).toContain(
      "src/mainview/lib/markdown.tsx",
    )
  })

  it("carries a line:col suffix through to the chip", () => {
    const out = linked("`src/bun/index.ts:352:7`", "/repo")
    expect(out).toContain('data-file-link="src/bun/index.ts"')
    // The label still reads exactly as the author wrote it.
    expect(out).toContain("src/bun/index.ts:352:7")
  })

  it("leaves a non-path code span alone", () => {
    for (const code of ["npm install", "@chunky/protocol", "renderMarkdown", "https://x.dev/a.ts"]) {
      const out = linked(`run \`${code}\` now`, "/repo")
      expect(out).not.toContain("data-file-link")
      expect(out).not.toContain("<button")
      expect(out).toContain("<code")
    }
  })

  it("stays a plain code span when the editor bridge is absent", () => {
    // `html()` renders with no provider: in a browser build (and in this test
    // process) there is no RPC, so nothing may promise to open a file.
    const out = html("see `src/mainview/lib/markdown.tsx`")
    expect(out).not.toContain("data-file-link")
    expect(out).not.toContain("<button")
    expect(out).toContain("<code")
  })

  it("does not offer relative paths when there is no cwd to anchor them", () => {
    const out = linked("see `src/a.ts`")
    expect(out).not.toContain("data-file-link")
    // Absolute and ~ paths need no anchor, so they stay clickable.
    const absolute = linked("see `/Users/me/p/a.ts` and `~/notes/todo.md`")
    expect(absolute.match(/data-file-link/g)?.length).toBe(2)
  })

  it("works inside lists, blockquotes and table cells", () => {
    const out = linked(
      "- see `src/a.ts`\n\n> and `src/b.ts`\n\n| f |\n| --- |\n| `src/c.ts` |",
      "/repo",
    )
    expect(out.match(/data-file-link/g)?.length).toBe(3)
  })

  it("never throws on a half-streamed code span", () => {
    const doc = "edit `src/mainview/lib/markdown.tsx:42:7` then `npm install`"
    for (let n = 0; n <= doc.length; n++) {
      expect(() => linked(doc.slice(0, n), "/repo")).not.toThrow()
    }
  })
})

describe("render error boundary", () => {
  /**
   * React's Fizz server renderer never calls `getDerivedStateFromError`, so the
   * boundary's contract is driven by hand here — the same two steps React takes
   * on the client: catch the throw, then re-render with the derived state.
   */
  const renderWithBoundary = (children: ReactNode, fallback: ReactNode): string => {
    const boundary = new RenderErrorBoundary({ children, fallback })
    try {
      return renderToStaticMarkup(createElement(Fragment, null, boundary.render()))
    } catch {
      Object.assign(boundary.state, RenderErrorBoundary.getDerivedStateFromError())
      return renderToStaticMarkup(createElement(Fragment, null, boundary.render()))
    }
  }

  const Boom = (): ReactNode => {
    throw new Error("render crashed")
  }

  it("shows children while they render", () => {
    const out = renderWithBoundary(createElement("span", null, "fine"), markdownFallback("raw"))
    expect(out).toContain("fine")
    expect(out).not.toContain("<pre")
  })

  it("falls back to the raw source when a child throws", () => {
    const src = "# Title\n\n| broken"
    const out = renderWithBoundary(createElement(Boom), markdownFallback(src))
    expect(out).toContain("<pre")
    expect(out).toContain("whitespace-pre-wrap")
    expect(out).toContain("# Title")
    expect(out).toContain("| broken")
    expect(out).not.toContain("<h1")
  })

  it("keeps the raw markdown literal, unrendered", () => {
    const out = renderToStaticMarkup(
      createElement(Fragment, null, markdownFallback("a **bold** [x] `c`")) as ReactElement,
    )
    expect(out).toContain("a **bold** [x] `c`")
    expect(out).not.toContain("<strong")
  })

  it("clears a previous failure only when the source changes", () => {
    const failed = { failed: true, seen: "old" }
    expect(RenderErrorBoundary.getDerivedStateFromProps(
      { fallback: null, resetKey: "old", children: null },
      failed,
    )).toBeNull()
    expect(RenderErrorBoundary.getDerivedStateFromProps(
      { fallback: null, resetKey: "new", children: null },
      failed,
    )).toEqual({ failed: false, seen: "new" })
  })

  it("renders the same output as renderMarkdown when nothing throws", () => {
    const src = "# Title\n\n- [x] done\n\n| a | b |\n| --- | --- |\n| 1 | 2 |"
    const wrapped = renderToStaticMarkup(
      createElement(Markdown, { source: src }) as ReactElement,
    )
    expect(wrapped).toBe(html(src))
  })
})
