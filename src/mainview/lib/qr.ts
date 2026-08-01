// QR geometry for the renderer — pure, DOM-free, and therefore testable.
//
// The Relay pairing QR is drawn as ONE <path> of unit squares rather than a
// rect-per-module (roughly 25% smaller markup) and rather than a library's
// prebuilt SVG string, because we render JSX — never innerHTML, and never the
// payload itself in an attribute. `d` carries geometry only.
//
// uqr's `encode` adds a 1-module quiet zone by DEFAULT, which would silently
// double up with ours; we always ask for `border: 0` and add the spec's
// 4-module quiet zone here, explicitly.
import { encode } from "uqr"

/** Quiet zone required by the QR spec, in modules, on every side. */
export const QR_QUIET_ZONE = 4

/** Error-correction level. "M" survives a smudged screen without inflating
 *  the symbol the way "Q"/"H" do (a ~290-char pairing payload is version 13). */
export type QrEcc = "L" | "M" | "Q" | "H"

export interface QrPath {
  /** SVG path data in module units, already offset by the quiet zone. */
  d: string
  /** Width/height of the viewBox in module units (modules + 2 × border). */
  span: number
  /** Module count per side, excluding the quiet zone. 0 when there's no code. */
  modules: number
  /** QR symbol version (1–40), or 0 when there's no code. */
  version: number
}

/**
 * Encode `text` and return single-path geometry for it.
 *
 * An empty string yields an empty path instead of throwing: the caller renders
 * a QR only while a pairing is live, and a render-time throw would take the
 * whole settings dialog down.
 */
export function qrPath(
  text: string,
  options: { border?: number; ecc?: QrEcc } = {},
): QrPath {
  const border = options.border ?? QR_QUIET_ZONE
  if (!text) return { d: "", span: border * 2, modules: 0, version: 0 }

  // border: 0 is deliberate — see the module comment.
  const qr = encode(text, { ecc: options.ecc ?? "M", border: 0 })
  let d = ""
  for (let row = 0; row < qr.size; row++) {
    const line = qr.data[row]
    if (!line) continue
    for (let col = 0; col < qr.size; col++) {
      // One unit square per dark module, offset into the quiet zone.
      if (line[col]) d += `M${col + border} ${row + border}h1v1h-1z`
    }
  }
  return { d, span: qr.size + border * 2, modules: qr.size, version: qr.version }
}
