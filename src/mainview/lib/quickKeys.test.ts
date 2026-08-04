// Quick-key rules: what the editor accepts, what a hotkey press resolves to,
// and what survives a round trip through desktop.json.
import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { mergeDesktopState, readDesktopState } from "../../bun/desktopState"
import { QuickKeys } from "../components/QuickKeys"
import {
  cleanQuickKeys,
  EMOJI_CHOICES,
  emptyQuickKeyDraft,
  graphemeLength,
  hasQuickKeyErrors,
  hotkeyLabel,
  MAX_EMOJI_GRAPHEMES,
  MAX_QUICK_KEYS,
  nextQuickKeyId,
  normalizeHotkey,
  quickKeyForHotkey,
  quickKeyFromDraft,
  removeQuickKey,
  truncateGraphemes,
  upsertQuickKey,
  validateQuickKey,
  type QuickKey,
} from "./quickKeys"

/** True when no unpaired surrogate survived a cut (String.isWellFormed is
 *  newer than this project's lib target). */
function wellFormed(value: string): boolean {
  return !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value)
}

function key(partial: Partial<QuickKey> & { id: string }): QuickKey {
  return { emoji: "", label: `Key ${partial.id}`, prompt: "do it", hotkey: "", ...partial }
}

describe("validateQuickKey", () => {
  test("requires a label and a prompt", () => {
    const errors = validateQuickKey(emptyQuickKeyDraft())
    expect(errors.label).toBeTruthy()
    expect(errors.prompt).toBeTruthy()
    expect(hasQuickKeyErrors(errors)).toBe(true)
  })

  test("accepts a minimal draft with no hotkey", () => {
    const errors = validateQuickKey({ emoji: "", label: "Ship", prompt: "ship it", hotkey: "" })
    expect(hasQuickKeyErrors(errors)).toBe(false)
  })

  test("treats whitespace-only fields as missing", () => {
    const errors = validateQuickKey({ emoji: "", label: "  ", prompt: "\n\t", hotkey: "" })
    expect(errors.label).toBeTruthy()
    expect(errors.prompt).toBeTruthy()
  })

  test("rejects letters the app's own shortcuts already answer to", () => {
    for (const letter of ["k", "l", "n", "t", "K"]) {
      const errors = validateQuickKey({ emoji: "", label: "X", prompt: "y", hotkey: letter })
      expect(errors.hotkey).toBeTruthy()
    }
  })

  test("rejects a hotkey that is not a single letter", () => {
    expect(validateQuickKey({ emoji: "", label: "X", prompt: "y", hotkey: "dd" }).hotkey).toBeTruthy()
    expect(validateQuickKey({ emoji: "", label: "X", prompt: "y", hotkey: "1" }).hotkey).toBeTruthy()
  })

  test("rejects a hotkey another quick key already uses, naming it", () => {
    const existing = [key({ id: "qk-1", label: "Ship it!", hotkey: "d" })]
    const errors = validateQuickKey({ emoji: "", label: "X", prompt: "y", hotkey: "D" }, existing)
    expect(errors.hotkey).toContain("Ship it!")
  })

  test("lets the key being edited keep its own hotkey", () => {
    const existing = [key({ id: "qk-1", hotkey: "d" })]
    const errors = validateQuickKey({ emoji: "", label: "X", prompt: "y", hotkey: "d" }, existing, "qk-1")
    expect(hasQuickKeyErrors(errors)).toBe(false)
  })

  test("bounds the label, prompt and icon", () => {
    const errors = validateQuickKey({
      emoji: "x".repeat(20),
      label: "l".repeat(200),
      prompt: "p".repeat(5000),
      hotkey: "",
    })
    expect(errors.emoji).toBeTruthy()
    expect(errors.label).toBeTruthy()
    expect(errors.prompt).toBeTruthy()
  })
})

