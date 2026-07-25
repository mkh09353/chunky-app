import { Check, Copy } from "lucide-react"
import { useState } from "react"
import { tokenize } from "~/lib/highlight"
import { cn } from "~/lib/cn"

export function CodeBlock({ code, lang }: { code: string; lang?: string }) {
  const [copied, setCopied] = useState(false)
  const lines = code.replace(/\n$/, "").split("\n")

  const copy = () => {
    try {
      void navigator.clipboard?.writeText(code)
    } catch {
      /* clipboard unavailable */
    }
    setCopied(true)
    setTimeout(() => setCopied(false), 1400)
  }

  return (
    <div className="group/code my-3 overflow-hidden rounded-xl border border-border bg-[color-mix(in_oklch,var(--background)_60%,var(--card))] shadow-xs">
      <div className="flex h-9 items-center justify-between border-border/70 border-b bg-muted/40 px-3">
        <div className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-full bg-[oklch(0.7_0.19_25)]/70" />
          <span className="size-2.5 rounded-full bg-[oklch(0.82_0.16_85)]/70" />
          <span className="size-2.5 rounded-full bg-[oklch(0.75_0.17_150)]/70" />
          <span className="ml-2 font-mono text-[11px] text-muted-foreground uppercase tracking-wide">
            {lang ?? "text"}
          </span>
        </div>
        <button
          type="button"
          onClick={copy}
          className={cn(
            "inline-flex h-6 cursor-pointer items-center gap-1.5 rounded-md px-2 font-medium text-[11px] text-muted-foreground opacity-0 outline-none transition-all hover:bg-accent hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring/50 group-hover/code:opacity-100",
            copied && "text-success opacity-100",
          )}
        >
          {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <div className="overflow-x-auto">
        <pre className="min-w-full py-3 font-mono text-[12.5px] leading-relaxed">
          <code>
            {lines.map((line, li) => (
              <div key={li} className="flex px-4 hover:bg-foreground/[0.03]">
                <span className="mr-4 w-6 shrink-0 select-none text-right text-muted-foreground/40 tabular-nums">
                  {li + 1}
                </span>
                <span className="whitespace-pre">
                  {line.length === 0
                    ? " "
                    : tokenize(line).map((t, ti) =>
                        t.cls ? (
                          <span key={ti} className={t.cls}>
                            {t.text}
                          </span>
                        ) : (
                          <span key={ti}>{t.text}</span>
                        ),
                      )}
                </span>
              </div>
            ))}
          </code>
        </pre>
      </div>
    </div>
  )
}
