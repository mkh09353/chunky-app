// Brand marks for model providers, keyed by the provider ids the server
// exposes (anthropic, codex, grok, zen + a few aliases). Marks are inline SVG
// — no remote URLs, no bitmaps — so they stay crisp at any size and, where the
// brand is monochrome, follow `currentColor` for dark/light.
//
// Provenance:
//   grok  — official xAI Grok logomark (`Grok_Logomark_Dark.svg` from the xAI
//           brand-guideline asset pack, retrieved via the sibling Buzz repo's
//           `public/harness-logos/grok.svg`). Paths are unmodified, including
//           the #0A0A0A fill, because xAI's guidelines require the mark be used
//           exactly as provided — hence the white tile so it reads in dark mode.
//   claude/anthropic — an ORIGINAL geometric rendition of the Claude burst
//           (12 alternating rays) in Anthropic's brand orange. It is not the
//           official asset: Anthropic does not license one for redistribution
//           and no vetted path data was available offline.
//   codex — deliberately NOT the OpenAI blossom. It was pulled from
//           simple-icons at OpenAI's request, so (like Buzz) we ship a neutral
//           terminal glyph instead of an unlicensed vendor mark.
//   zen   — Chunky's own OpenAI-compatible gateway; no vendor brand exists, so
//           this is an original enso glyph in `currentColor`.
// Unknown ids (custom providers, future vendors) fall back to a monogram tile.
import { SquareTerminal } from "lucide-react"
import type { ReactElement } from "react"
import { cn } from "~/lib/cn"

interface MarkProps {
  className?: string
}

/** Anthropic brand orange. */
const CLAUDE_ORANGE = "#D97757"

/** 12 rays, alternating long/short — the Claude burst silhouette. */
const CLAUDE_RAYS = Array.from({ length: 12 }, (_, i) => {
  const angle = (i * Math.PI) / 6
  const inner = 9
  const outer = i % 2 === 0 ? 40 : 28
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  return {
    x1: +(50 + cos * inner).toFixed(2),
    y1: +(50 + sin * inner).toFixed(2),
    x2: +(50 + cos * outer).toFixed(2),
    y2: +(50 + sin * outer).toFixed(2),
    w: i % 2 === 0 ? 9 : 7,
  }
})

function ClaudeMark({ className }: MarkProps) {
  return (
    <svg
      aria-hidden="true"
      role="img"
      viewBox="0 0 100 100"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      {CLAUDE_RAYS.map((ray) => (
        <line
          key={`${ray.x1}-${ray.y1}-${ray.x2}-${ray.y2}`}
          x1={ray.x1}
          y1={ray.y1}
          x2={ray.x2}
          y2={ray.y2}
          stroke={CLAUDE_ORANGE}
          strokeWidth={ray.w}
          strokeLinecap="round"
        />
      ))}
    </svg>
  )
}

/** Official xAI logomark; kept at its shipped fill on a white tile. */
function GrokMark({ className }: MarkProps) {
  return (
    <span className={cn("flex items-center justify-center rounded-xl bg-white", className)}>
      <svg
        aria-hidden="true"
        role="img"
        viewBox="0 0 1024 1024"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className="size-[68%]"
      >
        <path
          d="M395.479 633.828L735.91 381.105C752.599 368.715 776.454 373.548 784.406 392.792C826.26 494.285 807.561 616.253 724.288 699.996C641.016 783.739 525.151 802.104 419.247 760.277L303.556 814.143C469.49 928.202 670.987 899.995 796.901 773.282C896.776 672.843 927.708 535.937 898.785 412.476L899.047 412.739C857.105 231.37 909.358 158.874 1016.4 10.6326C1018.93 7.11771 1021.47 3.60279 1024 0L883.144 141.651V141.212L395.392 633.916"
          fill="#0A0A0A"
        />
        <path
          d="M325.226 695.251C206.128 580.84 226.662 403.776 328.285 301.668C403.431 226.097 526.549 195.254 634.026 240.596L749.454 186.994C728.657 171.88 702.007 155.623 671.424 144.2C533.19 86.9942 367.693 115.465 255.323 228.382C147.234 337.081 113.244 504.215 171.613 646.833C215.216 753.423 143.739 828.818 71.7385 904.916C46.2237 931.893 20.6216 958.87 0 987.429L325.139 695.339"
          fill="#0A0A0A"
        />
      </svg>
    </span>
  )
}

/** Neutral terminal glyph for Codex (see provenance note above). */
function CodexMark({ className }: MarkProps) {
  return <SquareTerminal aria-hidden className={cn("text-foreground", className)} strokeWidth={1.25} />
}

/** Enso ring for Chunky's OpenAI-compatible Zen gateway. */
function ZenMark({ className }: MarkProps) {
  return (
    <svg
      aria-hidden="true"
      role="img"
      viewBox="0 0 100 100"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={cn("text-foreground", className)}
    >
      <circle
        cx="50"
        cy="50"
        r="34"
        stroke="currentColor"
        strokeWidth="8"
        strokeLinecap="round"
        strokeDasharray="190 224"
        transform="rotate(-35 50 50)"
      />
      <circle cx="50" cy="50" r="7" fill="currentColor" />
    </svg>
  )
}

const MARKS: Record<string, (props: MarkProps) => ReactElement> = {
  anthropic: ClaudeMark,
  claude: ClaudeMark,
  codex: CodexMark,
  openai: CodexMark,
  grok: GrokMark,
  xai: GrokMark,
  zen: ZenMark,
}

/** True when we have a real mark for this provider id (else: monogram). */
export function hasProviderMark(id: string): boolean {
  return MARKS[id.trim().toLowerCase()] !== undefined
}

/**
 * Provider brand mark, or a monogram tile for ids we don't ship a mark for.
 * `className` controls the box size (defaults to 40px).
 */
export function ProviderMark({
  id,
  label,
  className = "size-10",
}: {
  id: string
  label?: string
  className?: string
}) {
  const Mark = MARKS[id.trim().toLowerCase()]
  if (Mark) return <Mark className={className} />

  const source = (label ?? id).trim()
  return (
    <span
      aria-hidden
      className={cn(
        "flex items-center justify-center rounded-xl bg-foreground/8 font-medium text-[16px] text-foreground",
        className,
      )}
    >
      {source.charAt(0).toUpperCase() || "?"}
    </span>
  )
}
