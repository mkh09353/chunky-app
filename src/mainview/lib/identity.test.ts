import { expect, test } from "bun:test"
import {
  avatarInitial,
  FALLBACK_DISPLAY_NAME,
  FALLBACK_INITIAL,
  pickDisplayName,
  resolveDisplayName,
} from "./identity"

test("a real git user.name is shown as-is", () => {
  expect(resolveDisplayName("Ada Lovelace")).toBe("Ada Lovelace")
  expect(avatarInitial("Ada Lovelace")).toBe("A")
})

test("whitespace is trimmed and collapsed", () => {
  expect(resolveDisplayName("  Ada   Lovelace \n")).toBe("Ada Lovelace")
  expect(avatarInitial("   ada")).toBe("A")
})

test("empty, whitespace-only and missing values fall back to Chunky", () => {
  expect(resolveDisplayName("")).toBe(FALLBACK_DISPLAY_NAME)
  expect(resolveDisplayName("   \t \n ")).toBe(FALLBACK_DISPLAY_NAME)
  expect(resolveDisplayName(undefined)).toBe(FALLBACK_DISPLAY_NAME)
  expect(resolveDisplayName(null)).toBe(FALLBACK_DISPLAY_NAME)
  // Not a string at all (a malformed RPC answer) must not throw.
  expect(resolveDisplayName(42 as unknown as string)).toBe(FALLBACK_DISPLAY_NAME)
})

test("the fallback name derives the fallback initial", () => {
  expect(avatarInitial("")).toBe(FALLBACK_INITIAL)
  expect(avatarInitial(undefined)).toBe(FALLBACK_INITIAL)
  expect(avatarInitial("   ")).toBe(FALLBACK_INITIAL)
  expect(avatarInitial(FALLBACK_DISPLAY_NAME)).toBe(FALLBACK_INITIAL)
})

test("the initial is one uppercase character, never the whole name", () => {
  expect(avatarInitial("max")).toBe("M")
  expect(avatarInitial("ada lovelace")).toBe("A")
  expect(avatarInitial("é")).toBe("É")
})

test("the initial is grapheme-safe: an emoji is never sliced in half", () => {
  // 🧑‍💻 is a ZWJ sequence (five UTF-16 units); [0] would paint a broken glyph.
  expect(avatarInitial("🧑‍💻 dev")).toBe("🧑‍💻")
  expect(avatarInitial("👩‍👩‍👧‍👦")).toBe("👩‍👩‍👧‍👦")
  // A combining sequence stays whole too.
  expect(avatarInitial("éva")).toBe("É".toLocaleUpperCase())
  for (const name of ["🧑‍💻 dev", "👩‍👩‍👧‍👦", "éva"]) {
    expect(avatarInitial(name)).not.toContain("�")
  }
})

test("a single character name still yields an initial", () => {
  expect(resolveDisplayName("q")).toBe("q")
  expect(avatarInitial("q")).toBe("Q")
})

// ---- Precedence: override > git user.name > "Chunky" ----------------------

test("a configured override beats the git name", () => {
  expect(pickDisplayName("Zoë", "Ada Lovelace")).toBe("Zoë")
  expect(resolveDisplayName(pickDisplayName("Zoë", "Ada Lovelace"))).toBe("Zoë")
  expect(avatarInitial(pickDisplayName("Zoë", "Ada Lovelace"))).toBe("Z")
})

test("no override falls through to the git name", () => {
  expect(pickDisplayName("", "Ada Lovelace")).toBe("Ada Lovelace")
  expect(pickDisplayName(undefined, "Ada Lovelace")).toBe("Ada Lovelace")
  expect(pickDisplayName(null, "Ada Lovelace")).toBe("Ada Lovelace")
  expect(avatarInitial(pickDisplayName("", "Ada Lovelace"))).toBe("A")
})

test("a whitespace-only override is not an override", () => {
  // Clearing the Settings field must restore the git name, not pin a blank.
  expect(pickDisplayName("   ", "Ada Lovelace")).toBe("Ada Lovelace")
  expect(pickDisplayName("\t\n ", "Ada Lovelace")).toBe("Ada Lovelace")
})

test("an override is trimmed before it wins", () => {
  expect(pickDisplayName("  Zoë  ", "Ada Lovelace")).toBe("Zoë")
})

test("with neither source the neutral fallback takes over", () => {
  expect(pickDisplayName("", "")).toBe("")
  expect(pickDisplayName(undefined, undefined)).toBe("")
  expect(resolveDisplayName(pickDisplayName("", ""))).toBe(FALLBACK_DISPLAY_NAME)
  expect(avatarInitial(pickDisplayName("", ""))).toBe(FALLBACK_INITIAL)
})

test("a blank git name with no override still falls back", () => {
  expect(pickDisplayName("", "   ")).toBe("")
  expect(resolveDisplayName(pickDisplayName("", "   "))).toBe(FALLBACK_DISPLAY_NAME)
})
