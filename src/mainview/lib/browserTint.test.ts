// A page-supplied colour must never reach a style unvalidated.
// Run with: bun test src/mainview/lib/browserTint.test.ts
import { describe, expect, test } from "bun:test"
import {
  THEME_BASE,
  TINT_STRENGTH,
  blend,
  contrastRatio,
  parseCssColor,
  relativeLuminance,
  resolveToolbarTint,
  toRgbString,
} from "./browserTint"

describe("parseCssColor", () => {
  test("accepts hex in every length", () => {
    expect(parseCssColor("#fff")).toEqual({ r: 255, g: 255, b: 255 })
    expect(parseCssColor("#FFF")).toEqual({ r: 255, g: 255, b: 255 })
    expect(parseCssColor("#1a2b3c")).toEqual({ r: 26, g: 43, b: 60 })
    expect(parseCssColor("#1a2b3c80")).toEqual({ r: 26, g: 43, b: 60 })
    expect(parseCssColor("#0f08")).toEqual({ r: 0, g: 255, b: 0 })
    expect(parseCssColor("  #7c4ddb  ")).toEqual({ r: 124, g: 77, b: 219 })
  })

  test("accepts rgb()/rgba() in comma and space syntax, and percentages", () => {
    expect(parseCssColor("rgb(255, 0, 128)")).toEqual({ r: 255, g: 0, b: 128 })
    expect(parseCssColor("rgb(255 0 128)")).toEqual({ r: 255, g: 0, b: 128 })
    expect(parseCssColor("rgba(10, 20, 30, 0.5)")).toEqual({ r: 10, g: 20, b: 30 })
    expect(parseCssColor("rgb(100% 0% 50%)")).toEqual({ r: 255, g: 0, b: 128 })
    expect(parseCssColor("rgb(300, -20, 40)")).toEqual({ r: 255, g: 0, b: 40 })
  })

  test("accepts allowlisted named colours only", () => {
    expect(parseCssColor("rebeccapurple")).toBeNull()
    expect(parseCssColor("Tomato")).toEqual({ r: 255, g: 99, b: 71 })
    expect(parseCssColor("navy")).toEqual({ r: 0, g: 0, b: 128 })
  })

  test("REFUSES hostile input", () => {
    for (const hostile of [
      "url(https://evil.test/x.png)",
      "var(--background)",
      "#fff;background:url(javascript:alert(1))",
      "red;position:fixed;inset:0",
      "javascript:alert(1)",
      "expression(alert(1))",
      "#fff/*comment*/",
      'rgb(0,0,0)" onload="alert(1)',
      "<script>alert(1)</script>",
      "rgb(0,0,0)\n;color:red",
      "color-mix(in oklch, red, blue)",
      "image-set(url(x))",
      "attr(data-x)",
      "#".padEnd(400, "f"),
      "rgb(".padEnd(200, "0") + ")",
    ]) {
      expect(parseCssColor(hostile)).toBeNull()
    }
  })

  test("refuses malformed and non-strings", () => {
    expect(parseCssColor("")).toBeNull()
    expect(parseCssColor("#12")).toBeNull()
    expect(parseCssColor("#1234567")).toBeNull()
    expect(parseCssColor("rgb(1,2)")).toBeNull()
    expect(parseCssColor("hsl(200 50% 50%)")).toBeNull()
    expect(parseCssColor(null)).toBeNull()
    expect(parseCssColor(undefined)).toBeNull()
    expect(parseCssColor(0x123456)).toBeNull()
    expect(parseCssColor({ r: 1, g: 2, b: 3 })).toBeNull()
  })
})

describe("relativeLuminance / contrastRatio", () => {
  test("anchors at black and white", () => {
    expect(relativeLuminance({ r: 0, g: 0, b: 0 })).toBeCloseTo(0, 5)
    expect(relativeLuminance({ r: 255, g: 255, b: 255 })).toBeCloseTo(1, 5)
    expect(contrastRatio({ r: 0, g: 0, b: 0 }, { r: 255, g: 255, b: 255 })).toBeCloseTo(21, 1)
  })

  test("is symmetric", () => {
    const a = { r: 124, g: 77, b: 219 }
    const b = { r: 250, g: 250, b: 250 }
    expect(contrastRatio(a, b)).toBeCloseTo(contrastRatio(b, a), 6)
  })
})

