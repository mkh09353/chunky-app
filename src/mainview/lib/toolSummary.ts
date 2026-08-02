// Human-readable one-liners for tool calls.
//
// The transcript used to show a tool's raw JSON arguments on its header row,
// which reads like a log file rather than an account of what the agent did.
// This module turns `name` + `input` into a short verb phrase ("Ran", "Read")
// plus the one argument that matters (the command, the path, the pattern), and
// summarizes a whole run of calls for a collapsed activity group.
//
// It is deliberately pure and React-free (`bun test src/mainview/lib/toolSummary.test.ts`),
// and it NEVER throws: an unknown tool shape falls back to the tool's own name
// plus truncated JSON, which is what the card showed before.

/** Coarse family a tool belongs to — drives icons, phrasing and group titles. */
export type ToolKind = "bash" | "read" | "write" | "edit" | "search" | "delegate" | "other"

/** One tool call, said in words. `detail` is the argument that matters. */
export interface ToolSummary {
  /** Verb phrase, e.g. "Ran", "Read", "Searched for". Never empty. */
  label: string
  /** The argument itself — command, path, pattern, or truncated JSON. */
  detail: string
  /** True when `detail` is code-ish and should be rendered monospace. */
  mono: boolean
}

/** How much of a command / argument survives on one line. */
export const SUMMARY_MAX = 80

/** Tools whose call spawns a delegated run. These own a gutter card and must
 *  stay standalone pills, so they are never folded into an activity group. */
const DELEGATE_TOOLS = ["sidekick", "spawn_thread", "workflow", "ship_goal"]

/** Strip MCP/namespace prefixes: `mcp__chunky__bash` → `bash`. */
export function baseToolName(name: string): string {
  const trimmed = (name ?? "").trim()
  if (!trimmed) return ""
  const parts = trimmed.split(/__|[./:]/).filter(Boolean)
  return (parts[parts.length - 1] ?? trimmed).toLowerCase()
}

export function toolKind(name: string): ToolKind {
  const n = baseToolName(name)
  if (!n) return "other"
  if (DELEGATE_TOOLS.some((t) => n.includes(t))) return "delegate"
  if (n.includes("bash") || n.includes("shell") || n.includes("terminal")) return "bash"
  if (n.includes("grep") || n.includes("find") || n.includes("glob") || n.includes("search")) {
    return "search"
  }
  if (n.includes("write") || n.includes("create")) return "write"
  if (n.includes("edit") || n.includes("patch")) return "edit"
  if (n.includes("read") || n.includes("view")) return "read"
  return "other"
}

/** A tool call that may be folded into an activity group (delegates may not). */
export function isGroupableTool(name: string): boolean {
  return toolKind(name) !== "delegate"
}

