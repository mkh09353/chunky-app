// How the icon picker's search ranks and filters. Run with:
//   bun test src/mainview/lib/emojiSearch.test.ts
import { describe, expect, test } from "bun:test"
import { EMOJI_CHOICES } from "./quickKeys"
import { DEFAULT_EMOJIS, EMOJIS, searchEmoji } from "./emojiSearch"

/** Index of an emoji in a result list, or -1. */
const posOf = (results: { char: string }[], char: string) =>
  results.findIndex((entry) => entry.char === char)

describe("the dataset", () => {
  test("covers the common set several times over", () => {
    expect(EMOJIS.length).toBeGreaterThanOrEqual(400)
  })

  test("has no duplicate characters", () => {
    const chars = EMOJIS.map((entry) => entry.char)
    expect(new Set(chars).size).toBe(chars.length)
  })

  test("every entry carries a name", () => {
    expect(EMOJIS.every((entry) => entry.name.trim().length > 0)).toBe(true)
  })

  test("names and keywords are lower case, so matching can be", () => {
    for (const entry of EMOJIS) {
      expect(entry.name).toBe(entry.name.toLowerCase())
      for (const keyword of entry.keywords) expect(keyword).toBe(keyword.toLowerCase())
    }
  })
})

describe("the default view", () => {
  test("is exactly the curated grid, in order", () => {
    expect(DEFAULT_EMOJIS.map((entry) => entry.char)).toEqual([...EMOJI_CHOICES])
  })

  test("an empty query returns it untouched", () => {
    expect(searchEmoji("").map((e) => e.char)).toEqual(DEFAULT_EMOJIS.map((e) => e.char))
  })

  test("whitespace is still an empty query", () => {
    expect(searchEmoji("   ").map((e) => e.char)).toEqual(searchEmoji("").map((e) => e.char))
  })

  test("every curated emoji is searchable by name", () => {
    // A default-grid emoji with no dataset entry would be unfindable the moment
    // the user typed anything.
    const named = DEFAULT_EMOJIS.filter((entry) => entry.name !== entry.char)
    expect(named).toHaveLength(DEFAULT_EMOJIS.length)
  })
})

describe("matching", () => {
  test("finds by name", () => {
    expect(searchEmoji("rocket")[0]!.char).toBe("🚀")
    expect(searchEmoji("bug")[0]!.char).toBe("🐛")
  })

  test("finds by keyword, not just name", () => {
    // "lgtm" is only a keyword of thumbs up; its name is "thumbs up".
    expect(searchEmoji("lgtm")[0]!.char).toBe("👍")
    // "docker" only appears as a keyword of the spouting whale.
    expect(searchEmoji("docker")[0]!.char).toBe("🐳")
  })

  test("is case insensitive", () => {
    expect(searchEmoji("ROCKET")[0]!.char).toBe("🚀")
    expect(searchEmoji("RoCkEt")[0]!.char).toBe("🚀")
  })

  test("trims the query", () => {
    expect(searchEmoji("  rocket  ")[0]!.char).toBe("🚀")
  })

  test("no match is an empty list", () => {
    expect(searchEmoji("zzzzzznotanemoji")).toEqual([])
  })
})

describe("ranking", () => {
  test("a prefix match beats a substring match", () => {
    const results = searchEmoji("book")
    // "book", "books", "bookmark" start with it; "notebook" merely contains it.
    expect(posOf(results, "📖")).toBeLessThan(posOf(results, "📓"))
    expect(posOf(results, "📚")).toBeLessThan(posOf(results, "📓"))
  })

  test("an exact match beats a prefix match", () => {
    // The fox owns the keyword "firefox", which starts with "fire".
    const fire = searchEmoji("fire")
    expect(fire[0]!.char).toBe("🔥")
    expect(posOf(fire, "🔥")).toBeLessThan(posOf(fire, "🦊"))

    // The clipboard owns "checklist", which starts with "check".
    const check = searchEmoji("check")
    expect(posOf(check, "✅")).toBeLessThan(posOf(check, "📋"))
  })

  test("the plain word lands on the plain emoji", () => {
    expect(searchEmoji("star")[0]!.char).toBe("⭐")
    expect(searchEmoji("cat")[0]!.char).toBe("🐈")
    expect(searchEmoji("gear")[0]!.char).toBe("⚙️")
    expect(searchEmoji("search")[0]!.char).toBe("🔍")
  })

  test("results are stable across repeated calls", () => {
    const once = searchEmoji("check").map((e) => e.char)
    const twice = searchEmoji("check").map((e) => e.char)
    expect(twice).toEqual(once)
  })
})

describe("limit", () => {
  test("caps the result count", () => {
    expect(searchEmoji("a", 5)).toHaveLength(5)
    expect(searchEmoji("a", 1)).toHaveLength(1)
  })

  test("defaults to 48", () => {
    // "a" matches far more than 48 entries across names and keywords.
    expect(searchEmoji("a").length).toBe(48)
  })

  test("never truncates the curated grid, whatever the limit", () => {
    // The grid is longer than the default limit; capping it would silently
    // drop icons the picker has always shown.
    expect(EMOJI_CHOICES.length).toBeGreaterThan(48)
    expect(searchEmoji("")).toHaveLength(EMOJI_CHOICES.length)
    expect(searchEmoji("", 4)).toHaveLength(EMOJI_CHOICES.length)
  })

  test("a nonsense limit returns nothing rather than everything", () => {
    expect(searchEmoji("rocket", 0)).toEqual([])
    expect(searchEmoji("rocket", -1)).toEqual([])
  })

  test("asking for more than exists is fine", () => {
    expect(searchEmoji("rocket", 500).length).toBeGreaterThan(0)
  })
})
