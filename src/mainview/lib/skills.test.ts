// The Skills section's pure rules: the collapsed summary line, the last-sync
// clock, the optimistic toggle, and "this server is too old". Run with:
//   bun test src/mainview/lib/skills.test.ts
import { describe, expect, test } from "bun:test"
import type {
  ManagedSkill,
  SkillCatalogEntry,
  SkillModelBinding,
  SkillRepoStatus,
} from "@chunky/protocol"
import { HttpError } from "./configApi"
import {
  bindingModelKey,
  findSkillBinding,
  findSkillRepoId,
  formatBinding,
  formatLastSync,
  isUnsupportedSkillRepos,
  parseBindingDraft,
  setCatalogBindingIn,
  setSkillBindingIn,
  setSkillEnabledIn,
  summarizeSkills,
} from "./skills"

const NOW = Date.parse("2026-03-10T12:00:00.000Z")
const HOUR = 3_600_000

const skill = (name: string, enabled: boolean, binding?: SkillModelBinding): ManagedSkill => ({
  name,
  description: `${name} does something`,
  enabled,
  ...(binding ? { binding } : {}),
})

const BOUND: SkillModelBinding = { provider: "codex", model: "gpt-5.2", lock: "prefer" }

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

describe("formatBinding", () => {
  test("names the model and how hard the lock is", () => {
    expect(formatBinding({ provider: "codex", model: "gpt-5.2", lock: "prefer" })).toBe(
      "→ codex/gpt-5.2 · semi",
    )
    expect(formatBinding({ provider: "codex", model: "gpt-5.2", lock: "require" })).toBe(
      "→ codex/gpt-5.2 · locked",
    )
  })

  test("folds in a pinned effort", () => {
    expect(
      formatBinding({ provider: "zen", model: "claude-4", effort: "high", lock: "require" }),
    ).toBe("→ zen/claude-4 · high · locked")
  })

  test("an unbound or half-formed binding renders nothing", () => {
    expect(formatBinding(undefined)).toBe("")
    expect(formatBinding(null)).toBe("")
    expect(formatBinding({ provider: "codex", model: "", lock: "prefer" })).toBe("")
  })
})

describe("bindingModelKey", () => {
  test("is the provider/model key the picker speaks", () => {
    expect(bindingModelKey(BOUND)).toBe("codex/gpt-5.2")
    expect(bindingModelKey(undefined)).toBe("")
  })
})

describe("parseBindingDraft", () => {
  test("splits provider from model and defaults the lock to prefer", () => {
    const result = parseBindingDraft({ modelKey: "codex/gpt-5.2", effort: "", lock: "prefer" })
    expect(result).toEqual({
      ok: true,
      binding: { provider: "codex", model: "gpt-5.2", lock: "prefer" },
    })
  })

  test("keeps a model id containing slashes intact", () => {
    const result = parseBindingDraft({
      modelKey: "openrouter/meta/llama-3.1",
      effort: "",
      lock: "require",
    })
    expect(result).toEqual({
      ok: true,
      binding: { provider: "openrouter", model: "meta/llama-3.1", lock: "require" },
    })
  })

  test("carries a known effort and omits an empty one", () => {
    const withEffort = parseBindingDraft({
      modelKey: "codex/gpt-5.2",
      effort: "xhigh",
      lock: "prefer",
    })
    expect(withEffort.ok && withEffort.binding.effort).toBe("xhigh")
    const without = parseBindingDraft({ modelKey: "codex/gpt-5.2", effort: "", lock: "prefer" })
    expect(without.ok && "effort" in without.binding).toBe(false)
  })

  test("provider and model are both required", () => {
    expect(parseBindingDraft({ modelKey: "", effort: "", lock: "prefer" }).ok).toBe(false)
    expect(parseBindingDraft({ modelKey: "codex", effort: "", lock: "prefer" }).ok).toBe(false)
    expect(parseBindingDraft({ modelKey: "codex/", effort: "", lock: "prefer" }).ok).toBe(false)
    expect(parseBindingDraft({ modelKey: "/gpt-5.2", effort: "", lock: "prefer" }).ok).toBe(false)
  })

  test("an effort the server does not know is refused by name", () => {
    const result = parseBindingDraft({ modelKey: "codex/gpt-5.2", effort: "turbo", lock: "prefer" })
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.error).toContain("turbo")
  })

  test("whitespace around a hand-typed key is trimmed", () => {
    const result = parseBindingDraft({ modelKey: "  codex / gpt-5.2 ", effort: "", lock: "prefer" })
    expect(result).toEqual({
      ok: true,
      binding: { provider: "codex", model: "gpt-5.2", lock: "prefer" },
    })
  })
})