/** Collapse whitespace and cap at `max`, appending an ellipsis when cut. */
export function condense(text: string, max = SUMMARY_MAX): string {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`
}

function asRecord(input: unknown): Record<string, unknown> | null {
  return input && typeof input === "object" && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : null
}

function stringField(input: unknown, keys: string[]): string | undefined {
  const record = asRecord(input)
  if (!record) return undefined
  for (const key of keys) {
    const value = record[key]
    if (typeof value === "string" && value.trim()) return value
  }
  return undefined
}

/** Raw JSON (or the string itself), condensed onto one line. */
function rawDetail(input: unknown): string {
  if (input == null) return ""
  if (typeof input === "string") return condense(input)
  try {
    return condense(JSON.stringify(input) ?? "")
  } catch {
    return condense(String(input))
  }
}

/** Display name for the fallback label: `mcp__chunky__zoo_board` → `zoo_board`. */
function displayName(name: string): string {
  return baseToolName(name) || "tool"
}

/**
 * Say what one tool call did. Known shapes get a verb phrase and their single
 * most telling argument; anything else falls back to the tool name plus
 * truncated JSON (the pre-existing behaviour).
 */
export function describeTool(name: string, input: unknown): ToolSummary {
  const kind = toolKind(name)
  const fallback = (): ToolSummary => ({
    label: displayName(name),
    detail: rawDetail(input),
    mono: true,
  })

  switch (kind) {
    case "bash": {
      const command = stringField(input, ["command", "cmd", "script"])
      return command ? { label: "Ran", detail: condense(command), mono: true } : fallback()
    }
    case "read":
    case "write":
    case "edit": {
      const path = stringField(input, ["path", "file_path", "filePath", "filename", "file"])
      if (!path) return fallback()
      const label = kind === "read" ? "Read" : kind === "write" ? "Wrote" : "Edited"
      return { label, detail: condense(path), mono: true }
    }
    case "search": {
      const pattern = stringField(input, ["pattern", "query", "regex", "search"])
      if (!pattern) return fallback()
      // `fffind` matches paths, `ffgrep` matches contents: say which.
      const findsFiles = /find|glob/.test(baseToolName(name))
      return {
        label: findsFiles ? "Found files matching" : "Searched for",
        detail: `"${condense(pattern, SUMMARY_MAX - 2)}"`,
        mono: true,
      }
    }
    case "delegate": {
      const task = stringField(input, ["task", "instructions", "title", "objective", "brief"])
      return task
        ? { label: "Delegated", detail: condense(task), mono: false }
        : { label: "Delegated", detail: rawDetail(input), mono: true }
    }
    default:
      return fallback()
  }
}

/** The whole summary on one line, for callers that don't style the parts. */
export function toolSummaryText(name: string, input: unknown): string {
  const { label, detail } = describeTool(name, input)
  return detail ? `${label} ${detail}` : label
}

/** Fixed phrasing order, so a mixed group always reads the same way. */
const KIND_ORDER: ToolKind[] = ["bash", "read", "edit", "write", "search", "delegate", "other"]

function countPhrase(kind: ToolKind, n: number): string {
  switch (kind) {
    case "bash":
      return n === 1 ? "ran 1 command" : `ran ${n} commands`
    case "read":
      return n === 1 ? "read 1 file" : `read ${n} files`
    case "edit":
      return n === 1 ? "edited 1 file" : `edited ${n} files`
    case "write":
      return n === 1 ? "wrote 1 file" : `wrote ${n} files`
    case "search":
      return n === 1 ? "ran 1 search" : `ran ${n} searches`
    case "delegate":
      return n === 1 ? "delegated 1 run" : `delegated ${n} runs`
    default:
      return n === 1 ? "1 tool call" : `${n} tool calls`
  }
}

function capitalize(text: string): string {
  return text ? text[0]!.toUpperCase() + text.slice(1) : text
}

/**
 * Title for a collapsed activity group: "Ran 6 commands", "Read 3 files", or —
 * when the run is mixed — the two biggest families and a `+N more` tail.
 * Deterministic: families are phrased in a fixed order, never by arrival.
 */
export function groupSummary(tools: ReadonlyArray<{ name: string }>): string {
  if (tools.length === 0) return "No tool calls"
  const counts = new Map<ToolKind, number>()
  for (const tool of tools) {
    const kind = toolKind(tool.name)
    counts.set(kind, (counts.get(kind) ?? 0) + 1)
  }
  const present = KIND_ORDER.filter((kind) => counts.has(kind))
  if (present.length === 1) {
    return capitalize(countPhrase(present[0]!, counts.get(present[0]!)!))
  }
  const shown = present.slice(0, 2).map((kind) => countPhrase(kind, counts.get(kind)!))
  const restKinds = present.slice(2)
  const rest = restKinds.reduce((sum, kind) => sum + (counts.get(kind) ?? 0), 0)
  const tail = rest > 0 ? `, +${rest} more` : ""
  return `${capitalize(shown.join(", "))}${tail}`
}

/** Aggregate status of a group: any failure loses, any unfinished call waits. */
export function groupStatus(
  tools: ReadonlyArray<{ done: boolean; ok?: boolean }>,
): "running" | "failed" | "ok" {
  if (tools.some((tool) => !tool.done)) return "running"
  if (tools.some((tool) => tool.ok === false)) return "failed"
  return "ok"
}