describe("drafts", () => {
  test("are trimmed and normalized on the way in", () => {
    const built = quickKeyFromDraft(
      { emoji: " 🚢 ", label: "  Ship it!  ", prompt: "  ship it\n", hotkey: "D" },
      "qk-7",
    )
    expect(built).toEqual({ id: "qk-7", emoji: "🚢", label: "Ship it!", prompt: "ship it", hotkey: "d" })
  })

  test("normalizeHotkey keeps one letter and drops anything else", () => {
    expect(normalizeHotkey("D")).toBe("d")
    expect(normalizeHotkey(" d ")).toBe("d")
    expect(normalizeHotkey("7")).toBe("")
    expect(normalizeHotkey("")).toBe("")
  })

  test("hotkeyLabel renders the badge the chip shows", () => {
    expect(hotkeyLabel("d")).toBe("⌘⇧D")
    expect(hotkeyLabel("")).toBe("")
  })
})

describe("list edits", () => {
  test("nextQuickKeyId never collides with an existing id", () => {
    expect(nextQuickKeyId([])).toBe("qk-1")
    expect(nextQuickKeyId([key({ id: "qk-1" }), key({ id: "qk-4" })])).toBe("qk-5")
    expect(nextQuickKeyId([key({ id: "custom" })])).toBe("qk-1")
  })

  test("upsert replaces in place and appends new keys", () => {
    const list = [key({ id: "qk-1" }), key({ id: "qk-2" })]
    const edited = upsertQuickKey(list, key({ id: "qk-1", label: "Renamed" }))
    expect(edited.map((k) => k.label)).toEqual(["Renamed", "Key qk-2"])
    expect(list[0]!.label).toBe("Key qk-1")
    expect(upsertQuickKey(list, key({ id: "qk-3" })).length).toBe(3)
  })

  test("upsert refuses to grow past the cap", () => {
    const full = Array.from({ length: MAX_QUICK_KEYS }, (_, i) => key({ id: `qk-${i + 1}` }))
    expect(upsertQuickKey(full, key({ id: "qk-extra" })).length).toBe(MAX_QUICK_KEYS)
  })

  test("remove drops only the named key", () => {
    const list = [key({ id: "qk-1" }), key({ id: "qk-2" })]
    expect(removeQuickKey(list, "qk-1").map((k) => k.id)).toEqual(["qk-2"])
    expect(removeQuickKey(list, "nope").length).toBe(2)
  })

  test("quickKeyForHotkey resolves a press, case-insensitively", () => {
    const list = [key({ id: "qk-1", hotkey: "d" }), key({ id: "qk-2" })]
    expect(quickKeyForHotkey(list, "D")?.id).toBe("qk-1")
    expect(quickKeyForHotkey(list, "z")).toBeNull()
    expect(quickKeyForHotkey(list, "")).toBeNull()
  })
})