describe("setSkillBindingIn", () => {
  const repos = [
    repo({ id: "one", skills: [skill("alpha", true), skill("beta", true, BOUND)] }),
    repo({ id: "two", skills: [skill("alpha", true)] }),
  ]

  test("binds only the named skill in the named repo", () => {
    const next = setSkillBindingIn(repos, "one", "alpha", BOUND)
    expect(next[0]!.skills[0]!.binding).toEqual(BOUND)
    expect(next[1]!.skills[0]!.binding).toBeUndefined()
  })

  test("null removes the binding entirely", () => {
    const next = setSkillBindingIn(repos, "one", "beta", null)
    expect(next[0]!.skills[1]!.binding).toBeUndefined()
    expect("binding" in next[0]!.skills[1]!).toBe(false)
  })

  test("the previous value passed back is the revert", () => {
    const optimistic = setSkillBindingIn(repos, "one", "beta", null)
    const reverted = setSkillBindingIn(optimistic, "one", "beta", BOUND)
    expect(reverted[0]!.skills[1]!.binding).toEqual(BOUND)
  })

  test("does not mutate the input", () => {
    setSkillBindingIn(repos, "one", "alpha", BOUND)
    expect(repos[0]!.skills[0]!.binding).toBeUndefined()
  })

  test("an unknown repo or skill changes nothing", () => {
    expect(setSkillBindingIn(repos, "nope", "alpha", BOUND)).toEqual(repos as SkillRepoStatus[])
    expect(setSkillBindingIn(repos, "one", "nope", BOUND)).toEqual(repos as SkillRepoStatus[])
  })
})

const catalogEntry = (
  name: string,
  binding?: SkillModelBinding,
): SkillCatalogEntry => ({
  name,
  description: `${name} from the catalog`,
  source: "user",
  sourceLabel: "User",
  path: `/skills/${name}`,
  enabled: true,
  ...(binding ? { binding } : {}),
})

describe("findSkillRepoId", () => {
  const repos = [
    repo({ id: "one", skills: [skill("alpha", true)] }),
    repo({ id: "two", skills: [skill("chunky-code-review", true)] }),
  ]

  test("names the repo shipping the skill", () => {
    expect(findSkillRepoId(repos, "chunky-code-review")).toBe("two")
    expect(findSkillRepoId(repos, "alpha")).toBe("one")
  })

  test("a skill no managed repo ships has no repo id", () => {
    expect(findSkillRepoId(repos, "not-here")).toBeNull()
    expect(findSkillRepoId([], "alpha")).toBeNull()
  })
})

describe("findSkillBinding", () => {
  test("reads a binding off the managed repo row", () => {
    const repos = [repo({ id: "one", skills: [skill("alpha", true, BOUND)] })]
    expect(findSkillBinding(repos, [], "alpha")).toEqual(BOUND)
  })

  test("falls back to the flat catalog", () => {
    expect(findSkillBinding([], [catalogEntry("alpha", BOUND)], "alpha")).toEqual(BOUND)
  })

  test("the managed repo wins when both know the skill", () => {
    const other: SkillModelBinding = { provider: "zen", model: "claude-4", lock: "require" }
    const repos = [repo({ id: "one", skills: [skill("alpha", true, BOUND)] })]
    expect(findSkillBinding(repos, [catalogEntry("alpha", other)], "alpha")).toEqual(BOUND)
  })

  test("an unbound or unknown skill has no binding", () => {
    const repos = [repo({ id: "one", skills: [skill("alpha", true)] })]
    expect(findSkillBinding(repos, [catalogEntry("beta")], "alpha")).toBeUndefined()
    expect(findSkillBinding(repos, [], "nope")).toBeUndefined()
  })
})

describe("setCatalogBindingIn", () => {
  const catalog = [catalogEntry("alpha"), catalogEntry("beta", BOUND)]

  test("binds only the named entry", () => {
    const next = setCatalogBindingIn(catalog, "alpha", BOUND)
    expect(next[0]!.binding).toEqual(BOUND)
    expect(next[1]!.binding).toEqual(BOUND)
  })

  test("null removes the binding entirely", () => {
    const next = setCatalogBindingIn(catalog, "beta", null)
    expect("binding" in next[1]!).toBe(false)
  })

  test("does not mutate the input, and ignores unknown names", () => {
    setCatalogBindingIn(catalog, "alpha", BOUND)
    expect(catalog[0]!.binding).toBeUndefined()
    expect(setCatalogBindingIn(catalog, "nope", BOUND)).toEqual(catalog as SkillCatalogEntry[])
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
