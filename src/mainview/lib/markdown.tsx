import { Fragment, type ReactNode } from "react"
import { cn } from "~/lib/cn"
import { CodeBlock } from "~/components/CodeBlock"

/*
 * A deliberately tiny markdown renderer — enough to make assistant prose look
 * like a real shadcn transcript, with zero dependencies. Handles headings,
 * unordered/ordered lists, fenced code, paragraphs, and inline
 * **bold** / *italic* / `code` / [links](href) / bare http(s) URLs.
 */

// Order matters only where two alternatives can start at the same index: code
// spans and [label](href) are listed before the bare-URL branch, so a URL that
// lives inside `backticks` or a markdown link is consumed by those first.
const INLINE_RE =
  /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`|\[[^\]]+\]\([^)]+\)|https?:\/\/[^\s<>"'`]+)/g

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

    // Headings
    const heading = /^(#{1,3})\s+(.*)$/.exec(line)
    if (heading) {
      flushPara()
      const level = heading[1]?.length ?? 3
      out.push(
        <div
          key={`h-${key++}`}
          className={cn(
            "mb-1.5 font-semibold text-foreground",
            level <= 2 ? "text-[16px]" : "text-[14.5px]",
            out.length > 0 && "mt-5",
          )}
        >
          {renderInline(heading[2] ?? "", `h${key}`)}
        </div>,
      )
      i++
      continue
    }

    // Unordered list
    if (/^[-*]\s+/.test(line)) {
      flushPara()
      const items: string[] = []
      while (i < lines.length && /^[-*]\s+/.test((lines[i] ?? "").trim())) {
        items.push((lines[i] ?? "").trim().replace(/^[-*]\s+/, ""))
        i++
      }
      out.push(
        <ul key={`ul-${key++}`} className={cn("flex flex-col gap-1.5", out.length > 0 && "mt-3")}>
          {items.map((it, idx) => (
            <li
              key={idx}
              className="flex gap-2.5 text-[14px] leading-[1.6] text-foreground/90"
            >
              <span className="mt-[9px] size-1 shrink-0 rounded-full bg-primary/70" />
              <span className="min-w-0">{renderInline(it, `uli-${key}-${idx}`)}</span>
            </li>
          ))}
        </ul>,
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
