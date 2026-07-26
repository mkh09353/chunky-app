// Defensive diff extraction from tool input/output.
// There is NO git-diff endpoint — everything here is derived from the raw
// tool I/O shapes the server streams. Unknown shapes MUST return null so the
// caller falls back to a generic tool card (never throw).
import type { DiffLine, FileDiff } from "./mock"

export const TOOL_TEXT_CAP = 16 * 1024

/** Truncate a large string for render safety, appending a marker. */
export function truncateText(s: string, cap = TOOL_TEXT_CAP): string {
  if (s.length <= cap) return s
  return s.slice(0, cap) + "\n… truncated"
}

/** Pretty-print tool input as JSON (2-space), truncated. */
export function prettyJson(input: unknown): string {
  if (input == null) return ""
  try {
    return truncateText(JSON.stringify(input, null, 2))
  } catch {
    return truncateText(String(input))
  }
}

function pathFrom(input: Record<string, unknown>): string | undefined {
  for (const k of ["path", "file_path", "filename", "filePath", "file"]) {
    const v = input[k]
    if (typeof v === "string" && v.trim()) return v
  }
  return undefined
}

/** Cap a diff's lines so the total rendered text stays under TOOL_TEXT_CAP. */
function capDiff(diff: FileDiff): FileDiff {
  let bytes = 0
  const lines: DiffLine[] = []
  let truncated = false
  for (const l of diff.lines) {
    bytes += l.text.length + 1
    if (bytes > TOOL_TEXT_CAP) {
      truncated = true
      break
    }
    lines.push(l)
  }
  return { ...diff, lines, truncated: truncated || diff.truncated }
}

function looksLikeDiff(s: string): boolean {
  if (!s || s.indexOf("\n") === -1) return false
  if (/^@@ /m.test(s)) return true
  return /^\+[^+]/m.test(s) && /^-[^-]/m.test(s)
}

function parseUnified(text: string, fallbackPath?: string): FileDiff {
  const lines: DiffLine[] = []
  let added = 0
  let removed = 0
  let path = fallbackPath
  for (const raw of text.split("\n")) {
    if (raw.startsWith("+++ ")) {
      const p = raw.slice(4).replace(/^b\//, "").trim()
      if (p && p !== "/dev/null") path = p
      continue
    }
    if (raw.startsWith("--- ") || raw.startsWith("diff ") || raw.startsWith("index ")) continue
    if (raw.startsWith("@@")) {
      lines.push({ kind: "context", text: raw })
      continue
    }
    if (raw.startsWith("+")) {
      lines.push({ kind: "add", text: raw.slice(1) })
      added++
    } else if (raw.startsWith("-")) {
      lines.push({ kind: "del", text: raw.slice(1) })
      removed++
    } else {
      lines.push({ kind: "context", text: raw.replace(/^ /, "") })
    }
  }
  return { path, added, removed, lines }
}

/**
 * Extract a structured diff from a tool call, or null when the shape is unknown.
 * Handles: (a) input.edits[{oldText,newText}] (the `edit` tool); (b) input.content
 * string (the `write`/create tool → all-added new file); (c) a unified-diff-ish
 * string in output/input.diff/input.patch.
 */
export function extractDiff(_name: string, input: unknown, output?: string): FileDiff | null {
  try {
    const inObj =
      input && typeof input === "object" ? (input as Record<string, unknown>) : {}
    const path = pathFrom(inObj)

    // (a) edits array of { oldText, newText }
    const edits = inObj.edits
    if (
      Array.isArray(edits) &&
      edits.length > 0 &&
      edits.every(
        (e) => e && typeof e === "object" && ("oldText" in e || "newText" in e),
      )
    ) {
      const lines: DiffLine[] = []
      let added = 0
      let removed = 0
      for (const e of edits as Array<{ oldText?: string; newText?: string }>) {
        if (typeof e.oldText === "string" && e.oldText.length > 0) {
          for (const t of e.oldText.split("\n")) {
            lines.push({ kind: "del", text: t })
            removed++
          }
        }
        if (typeof e.newText === "string" && e.newText.length > 0) {
          for (const t of e.newText.split("\n")) {
            lines.push({ kind: "add", text: t })
            added++
          }
        }
      }
      if (lines.length === 0) return null
      return capDiff({ path, added, removed, lines })
    }

    // (b) write/create with a full-file string
    if (typeof inObj.content === "string") {
      const body = inObj.content as string
      const lines: DiffLine[] = body.split("\n").map((t) => ({ kind: "add" as const, text: t }))
      return capDiff({ path, added: lines.length, removed: 0, lines })
    }

    // (c) a unified-diff-ish string in output or input.diff/patch
    const candidates: string[] = [
      typeof output === "string" ? output : "",
      typeof inObj.diff === "string" ? (inObj.diff as string) : "",
      typeof inObj.patch === "string" ? (inObj.patch as string) : "",
    ]
    for (const c of candidates) {
      if (looksLikeDiff(c)) return capDiff(parseUnified(c, path))
    }

    return null
  } catch {
    return null
  }
}
