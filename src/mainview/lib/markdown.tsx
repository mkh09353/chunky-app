import { Fragment, type ReactNode } from "react"
import { cn } from "~/lib/cn"
import { CodeBlock } from "~/components/CodeBlock"

/*
 * A deliberately tiny markdown renderer — enough to make assistant prose look
 * like a real shadcn transcript, with zero dependencies. Handles headings
 * (# … ######), unordered (incl. nesting) / ordered lists, GFM pipe tables,
 * blockquotes, thematic breaks, fenced code, paragraphs, and inline
 * **bold** / *italic* / ~~strike~~ / `code` / [links](href) / bare http(s) URLs.
 *
 * It also has to survive *streaming*: every block is parsed from whatever text
 * has arrived so far, so half-written tables and unclosed fences must degrade
 * to something readable rather than throw.
 */

// Order matters only where two alternatives can start at the same index: code
// spans and [label](href) are listed before the bare-URL branch, so a URL that
// lives inside `backticks` or a markdown link is consumed by those first.
const INLINE_RE =
  /(\*\*[^*]+\*\*|\*[^*]+\*|~~[^~]+~~|`[^`]+`|\[[^\]]+\]\([^)]+\)|https?:\/\/[^\s<>"'`]+)/g

const LINK_CLASS = "font-medium text-primary underline-offset-2 hover:underline"

function count(text: string, char: string): number {
  let n = 0
  for (const c of text) if (c === char) n++
  return n
}

/**
 * Prose punctuation that trails a bare URL belongs to the sentence, not the
 * link: "see http://localhost:4700." or "(http://a.dev/x)". A closing paren is
 * only given back when it is unbalanced, so /wiki/Foo_(bar) survives.
 */
export function splitTrailingPunctuation(url: string): [string, string] {
  let end = url.length
  while (end > 0) {
    const ch = url[end - 1] ?? ""
    if (".,;:!?'\"".includes(ch)) {
      end--
      continue
    }
    if (ch === ")" || ch === "]" || ch === "}") {
      const open = ch === ")" ? "(" : ch === "]" ? "[" : "{"
      const slice = url.slice(0, end)
      if (count(slice, ch) > count(slice, open)) {
        end--
        continue
      }
    }
    break
  }
  return [url.slice(0, end), url.slice(end)]
}

// ── Block-level parsing helpers ────────────────────────────────────────────
// Pure and exported so the fiddly bits (tables, nesting, rules) are testable
// without a DOM.

export type Align = "left" | "center" | "right" | null

export interface TableSpec {
  header: string[]
  align: Align[]
  rows: string[][]
}

/** Splits a pipe-table row into cells: outer pipes are optional and `\|` is a
 *  literal pipe inside a cell, not a separator. */
export function splitTableRow(line: string): string[] {
  const cells: string[] = []
  let cur = ""
  const text = line.trim()
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === "\\" && text[i + 1] === "|") {
      cur += "|"
      i++
      continue
    }
    if (ch === "|") {
      cells.push(cur)
      cur = ""
      continue
    }
    cur += ch ?? ""
  }
  cells.push(cur)
  // A leading/trailing pipe produces an empty edge cell; drop those, but never
  // drop a genuinely empty middle cell.
  if (cells.length > 1 && cells[0]?.trim() === "" && text.startsWith("|")) cells.shift()
  if (cells.length > 1 && cells[cells.length - 1]?.trim() === "" && /(^|[^\\])\|$/.test(text)) {
    cells.pop()
  }
  return cells.map((c) => c.trim())
}

/** True when the line has a pipe that is not escaped — the cheap "could this be
 *  a table row?" test. */
export function hasUnescapedPipe(line: string): boolean {
  return /(^|[^\\])\|/.test(line)
}

/** `|:---|:---:|---:|` → per-column alignment, or null when the line is not a
 *  delimiter row. */
export function parseAlignRow(line: string): Align[] | null {
  if (!hasUnescapedPipe(line) && !/^\s*:?-{1,}:?\s*$/.test(line)) return null
  const cells = splitTableRow(line)
  if (cells.length === 0) return null
  const align: Align[] = []
  for (const cell of cells) {
    if (!/^:?-+:?$/.test(cell)) return null
    const left = cell.startsWith(":")
    const right = cell.endsWith(":") && cell.length > 1
    align.push(left && right ? "center" : right ? "right" : left ? "left" : null)
  }
  return align
}