// The chip lost its emoji in the field, so pin down every hop the icon takes:
// editor draft -> quickKeyFromDraft -> renderer cleanQuickKeys -> the Bun writer
// and back off disk. A ZWJ sequence (🧑‍💻 is 5 UTF-16 units, 👩‍👩‍👧‍👦 is 11) must
// arrive whole: a unit-based cap used to reject or bisect it.
describe("emoji round trip", () => {
  const EMOJI = [
    "🚢", // 2 units
    "⚙️", // variation selector
    "🧑‍💻", // ZWJ sequence
    "🇺🇸", // regional indicator pair
    "👩‍👩‍👧‍👦", // 11 units
    "👍🏿", // skin-tone modifier
  ]

  test.each(EMOJI)("%s survives draft -> clean -> desktop.json -> clean", (emoji) => {
    const draft = { emoji, label: "Ship it!", prompt: "ship it", hotkey: "d" }
    expect(validateQuickKey(draft)).toEqual({})

    const built = quickKeyFromDraft(draft, "qk-1")
    expect(built.emoji).toBe(emoji)

    const forWire = cleanQuickKeys([built])
    expect(forWire[0]!.emoji).toBe(emoji)

    const dir = mkdtempSync(join(tmpdir(), "chunky-quick-keys-"))
    try {
      const env = { CHUNKY_HOME: dir } as NodeJS.ProcessEnv
      mergeDesktopState({ quickKeys: forWire }, env)
      const fromDisk = readDesktopState(env).quickKeys
      expect(fromDisk?.[0]?.emoji).toBe(emoji)
      // And back through the renderer's guard on load.
      expect(cleanQuickKeys(fromDisk)[0]!.emoji).toBe(emoji)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("an icon of two emoji is kept; a third is dropped whole", () => {
    const built = quickKeyFromDraft(
      { emoji: "🧑‍💻🚢🎉", label: "X", prompt: "y", hotkey: "" },
      "qk-1",
    )
    expect(built.emoji).toBe("🧑‍💻🚢")
    expect(graphemeLength(built.emoji)).toBe(MAX_EMOJI_GRAPHEMES)
    expect(wellFormed(built.emoji)).toBe(true)
  })

  test("a label full of emoji is truncated between graphemes, not inside one", () => {
    const label = "👩‍👩‍👧‍👦".repeat(60)
    const built = quickKeyFromDraft({ emoji: "", label, prompt: "y", hotkey: "" }, "qk-1")
    expect(graphemeLength(built.label)).toBe(40)
    expect(wellFormed(built.label)).toBe(true)
    expect(built.label).toBe("👩‍👩‍👧‍👦".repeat(40))
  })

  test("a prompt is cut on a code-point boundary, never a lone surrogate", () => {
    const built = quickKeyFromDraft(
      { emoji: "", label: "X", prompt: "🚀".repeat(5000), hotkey: "" },
      "qk-1",
    )
    expect(wellFormed(built.prompt)).toBe(true)
    expect(Array.from(built.prompt).length).toBe(4000)
  })

  test("truncateGraphemes leaves short values untouched", () => {
    expect(truncateGraphemes("🧑‍💻", 2)).toBe("🧑‍💻")
    expect(truncateGraphemes("", 2)).toBe("")
  })
})

// The reported bug was a chip with no emoji on it, so assert the last hop too:
// a saved quick key actually reaches the DOM with its icon, and the chip has no
// permanent right-hand gutter for the hover pencil (which pushed the label off
// centre).
describe("the rendered chip", () => {
  function markup(entries: QuickKey[]): string {
    return renderToStaticMarkup(
      createElement(QuickKeys, {
        editorOpen: false,
        keys: entries,
        onChange: () => {},
        onEditorOpenChange: () => {},
        onRun: () => {},
      }),
    )
  }

  test("shows the icon, the label and the hotkey badge", () => {
    const html = markup([
      { id: "qk-1", emoji: "🧑‍💻", label: "Ship it!", prompt: "ship", hotkey: "d" },
    ])
    expect(html).toContain("🧑‍💻")
    expect(html).toContain("Ship it!")
    expect(html).toContain("⌘⇧D")
  })

  test("renders a key with no icon and no hotkey as just its label", () => {
    const html = markup([{ id: "qk-1", emoji: "", label: "Review", prompt: "review", hotkey: "" }])
    expect(html).toContain("Review")
    // No icon span and no badge — just the label, so nothing pads the pill oddly.
    expect(html).not.toContain("text-[13px] leading-none")
    expect(html).not.toContain("⌘⇧")
  })

  test("pads the chip evenly and keeps the pencil zero-width until hover/focus", () => {
    const html = markup([{ id: "qk-1", emoji: "🚢", label: "Ship it!", prompt: "ship", hotkey: "" }])
    // Symmetric padding on the send button: no lopsided pr-1 for the pencil.
    expect(html).toContain("rounded-full px-2.5")
    // The pencil's slot takes no space at rest and opens on hover or focus.
    expect(html).toContain("w-0 items-center overflow-hidden")
    expect(html).toContain("group-hover/qk:w-6")
    expect(html).toContain("group-focus-within/qk:w-6")
    // Still reachable, still labelled.
    expect(html).toContain('aria-label="Edit Ship it!"')
  })

  test("offers the + affordance with nothing configured", () => {
    const html = markup([])
    expect(html).toContain("Quick")
    expect(html).toContain('aria-label="Add a quick key"')
  })

  test("centres the row over the composer without losing the overflow scroller", () => {
    const html = markup([{ id: "qk-1", emoji: "", label: "Review", prompt: "review", hotkey: "" }])
    // Same column as the composer below.
    expect(html).toContain("mx-auto flex w-full max-w-5xl")
    // The scroller is still there …
    expect(html).toContain("overflow-x-auto")
    // … with the chips in one auto-margined group inside it, so a short row
    // centres and a full one collapses the margins and scrolls from the left.
    expect(html).toContain("mx-auto flex items-center gap-1.5 whitespace-nowrap")
  })
})

describe("EMOJI_CHOICES", () => {
  test("is a curated palette, not a dataset", () => {
    expect(EMOJI_CHOICES.length).toBeGreaterThanOrEqual(40)
    expect(EMOJI_CHOICES.length).toBeLessThanOrEqual(60)
    expect(new Set(EMOJI_CHOICES).size).toBe(EMOJI_CHOICES.length)
  })

  test("every choice is one grapheme, so a pick can never fail validation", () => {
    for (const emoji of EMOJI_CHOICES) {
      expect(graphemeLength(emoji)).toBe(1)
      // The picker only sets draft.emoji; the rest of the draft still governs.
      const draft = { ...emptyQuickKeyDraft(), emoji, label: "Ship it!", prompt: "ship" }
      expect(validateQuickKey(draft)).toEqual({})
      expect(quickKeyFromDraft(draft, "qk-1").emoji).toBe(emoji)
    }
  })
})

describe("cleanQuickKeys", () => {
  test("keeps well-formed entries and drops the rest", () => {
    expect(
      cleanQuickKeys([
        { id: "qk-1", emoji: "🚢", label: "Ship it!", prompt: "ship", hotkey: "D" },
        { id: "qk-2", label: "", prompt: "no label" },
        { id: "", label: "no id", prompt: "x" },
        { id: "qk-3", label: "no prompt", prompt: "  " },
        "nonsense",
        null,
      ]),
    ).toEqual([{ id: "qk-1", emoji: "🚢", label: "Ship it!", prompt: "ship", hotkey: "d" }])
  })

  test("makes ids unique and clears duplicate or reserved hotkeys", () => {
    const cleaned = cleanQuickKeys([
      { id: "qk-1", label: "A", prompt: "a", hotkey: "d" },
      { id: "qk-1", label: "Dup id", prompt: "b", hotkey: "e" },
      { id: "qk-2", label: "B", prompt: "b", hotkey: "d" },
      { id: "qk-3", label: "C", prompt: "c", hotkey: "k" },
    ])
    expect(cleaned.map((k) => [k.id, k.hotkey])).toEqual([
      ["qk-1", "d"],
      ["qk-2", ""],
      ["qk-3", ""],
    ])
  })

  test("bounds the list and the fields", () => {
    const many = Array.from({ length: 100 }, (_, i) => ({
      id: `qk-${i}`,
      label: "l".repeat(100),
      prompt: "p".repeat(9000),
    }))
    const cleaned = cleanQuickKeys(many)
    expect(cleaned.length).toBe(MAX_QUICK_KEYS)
    expect(cleaned[0]!.label.length).toBe(40)
    expect(cleaned[0]!.prompt.length).toBe(4000)
  })

  test("anything that is not a list is no quick keys at all", () => {
    expect(cleanQuickKeys(undefined)).toEqual([])
    expect(cleanQuickKeys({ id: "qk-1" })).toEqual([])
  })
})
