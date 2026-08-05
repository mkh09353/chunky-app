import { expect, test } from "bun:test"
import { describeSetupStage, parseSetupStage } from "./setupStatus"

test("parses well-formed stage payloads and clamps their numbers", () => {
  expect(parseSetupStage({ kind: "checking" })).toEqual({ kind: "checking" })
  expect(parseSetupStage({ kind: "downloading", version: "1.2.3", percent: 33.6 })).toEqual({
    kind: "downloading",
    version: "1.2.3",
    percent: 34,
  })
  expect(parseSetupStage({ kind: "downloading", percent: 250 })?.percent).toBe(100)
  expect(parseSetupStage({ kind: "downloading", percent: -5 })?.percent).toBe(0)
  expect(parseSetupStage({ kind: "installing", attempt: 2 })).toEqual({ kind: "installing", attempt: 2 })
})

test("ignores payloads that are not a known stage", () => {
  expect(parseSetupStage(null)).toBeNull()
  expect(parseSetupStage("downloading")).toBeNull()
  expect(parseSetupStage({})).toBeNull()
  expect(parseSetupStage({ kind: "mining-bitcoin" })).toBeNull()
  // Junk fields are dropped rather than trusted.
  expect(parseSetupStage({ kind: "downloading", percent: "half", version: 7 })).toEqual({
    kind: "downloading",
  })
})

test("describes each stage as one human-readable line", () => {
  expect(describeSetupStage({ kind: "checking" })).toBe("Checking for the latest Chunky runtime…")
  expect(describeSetupStage({ kind: "downloading", percent: 34 })).toBe(
    "Downloading Chunky runtime (34%)…",
  )
  expect(describeSetupStage({ kind: "downloading", percent: 0 })).toBe(
    "Downloading Chunky runtime (0%)…",
  )
  expect(describeSetupStage({ kind: "downloading" })).toBe("Downloading Chunky runtime…")
  expect(describeSetupStage({ kind: "extracting" })).toBe("Extracting Chunky runtime…")
  expect(describeSetupStage({ kind: "installing" })).toBe("Installing dependencies…")
  expect(describeSetupStage({ kind: "installing", attempt: 1 })).toBe("Installing dependencies…")
  expect(describeSetupStage({ kind: "installing", attempt: 2 })).toBe(
    "Installing dependencies (retrying)…",
  )
  expect(describeSetupStage({ kind: "verifying" })).toBe("Verifying Chunky runtime…")
  expect(describeSetupStage({ kind: "starting" })).toBe("Starting Chunky server…")
})

test("says nothing when no stage has been reported (warm launch)", () => {
  // The connecting banner falls back to its usual text, so a normal launch
  // never flashes installer wording.
  expect(describeSetupStage(null)).toBeNull()
})