/**
 * Parses a GFM pipe table starting at `start`, or returns null. A table needs a
 * header row plus a delimiter row with the same number of columns (that column
 * check is what keeps ordinary prose containing a pipe from becoming a table).
 * Body rows are padded/truncated to the header width, so a half-streamed final
 * row renders as a short row instead of a ragged one.
 */
export function parseTable(
  lines: string[],
  start: number,
): { table: TableSpec; next: number } | null {
  const headerLine = lines[start] ?? ""
  const delimLine = lines[start + 1]
  if (delimLine === undefined) return null
  if (!hasUnescapedPipe(headerLine)) return null
  const header = splitTableRow(headerLine)
  const align = parseAlignRow(delimLine)
  if (!align || align.length !== header.length || header.length === 0) return null

  const rows: string[][] = []
  let i = start + 2
  while (i < lines.length) {
    const raw = lines[i] ?? ""
    if (raw.trim() === "") break
    if (raw.trim().startsWith("```")) break
    if (!hasUnescapedPipe(raw)) break
    const cells = splitTableRow(raw)
    const row = header.map((_, c) => cells[c] ?? "")
    rows.push(row)
    i++
  }
  return { table: { header, align, rows }, next: i }
}

/** `---`, `***`, `___` (optionally spaced) alone on a line. Table delimiter rows
 *  never reach here: they carry pipes, and the table parser runs first. */
export function isHorizontalRule(line: string): boolean {
  const t = line.trim()
  if (t.length < 3) return false
  return /^(?:-\s*){3,}$/.test(t) || /^(?:\*\s*){3,}$/.test(t) || /^(?:_\s*){3,}$/.test(t)
}

export interface ListItem {
  indent: number
  text: string
}

export interface ListNode {
  text: string
  children: ListNode[]
}

/** `  - nested` → its indent and content; null when the line is not a bullet. */
export function parseBullet(raw: string): ListItem | null {
  const m = /^(\s*)[-*]\s+(.*)$/.exec(raw)
  if (!m) return null
  // A run of dashes is a thematic break, not a bullet.
  if (isHorizontalRule(raw)) return null
  return { indent: (m[1] ?? "").replace(/\t/g, "  ").length, text: m[2] ?? "" }
}

/** Folds indent-tagged bullets into a tree. Indents that don't line up with any
 *  open level attach to the nearest shallower one, so sloppy 3-space indents
 *  from a model still nest instead of flattening. */
export function buildListTree(items: ListItem[]): ListNode[] {
  const roots: ListNode[] = []
  const stack: { indent: number; node: ListNode }[] = []
  for (const item of items) {
    const node: ListNode = { text: item.text, children: [] }
    while (stack.length > 0 && item.indent <= (stack[stack.length - 1]?.indent ?? 0)) stack.pop()
    const parent = stack[stack.length - 1]
    if (parent) parent.node.children.push(node)
    else roots.push(node)
    stack.push({ indent: item.indent, node })
  }
  return roots
}

const ALIGN_CLASS: Record<NonNullable<Align>, string> = {
  left: "text-left",
  center: "text-center",
  right: "text-right",
}

// ── Inline rendering ───────────────────────────────────────────────────────

