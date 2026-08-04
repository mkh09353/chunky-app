// The Skills section's pure rules: the collapsed summary line, the last-sync
// clock, the optimistic toggle, and "this server is too old". Run with:
//   bun test src/mainview/lib/skills.test.ts
import { describe, expect, test } from "bun:test"
import type { ManagedSkill, SkillRepoStatus } from "@chunky/protocol"
import { HttpError } from "./configApi"
import {
  formatLastSync,
  isUnsupportedSkillRepos,
  setSkillEnabledIn,
  summarizeSkills,
} from "./skills"

const NOW = Date.parse("2026-03-10T12:00:00.000Z")
const HOUR = 3_600_000

const skill = (name: string, enabled: boolean): ManagedSkill => ({
  name,
  description: `${name} does something`,
  enabled,
})

function repo(over: Partial<SkillRepoStatus> = {}): SkillRepoStatus {
  return {
    id: over.id ?? "acme-skills",
    url: over.url ?? "https://github.com/acme/skills",
    addedAt: over.addedAt ?? NOW - 10 * HOUR,
    path: over.path ?? "/state/skills/acme-skills",
    present: over.present ?? true,
    skills: over.skills ?? [],
    ...(over.branch ? { branch: over.branch } : {}),
    ...(over.subdir ? { subdir: over.subdir } : {}),
    ...(over.lastSync ? { lastSync: over.lastSync } : {}),
    ...(over.lastError ? { lastError: over.lastError } : {}),
  }
}

describe("summarizeSkills", () => {
  test("counts the skills and how many are on", () => {
    const summary = summarizeSkills(
      repo({ skills: [skill("a", true), skill("b", false), skill("c", true)] }),
    )
    expect(summary).toEqual({ total: 3, enabled: 2, label: "3 skills · 2 enabled" })
  })

  test("one skill is not pluralized", () => {
    expect(summarizeSkills(repo({ skills: [skill("solo", true)] })).label).toBe(
      "1 skill · 1 enabled",
    )
  })

  test("all off still names the total", () => {
    expect(summarizeSkills(repo({ skills: [skill("a", false), skill("b", false)] })).label).toBe(
      "2 skills · 0 enabled",
    )
  })

  test("a repo with nothing in it says so instead of counting zero", () => {
    expect(summarizeSkills(repo({ skills: [] }))).toEqual({
      total: 0,
      enabled: 0,
      label: "no skills",
    })
  })
})

describe("formatLastSync", () => {
  test("reads as a sentence on the card", () => {
    expect(formatLastSync(NOW - 3 * HOUR, NOW)).toBe("synced 3h ago")
    expect(formatLastSync(NOW - 2 * 24 * HOUR, NOW)).toBe("synced 2d ago")
  })

  test("a repo the server has never pulled is honest about it", () => {
    expect(formatLastSync(undefined, NOW)).toBe("never synced")
    expect(formatLastSync(0, NOW)).toBe("never synced")
  })
})

describe("setSkillEnabledIn", () => {
  const repos = [
    repo({ id: "one", skills: [skill("alpha", false), skill("beta", true)] }),
    repo({ id: "two", skills: [skill("alpha", true)] }),
  ]

  test("flips only the named skill in the named repo", () => {
    const next = setSkillEnabledIn(repos, "one", "alpha", true)
    expect(next[0]!.skills.map((s) => s.enabled)).toEqual([true, true])
    // The same-named skill in the other repo is untouched.
    expect(next[1]!.skills[0]!.enabled).toBe(true)
  })

  test("applying it twice is the revert", () => {
    const optimistic = setSkillEnabledIn(repos, "one", "beta", false)
    expect(optimistic[0]!.skills[1]!.enabled).toBe(false)
    const reverted = setSkillEnabledIn(optimistic, "one", "beta", true)
    expect(reverted[0]!.skills[1]!.enabled).toBe(true)
  })

  test("does not mutate the input", () => {
    setSkillEnabledIn(repos, "one", "alpha", true)
    expect(repos[0]!.skills[0]!.enabled).toBe(false)
  })

  test("an unknown repo or skill changes nothing", () => {
    expect(setSkillEnabledIn(repos, "nope", "alpha", true)).toEqual(repos as SkillRepoStatus[])
    expect(setSkillEnabledIn(repos, "one", "nope", true)).toEqual(repos as SkillRepoStatus[])
  })
})

describe("isUnsupportedSkillRepos", () => {
  test("a missing route is the older-server case", () => {
    expect(isUnsupportedSkillRepos(new HttpError("not found", 404, null))).toBe(true)
    expect(isUnsupportedSkillRepos(new HttpError("not implemented", 501, null))).toBe(true)
  })

  test("a real failure is not", () => {
    expect(isUnsupportedSkillRepos(new HttpError("boom", 500, { error: "boom" }))).toBe(false)
    expect(isUnsupportedSkillRepos(new Error("network down"))).toBe(false)
    expect(isUnsupportedSkillRepos(null)).toBe(false)
  })
})
