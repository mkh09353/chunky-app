// What a tool call reads as in the transcript. Run with:
//   bun test src/mainview/lib/toolSummary.test.ts
import { describe, expect, test } from "bun:test"
import {
  SUMMARY_MAX,
  baseToolName,
  condense,
  describeTool,
  groupStatus,
  groupSummary,
  isGroupableTool,
  toolKind,
  toolSummaryText,
} from "./toolSummary"

describe("tool names", () => {
  test("strips MCP and namespace prefixes", () => {
    expect(baseToolName("mcp__chunky__bash")).toBe("bash")
    expect(baseToolName("chunky.read")).toBe("read")
    expect(baseToolName("Bash")).toBe("bash")
    expect(baseToolName("")).toBe("")
  })

  test("classifies the families the transcript phrases differently", () => {
    expect(toolKind("mcp__chunky__bash")).toBe("bash")
    expect(toolKind("ffgrep")).toBe("search")
    expect(toolKind("fffind")).toBe("search")
    expect(toolKind("read")).toBe("read")
    expect(toolKind("write")).toBe("write")
    expect(toolKind("edit")).toBe("edit")
    expect(toolKind("sidekick")).toBe("delegate")
    expect(toolKind("spawn_thread")).toBe("delegate")
    expect(toolKind("workflow")).toBe("delegate")
    expect(toolKind("zoo_board")).toBe("other")
  })

  test("only delegate tools are kept out of activity groups", () => {
    expect(isGroupableTool("bash")).toBe(true)
    expect(isGroupableTool("zoo_board")).toBe(true)
    expect(isGroupableTool("sidekick")).toBe(false)
    expect(isGroupableTool("mcp__chunky__spawn_thread")).toBe(false)
  })
})

describe("condense", () => {
  test("flattens whitespace and caps the line", () => {
    expect(condense("  ls   -la\n\n")).toBe("ls -la")
    const long = "x".repeat(200)
    expect(condense(long)).toHaveLength(SUMMARY_MAX)
    expect(condense(long).endsWith("…")).toBe(true)
  })
})

describe("describeTool", () => {
  test("bash says the command itself", () => {
    expect(describeTool("mcp__chunky__bash", { command: "bun test\nsrc/" })).toEqual({
      label: "Ran",
      detail: "bun test src/",
      mono: true,
    })
  })

  test("file tools say the verb and the path", () => {
    expect(describeTool("read", { path: "src/foo.ts" })).toMatchObject({
      label: "Read",
      detail: "src/foo.ts",
    })
    expect(describeTool("write", { file_path: "a/b.md" })).toMatchObject({ label: "Wrote", detail: "a/b.md" })
    expect(describeTool("edit", { filePath: "a/b.md" })).toMatchObject({ label: "Edited", detail: "a/b.md" })
  })

  test("search tools distinguish content from filename matching", () => {
    expect(describeTool("ffgrep", { pattern: "useRunClock" })).toMatchObject({
      label: "Searched for",
      detail: '"useRunClock"',
    })
    expect(describeTool("fffind", { pattern: "Composer" })).toMatchObject({
      label: "Found files matching",
      detail: '"Composer"',
    })
  })

  test("an unknown tool falls back to its name plus truncated JSON", () => {
    expect(describeTool("zoo_board", { a: 1 })).toEqual({
      label: "zoo_board",
      detail: '{"a":1}',
      mono: true,
    })
    // A known family with the expected field missing also falls back.
    expect(describeTool("bash", { description: "no command here" })).toMatchObject({
      label: "bash",
      detail: '{"description":"no command here"}',
    })
  })

  test("never throws on hostile input", () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(() => describeTool("zoo_board", cyclic)).not.toThrow()
    expect(describeTool("read", null)).toMatchObject({ label: "read", detail: "" })
    expect(describeTool("bash", "ls -la")).toMatchObject({ label: "bash", detail: "ls -la" })
  })

  test("toolSummaryText joins the parts, and drops an empty detail", () => {
    expect(toolSummaryText("bash", { command: "ls" })).toBe("Ran ls")
    expect(toolSummaryText("read", null)).toBe("read")
  })
})

describe("groupSummary", () => {
  const call = (name: string) => ({ name })

  test("an all-bash run reads as commands", () => {
    expect(groupSummary([call("bash"), call("mcp__chunky__bash")])).toBe("Ran 2 commands")
    expect(groupSummary([call("bash")])).toBe("Ran 1 command")
  })

  test("a single-family run uses that family's phrasing", () => {
    expect(groupSummary([call("read"), call("read"), call("read")])).toBe("Read 3 files")
    expect(groupSummary([call("ffgrep"), call("fffind")])).toBe("Ran 2 searches")
    expect(groupSummary([call("zoo_board"), call("zoo_add_note")])).toBe("2 tool calls")
  })

  test("a mixed run names the two biggest families in a fixed order", () => {
    // Arrival order must not change the phrasing.
    const mixed = [call("read"), call("bash"), call("bash"), call("bash"), call("read")]
    expect(groupSummary(mixed)).toBe("Ran 3 commands, read 2 files")
    expect(groupSummary([...mixed].reverse())).toBe("Ran 3 commands, read 2 files")
  })

  test("families beyond the first two collapse into a +N tail", () => {
    expect(groupSummary([call("bash"), call("read"), call("edit"), call("ffgrep")])).toBe(
      "Ran 1 command, read 1 file, +2 more",
    )
  })

  test("an empty group is stated, not crashed on", () => {
    expect(groupSummary([])).toBe("No tool calls")
  })
})

describe("groupStatus", () => {
  test("running beats failed beats ok", () => {
    expect(groupStatus([{ done: true, ok: true }, { done: false }])).toBe("running")
    expect(groupStatus([{ done: true, ok: true }, { done: true, ok: false }])).toBe("failed")
    expect(groupStatus([{ done: true, ok: true }, { done: true }])).toBe("ok")
    expect(groupStatus([])).toBe("ok")
  })
})
