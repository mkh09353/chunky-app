// Tinting the pane toolbar with the page's `theme-color`.
//
// The colour comes from an untrusted page, so the rule is absolute: the string
// the page sends NEVER reaches CSS. It is parsed here into three integers, and
// only numbers we produced ourselves are interpolated into a style. Anything
// that is not an unambiguous colour literal — `url(...)`, `var(...)`, a value
// with a `;` or a comment, a 10 kB string, an unknown function — is rejected
// outright rather than sanitised.
//
// Aesthetics: this is Safari's compact-tab tinting, not a repaint. The page
// colour is blended into the app's own background at a low ratio, so the
// toolbar picks up a hue and nothing else, in both themes.

export interface Rgb {
  r: number
  g: number
  b: number
}

/** How much of the page colour ends up in the toolbar. Subtle on purpose. */
export const TINT_STRENGTH = 0.14

/**
 * The app's `--background` / `--foreground` tokens in sRGB, per theme.
 *
 * Converted from the oklch tokens in `index.css`
 * (`--background: oklch(0.991 0.003 300)` etc.). They exist so the blended
 * result's contrast can be checked HERE, without a DOM: the CSS the component
 * writes still blends against the live token via `color-mix`, so a token change
 * shifts the real colour and only nudges this estimate.
 */
export const THEME_BASE = {
  light: { background: { r: 252, g: 252, b: 254 }, foreground: { r: 37, g: 34, b: 45 } },
  dark: { background: { r: 17, g: 16, b: 22 }, foreground: { r: 244, g: 243, b: 246 } },
} as const

export type AppTheme = keyof typeof THEME_BASE

/** Longest input worth looking at: `rgba(255, 255, 255, 0.5)` is 24 chars. */
const MAX_COLOR_LENGTH = 32

/**
 * The named colours accepted. Deliberately a short allowlist rather than "ask
 * the browser to parse it": a canvas/DOM round trip would accept anything the
 * engine accepts, including forms this module has not reasoned about.
 */
const NAMED_COLORS: Record<string, Rgb> = {
  black: { r: 0, g: 0, b: 0 },
  white: { r: 255, g: 255, b: 255 },
  silver: { r: 192, g: 192, b: 192 },
  gray: { r: 128, g: 128, b: 128 },
  grey: { r: 128, g: 128, b: 128 },
  red: { r: 255, g: 0, b: 0 },
  maroon: { r: 128, g: 0, b: 0 },
  orange: { r: 255, g: 165, b: 0 },
  yellow: { r: 255, g: 255, b: 0 },
  olive: { r: 128, g: 128, b: 0 },
  lime: { r: 0, g: 255, b: 0 },
  green: { r: 0, g: 128, b: 0 },
  teal: { r: 0, g: 128, b: 128 },
  aqua: { r: 0, g: 255, b: 255 },
  cyan: { r: 0, g: 255, b: 255 },
  blue: { r: 0, g: 0, b: 255 },
  navy: { r: 0, g: 0, b: 128 },
  purple: { r: 128, g: 0, b: 128 },
  fuchsia: { r: 255, g: 0, b: 255 },
  magenta: { r: 255, g: 0, b: 255 },
  pink: { r: 255, g: 192, b: 203 },
  brown: { r: 165, g: 42, b: 42 },
  indigo: { r: 75, g: 0, b: 130 },
  violet: { r: 238, g: 130, b: 238 },
  gold: { r: 255, g: 215, b: 0 },
  salmon: { r: 250, g: 128, b: 114 },
  tomato: { r: 255, g: 99, b: 71 },
  crimson: { r: 220, g: 20, b: 60 },
  turquoise: { r: 64, g: 224, b: 208 },
  tan: { r: 210, g: 180, b: 140 },
  beige: { r: 245, g: 245, b: 220 },
  ivory: { r: 255, g: 255, b: 240 },
  coral: { r: 255, g: 127, b: 80 },
  khaki: { r: 240, g: 230, b: 140 },
  lavender: { r: 230, g: 230, b: 250 },
  plum: { r: 221, g: 160, b: 221 },
  orchid: { r: 218, g: 112, b: 214 },
}

const HEX_RE = /^#([0-9a-f]{3,8})$/i
const RGB_RE =
  /^rgba?\(\s*(-?[\d.]+%?)\s*[,\s]\s*(-?[\d.]+%?)\s*[,\s]\s*(-?[\d.]+%?)\s*(?:[,/]\s*(-?[\d.]+%?)\s*)?\)$/i

const clampByte = (value: number): number => Math.max(0, Math.min(255, Math.round(value)))

function channelFrom(token: string): number | null {
  const percent = token.endsWith("%")
  const value = Number.parseFloat(percent ? token.slice(0, -1) : token)
  if (!Number.isFinite(value)) return null
  return clampByte(percent ? (value / 100) * 255 : value)
}