function renderInline(text: string, keyBase: string): ReactNode[] {
  return text.split(INLINE_RE).map((part, i) => {
    const k = `${keyBase}-${i}`
    if (!part) return null
    if (part.startsWith("**") && part.endsWith("**")) {
      return (
        <strong key={k} className="font-semibold text-foreground">
          {part.slice(2, -2)}
        </strong>
      )
    }
    if (part.startsWith("~~") && part.endsWith("~~")) {
      return (
        <s key={k} className="text-foreground/60 line-through decoration-foreground/40">
          {part.slice(2, -2)}
        </s>
      )
    }
    if (part.startsWith("*") && part.endsWith("*")) {
      return (
        <em key={k} className="text-foreground italic">
          {part.slice(1, -1)}
        </em>
      )
    }
    if (part.startsWith("`") && part.endsWith("`")) {
      return (
        <code
          key={k}
          className="mx-px whitespace-nowrap rounded-[5px] border border-border/70 bg-muted px-1.5 py-px font-mono text-[0.82em] text-foreground"
        >
          {part.slice(1, -1)}
        </code>
      )
    }
    const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(part)
    if (link) {
      const [, label, href] = link
      return (
        <a key={k} className={LINK_CLASS} href={href ?? "#"} rel="noreferrer" target="_blank">
          {label}
        </a>
      )
    }
    if (/^https?:\/\//.test(part)) {
      const [href, tail] = splitTrailingPunctuation(part)
      if (href) {
        return (
          <Fragment key={k}>
            <a className={LINK_CLASS} href={href} rel="noreferrer" target="_blank">
              {href}
            </a>
            {tail}
          </Fragment>
        )
      }
    }
    return <span key={k}>{part}</span>
  })
}

/** Bullet tree → nested <ul>. Depth only changes the marker and the indent, so
 *  arbitrarily deep lists stay readable. */
function renderList(nodes: ListNode[], keyBase: string, depth = 0): ReactNode {
  return (
    <ul className={cn("flex flex-col gap-1.5", depth > 0 && "mt-1.5 pl-1.5")}>
      {nodes.map((node, idx) => (
        <li
          key={`${keyBase}-${depth}-${idx}`}
          className="flex gap-2.5 text-[14px] leading-[1.6] text-foreground/90"
        >
          <span
            className={cn(
              "mt-[9px] size-1 shrink-0 rounded-full",
              depth === 0 ? "bg-primary/70" : "bg-foreground/35",
            )}
          />
          {/* A div, not a span: a nested <ul> is flow content and cannot live
              inside phrasing content. Layout is identical in a flex row. */}
          <div className="min-w-0 flex-1">
            {renderInline(node.text, `${keyBase}-${depth}-${idx}`)}
            {node.children.length > 0 &&
              renderList(node.children, `${keyBase}-${idx}`, depth + 1)}
          </div>
        </li>
      ))}
    </ul>
  )
}