describe("blend", () => {
  test("interpolates and clamps the amount", () => {
    const white = { r: 255, g: 255, b: 255 }
    const black = { r: 0, g: 0, b: 0 }
    expect(blend(black, white, 0)).toEqual(white)
    expect(blend(black, white, 1)).toEqual(black)
    expect(blend(black, white, 0.5)).toEqual({ r: 128, g: 128, b: 128 })
    expect(blend(black, white, -5)).toEqual(white)
    expect(blend(black, white, 5)).toEqual(black)
  })
})

describe("toRgbString", () => {
  test("only ever emits integers", () => {
    expect(toRgbString({ r: 1.4, g: -20, b: 999 })).toBe("rgb(1 0 255)")
  })
})

describe("resolveToolbarTint", () => {
  test("produces a subtle tint, not a repaint", () => {
    const tint = resolveToolbarTint("#7c4ddb", "light")
    expect(tint).not.toBeNull()
    // 14% of a strong purple over a near-white base stays near-white.
    expect(tint!.background).toBe("rgb(234 228 249)")
    // The app's own text colour is still comfortable, so no override.
    expect(tint!.foreground).toBeNull()
    expect(tint!.border).not.toBe(tint!.background)
  })

  test("works in both themes", () => {
    const light = resolveToolbarTint("#0a84ff", "light")!
    const dark = resolveToolbarTint("#0a84ff", "dark")!
    expect(light.background).not.toBe(dark.background)
    // Each stays close to its own base: this is a hue, not a repaint.
    for (const [tint, theme] of [
      [light, "light"],
      [dark, "dark"],
    ] as const) {
      const match = /rgb\((\d+) (\d+) (\d+)\)/.exec(tint.background)!
      const blended = { r: +match[1]!, g: +match[2]!, b: +match[3]! }
      expect(contrastRatio(blended, THEME_BASE[theme].foreground)).toBeGreaterThan(4.5)
    }
  })

  test("returns null (default chrome) for anything unusable", () => {
    expect(resolveToolbarTint(null, "light")).toBeNull()
    expect(resolveToolbarTint("", "dark")).toBeNull()
    expect(resolveToolbarTint("url(x)", "light")).toBeNull()
    expect(resolveToolbarTint("var(--background)", "dark")).toBeNull()
  })

  test("at the shipped strength the app's own foreground always wins", () => {
    // Documents the measurement in `ToolbarTint.foreground`: the override is a
    // guard rail, not a feature. If TINT_STRENGTH is ever raised, this test is
    // the one that should be revisited deliberately.
    let overrides = 0
    let worst = Number.POSITIVE_INFINITY
    for (let r = 0; r < 256; r += 51) {
      for (let g = 0; g < 256; g += 51) {
        for (let b = 0; b < 256; b += 51) {
          const hex = `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`
          for (const theme of ["light", "dark"] as const) {
            const tint = resolveToolbarTint(hex, theme)!
            if (tint.foreground) overrides += 1
            const bg = blend(parseCssColor(hex)!, THEME_BASE[theme].background, TINT_STRENGTH)
            worst = Math.min(worst, contrastRatio(bg, THEME_BASE[theme].foreground))
          }
        }
      }
    }
    expect(overrides).toBe(0)
    expect(worst).toBeGreaterThan(10)
  })

  test("only overrides the foreground when the default becomes unreadable", () => {
    // Sweep the extremes: whatever comes back must be readable.
    for (const theme of ["light", "dark"] as const) {
      for (const color of ["#000000", "#ffffff", "#ff0000", "#00ff00", "#0000ff", "#808080"]) {
        const tint = resolveToolbarTint(color, theme)!
        const match = /rgb\((\d+) (\d+) (\d+)\)/.exec(tint.background)!
        const bg = { r: +match[1]!, g: +match[2]!, b: +match[3]! }
        const fgMatch = tint.foreground ? /rgb\((\d+) (\d+) (\d+)\)/.exec(tint.foreground)! : null
        const fg = fgMatch
          ? { r: +fgMatch[1]!, g: +fgMatch[2]!, b: +fgMatch[3]! }
          : THEME_BASE[theme].foreground
        expect(contrastRatio(bg, fg)).toBeGreaterThan(4.5)
      }
    }
  })
})