/**
 * Parse a page-supplied colour. Returns null for ANYTHING not certainly a
 * plain colour literal — the caller must treat null as "no tint".
 *
 * Supported: `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, `rgb()/rgba()` in comma
 * or space syntax with numbers or percentages, and the named colours above.
 * Alpha is parsed but ignored: the tint has its own blend ratio.
 */
export function parseCssColor(raw: unknown): Rgb | null {
  if (typeof raw !== "string") return null
  const value = raw.trim().toLowerCase()
  if (!value || value.length > MAX_COLOR_LENGTH) return null
  // No CSS syntax may travel with the value, whatever else it looks like.
  if (/[;{}\\<>"']/.test(value) || value.includes("/*") || value.includes("\n")) return null

  const hex = HEX_RE.exec(value)
  if (hex) {
    const digits = hex[1]!
    if (digits.length === 3 || digits.length === 4) {
      return {
        r: Number.parseInt(digits[0]!.repeat(2), 16),
        g: Number.parseInt(digits[1]!.repeat(2), 16),
        b: Number.parseInt(digits[2]!.repeat(2), 16),
      }
    }
    if (digits.length === 6 || digits.length === 8) {
      return {
        r: Number.parseInt(digits.slice(0, 2), 16),
        g: Number.parseInt(digits.slice(2, 4), 16),
        b: Number.parseInt(digits.slice(4, 6), 16),
      }
    }
    return null
  }

  const rgb = RGB_RE.exec(value)
  if (rgb) {
    const r = channelFrom(rgb[1]!)
    const g = channelFrom(rgb[2]!)
    const b = channelFrom(rgb[3]!)
    if (r == null || g == null || b == null) return null
    return { r, g, b }
  }

  return NAMED_COLORS[value] ?? null
}

/** WCAG relative luminance (0 = black, 1 = white). */
export function relativeLuminance({ r, g, b }: Rgb): number {
  const channel = (value: number) => {
    const v = value / 255
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

/** WCAG contrast ratio between two colours (1 … 21). */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  const [light, dark] = la >= lb ? [la, lb] : [lb, la]
  return (light + 0.05) / (dark + 0.05)
}

/** Linear blend: `amount` of `color` over `base`. */
export function blend(color: Rgb, base: Rgb, amount: number): Rgb {
  const t = Math.max(0, Math.min(1, amount))
  return {
    r: clampByte(base.r + (color.r - base.r) * t),
    g: clampByte(base.g + (color.g - base.g) * t),
    b: clampByte(base.b + (color.b - base.b) * t),
  }
}

/** `rgb(r g b)` built from integers this module produced. */
export function toRgbString({ r, g, b }: Rgb): string {
  return `rgb(${clampByte(r)} ${clampByte(g)} ${clampByte(b)})`
}

export interface ToolbarTint {
  /** Background for the toolbar strip. */
  background: string
  /** Border tint, a touch stronger so the strip still reads as an edge. */
  border: string
  /**
   * Foreground override, or null to keep the app's own text colour.
   *
   * MEASURED: at the shipped `TINT_STRENGTH` this is ALWAYS null — a sweep of
   * 5,832 colours x both themes never drops below 11:1 against the app's own
   * foreground, versus the 4.5 threshold. It is a guard rail for a future
   * strength increase, not a feature, and keeping it null keeps every control
   * (address bar, refusal strip, find bar, action menu) on its own tokens.
   */
  foreground: string | null
}

/** Below this, the app's default text colour is no longer comfortable. */
const MIN_CONTRAST = 4.5

/**
 * Turn a validated page colour into toolbar styling for the active theme.
 *
 * Returns null when there is no usable colour, which the caller renders as
 * "default chrome" — the same state as before any page reported one.
 */
export function resolveToolbarTint(raw: unknown, theme: AppTheme): ToolbarTint | null {
  const color = parseCssColor(raw)
  if (!color) return null
  const base = THEME_BASE[theme]

  const background = blend(color, base.background, TINT_STRENGTH)
  const border = blend(color, base.background, TINT_STRENGTH * 2.2)

  // The estimate of what the text will sit on. The real background is a
  // `color-mix` against the live token, which is the same colour to within a
  // rounding step, so this is a fair test.
  const defaultContrast = contrastRatio(background, base.foreground)
  if (defaultContrast >= MIN_CONTRAST) {
    return { background: toRgbString(background), border: toRgbString(border), foreground: null }
  }

  // Only reached by an extreme colour in a theme it fights: pick whichever end
  // of the scale reads better rather than keeping unreadable text.
  const alternative = theme === "light" ? THEME_BASE.dark.foreground : THEME_BASE.light.foreground
  const useAlternative = contrastRatio(background, alternative) > defaultContrast
  return {
    background: toRgbString(background),
    border: toRgbString(border),
    foreground: useAlternative ? toRgbString(alternative) : null,
  }
}
