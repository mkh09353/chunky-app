// A QR symbol as accessible, crisp SVG.
//
// Rendered as JSX (never innerHTML/dangerouslySetInnerHTML) from a single
// <path> of unit squares. The encoded value is NOT put in any attribute —
// `d` is geometry, and the accessible name is a fixed description, so the
// one-time pairing secret never lands in the DOM as readable text.
//
// Colors are deliberately fixed (dark modules on a white plate) instead of
// theme tokens: an inverted QR is a coin toss across scanner apps, and this
// has to work on the first try in dark mode.
import { useMemo } from "react"
import { cn } from "~/lib/cn"
import { qrPath, type QrEcc } from "~/lib/qr"

export function QrCode({
  value,
  /** Preferred edge length in px. It is a MAXIMUM, not a fixed size: the
   *  settings dialog gets narrow (its nav alone is 12rem), and a fixed width
   *  here would push the symbol out of the card instead of scaling it. */
  size = 288,
  ecc = "M",
  /** Accessible name. Must describe the code — never contain the payload. */
  label,
  className,
}: {
  value: string
  size?: number
  ecc?: QrEcc
  label: string
  className?: string
}) {
  const { d, span, modules } = useMemo(() => qrPath(value, { ecc }), [value, ecc])
  if (!modules) return null
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${span} ${span}`}
      // Scales with the container (viewBox keeps it square) and never exceeds
      // `size`; no width/height attributes, which would pin it open.
      style={{ maxWidth: size, maxHeight: size }}
      // Keep hard module edges while the viewBox scales to the available width.
      shapeRendering="crispEdges"
      className={cn("h-auto w-full rounded-lg", className)}
    >
      {/* The quiet zone is part of the symbol: paint the whole plate white. */}
      <rect width={span} height={span} fill="#ffffff" />
      <path d={d} fill="#000000" />
    </svg>
  )
}