function renderTable(spec: TableSpec, keyBase: string): ReactNode {
  const { header, align, rows } = spec
  return (
    // The wrapper scrolls so a wide table can never widen the transcript
    // column; `w-max min-w-full` lets the table grow past the wrapper instead
    // of squeezing columns into unreadable slivers.
    <div className="overflow-x-auto rounded-xl border border-border">
      <table className="w-max min-w-full border-collapse text-[13px]">
        <thead>
          <tr className="border-border/70 border-b bg-muted/50">
            {header.map((cell, c) => (
              <th
                key={`${keyBase}-h-${c}`}
                scope="col"
                className={cn(
                  "px-3 py-2 font-semibold text-foreground",
                  ALIGN_CLASS[align[c] ?? "left"],
                )}
              >
                {renderInline(cell, `${keyBase}-h-${c}`)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, r) => (
            <tr key={`${keyBase}-r-${r}`} className="border-border/50 border-b last:border-b-0">
              {row.map((cell, c) => (
                <td
                  key={`${keyBase}-r-${r}-${c}`}
                  className={cn(
                    "max-w-[44ch] px-3 py-2 align-top text-foreground/90",
                    ALIGN_CLASS[align[c] ?? "left"],
                  )}
                >
                  {renderInline(cell, `${keyBase}-r-${r}-${c}`)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function renderMarkdown(src: string): ReactNode {
  const lines = src.split("\n")
  const out: ReactNode[] = []
  let para: string[] = []
  let key = 0
  let i = 0

  const flushPara = () => {
    if (para.length === 0) return
    const first = out.length === 0
    out.push(
      <p
        key={`p-${key++}`}
        className={cn("text-[14px] leading-[1.72] text-foreground/90", !first && "mt-3.5")}
      >
        {renderInline(para.join(" "), `p${key}`)}
      </p>,
    )
    para = []
  }

  while (i < lines.length) {
    const raw = lines[i] ?? ""
    const line = raw.trim()

    // Fenced code
    if (line.startsWith("```")) {
      flushPara()
      const lang = line.slice(3).trim() || undefined
      const buf: string[] = []
      i++
      while (i < lines.length && !(lines[i] ?? "").trim().startsWith("```")) {
        buf.push(lines[i] ?? "")
        i++
      }
      i++ // consume closing fence
      out.push(<CodeBlock key={`c-${key++}`} code={buf.join("\n")} lang={lang} />)
      continue
    }

    // GFM pipe table — before the thematic-rule and paragraph branches so a
    // delimiter row is never mistaken for a rule.
    if (hasUnescapedPipe(line)) {
      const parsed = parseTable(lines, i)
      if (parsed) {
        flushPara()
        out.push(
          <div key={`t-${key++}`} className={cn(out.length > 0 && "mt-3.5")}>
            {renderTable(parsed.table, `t${key}`)}
          </div>,
        )
        i = parsed.next
        continue
      }
    }

    // Thematic break
    if (isHorizontalRule(line)) {
      flushPara()
      out.push(
        <hr
          key={`hr-${key++}`}
          className={cn("border-border/70 border-t", out.length > 0 ? "my-5" : "mb-5")}
        />,
      )
      i++
      continue
    }

    // Headings (#…######). Levels 4+ share the smallest size — deep headings in
    // chat output are section labels, not titles.
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      flushPara()
      const level = heading[1]?.length ?? 3
      out.push(
        <div
          key={`h-${key++}`}
          className={cn(
            "mb-1.5 font-semibold text-foreground",
            level <= 2 ? "text-[16px]" : level === 3 ? "text-[14.5px]" : "text-[13.5px]",
            out.length > 0 && "mt-5",
          )}
        >
          {renderInline(heading[2] ?? "", `h${key}`)}
        </div>,
      )
      i++
      continue
    }

    // Blockquote — consume the whole run, strip one level of `>` and render the
    // inner markdown, so quoted lists/code/quotes keep working.
    if (/^>\s?/.test(line)) {
      flushPara()
      const buf: string[] = []
      while (i < lines.length && /^>\s?/.test((lines[i] ?? "").trim())) {
        buf.push((lines[i] ?? "").trim().replace(/^>\s?/, ""))
        i++
      }
      out.push(
        <blockquote
          key={`bq-${key++}`}
          className={cn(
            "border-primary/40 border-l-2 py-0.5 pl-3.5 text-foreground/80",
            out.length > 0 && "mt-3.5",
          )}
        >
          {renderMarkdown(buf.join("\n"))}
        </blockquote>,
      )
      continue
    }

    // Unordered list, indentation-aware (2+ spaces nests under the item above).
    const bullet = parseBullet(raw)
    if (bullet) {
      flushPara()
      const items: ListItem[] = []
      for (let j = i; j < lines.length; j++) {
        const next = parseBullet(lines[j] ?? "")
        if (!next) break
        items.push(next)
        i = j + 1
      }
      out.push(
        <div key={`ul-${key++}`} className={cn(out.length > 0 && "mt-3")}>
          {renderList(buildListTree(items), `uli-${key}`)}
        </div>,
      )
      continue
    }

    // Ordered list
    if (/^\d+\.\s+/.test(line)) {
      flushPara()
      const items: string[] = []
      while (i < lines.length && /^\d+\.\s+/.test((lines[i] ?? "").trim())) {
        items.push((lines[i] ?? "").trim().replace(/^\d+\.\s+/, ""))
        i++
      }
      out.push(
        <ol key={`ol-${key++}`} className={cn("flex flex-col gap-2", out.length > 0 && "mt-3")}>
          {items.map((it, idx) => (
            <li
              key={idx}
              className="flex gap-2.5 text-[14px] leading-[1.55] text-foreground/90"
            >
              <span className="mt-px flex size-[18px] shrink-0 items-center justify-center rounded-md bg-muted font-semibold text-[11px] text-muted-foreground tabular-nums">
                {idx + 1}
              </span>
              <span className="min-w-0 pt-px">{renderInline(it, `oli-${key}-${idx}`)}</span>
            </li>
          ))}
        </ol>,
      )
      continue
    }

    if (line === "") {
      flushPara()
      i++
      continue
    }

    para.push(line)
    i++
  }

  flushPara()
  return <>{out}</>
}
