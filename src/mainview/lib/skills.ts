// Pure helpers behind the Settings → Skills section.
//
// The section's own state (what is expanded, what is in flight) lives in the
// component; everything here is a function of the server's repo rows, so the
// summary line, the optimistic toggle and the older-server check can be
// asserted without React or a server.
import type { SkillCatalogEntry, SkillModelBinding, SkillRepoStatus } from "@chunky/protocol"
import { EFFORTS, HttpError } from "./configApi"
import { relativeTime } from "./format"

export interface SkillsSummary {
  total: number
  enabled: number
  /** "3 skills · 2 enabled" — the collapsed repo header's one line. */
  label: string
}

/**
 * How many skills a repo ships and how many are on. A repo that has been added
 * but never cloned reports no skills rather than a misleading zero-of-zero.
 */
export function summarizeSkills(repo: Pick<SkillRepoStatus, "skills">): SkillsSummary {
  const skills = repo.skills ?? []
  const total = skills.length
  const enabled = skills.filter((s) => s.enabled).length
  if (total === 0) return { total: 0, enabled: 0, label: "no skills" }
  const noun = total === 1 ? "skill" : "skills"
  return { total, enabled, label: `${total} ${noun} · ${enabled} enabled` }
}

/**
 * "synced 3h ago", or an honest "never synced" for a repo the server has not
 * pulled yet. Reuses the sidebar's relative clock so both read the same.
 */
export function formatLastSync(lastSync: number | undefined, now = Date.now()): string {
  if (typeof lastSync !== "number" || !Number.isFinite(lastSync) || lastSync <= 0) {
    return "never synced"
  }
  return `synced ${relativeTime(lastSync, now)} ago`
}

/**
 * Flip one skill's enabled flag, returning a new list. This is the optimistic
 * update AND its own revert (calling it twice restores the original), so the
 * component never hand-rolls the rollback.
 */
export function setSkillEnabledIn(
  repos: readonly SkillRepoStatus[],
  repoId: string,
  skillName: string,
  enabled: boolean,
): SkillRepoStatus[] {
  return repos.map((repo) =>
    repo.id === repoId
      ? {
          ...repo,
          skills: repo.skills.map((skill) =>
            skill.name === skillName ? { ...skill, enabled } : skill,
          ),
        }
      : repo,
  )
}

/**
 * True when the server has no managed-skill-repo route at all (an older build),
 * as opposed to the route failing. Mirrors configApi's own rule: its catch-all
 * answers 404 with a plain-text body, while real routes answer with JSON.
 */
export function isUnsupportedSkillRepos(err: unknown): boolean {
  return err instanceof HttpError && (err.status === 404 || err.status === 501)
}

// ---- Model bindings -------------------------------------------------------

/** How the two lock strengths read on a badge. */
const LOCK_LABEL: Record<SkillModelBinding["lock"], string> = {
  prefer: "semi",
  require: "locked",
}

/**
 * The badge text for a bound skill: "→ codex/gpt-5.2 · semi", with the effort
 * folded in when the binding pins one. Returns "" for an unbound skill so the
 * caller can render nothing at all.
 */
export function formatBinding(binding: SkillModelBinding | undefined | null): string {
  if (!binding || !binding.provider || !binding.model) return ""
  const parts = [`→ ${binding.provider}/${binding.model}`]
  if (binding.effort) parts.push(binding.effort)
  parts.push(LOCK_LABEL[binding.lock] ?? String(binding.lock))
  return parts.join(" · ")
}

/** The `provider/model` key the shared ModelSelect speaks, or "" when unbound. */
export function bindingModelKey(binding: SkillModelBinding | undefined | null): string {
  if (!binding || !binding.provider || !binding.model) return ""
  return `${binding.provider}/${binding.model}`
}

export type BindingDraft = {
  /** "provider/model", as produced by ModelSelect or typed by hand. */
  modelKey: string
  effort: string
  lock: SkillModelBinding["lock"]
}

export type BindingValidation =
  | { ok: true; binding: SkillModelBinding }
  | { ok: false; error: string }

/**
 * Turn an editor draft into a binding the server will accept. Provider AND
 * model are required (a bare provider cannot pin anything), and an effort is
 * only sent when it is one the server knows.
 */
export function parseBindingDraft(draft: BindingDraft): BindingValidation {
  const key = (draft.modelKey ?? "").trim()
  if (!key) return { ok: false, error: "Pick a provider and model first." }
  const slash = key.indexOf("/")
  if (slash <= 0 || slash === key.length - 1) {
    return { ok: false, error: "Use the form provider/model, e.g. codex/gpt-5.2." }
  }
  const provider = key.slice(0, slash).trim()
  const model = key.slice(slash + 1).trim()
  if (!provider || !model) {
    return { ok: false, error: "Use the form provider/model, e.g. codex/gpt-5.2." }
  }
  const effort = (draft.effort ?? "").trim()
  if (effort && !(EFFORTS as readonly string[]).includes(effort)) {
    return { ok: false, error: `Unknown effort "${effort}".` }
  }
  const lock = draft.lock === "require" ? "require" : "prefer"
  return { ok: true, binding: { provider, model, lock, ...(effort ? { effort } : {}) } }
}

/**
 * Which managed repo ships a skill, by name. Binding a skill goes through its
 * repo, so this is what turns a bare skill name (as the PR review lenses are
 * configured) into an addressable bind request. null when no managed repo
 * ships it — a user/project skill, which the server resolves by name alone.
 */
export function findSkillRepoId(
  repos: readonly SkillRepoStatus[],
  skillName: string,
): string | null {
  for (const repo of repos) {
    if (repo.skills.some((skill) => skill.name === skillName)) return repo.id
  }
  return null
}

/**
 * A skill's current binding, wherever it is known from. Managed repos win over
 * the flat catalog: both describe the same skill, but the repo row is the one
 * an optimistic write updates.
 */
export function findSkillBinding(
  repos: readonly SkillRepoStatus[],
  catalog: readonly SkillCatalogEntry[],
  skillName: string,
): SkillModelBinding | undefined {
  for (const repo of repos) {
    const hit = repo.skills.find((skill) => skill.name === skillName)
    if (hit) return hit.binding
  }
  return catalog.find((entry) => entry.name === skillName)?.binding
}

/**
 * The catalog-side twin of setSkillBindingIn, so an optimistic write repaints
 * whichever of the two sources the row happened to read from.
 */
export function setCatalogBindingIn(
  catalog: readonly SkillCatalogEntry[],
  skillName: string,
  binding: SkillModelBinding | null,
): SkillCatalogEntry[] {
  return catalog.map((entry) => {
    if (entry.name !== skillName) return entry
    if (!binding) {
      const { binding: _dropped, ...rest } = entry
      return rest
    }
    return { ...entry, binding }
  })
}

/**
 * Set or clear one skill's binding, returning a new list. Like
 * setSkillEnabledIn, this doubles as its own revert: keep the previous binding
 * and pass it back to undo an optimistic write.
 */
export function setSkillBindingIn(
  repos: readonly SkillRepoStatus[],
  repoId: string,
  skillName: string,
  binding: SkillModelBinding | null,
): SkillRepoStatus[] {
  return repos.map((repo) =>
    repo.id === repoId
      ? {
          ...repo,
          skills: repo.skills.map((skill) => {
            if (skill.name !== skillName) return skill
            if (!binding) {
              const { binding: _dropped, ...rest } = skill
              return rest
            }
            return { ...skill, binding }
          }),
        }
      : repo,
  )
}
