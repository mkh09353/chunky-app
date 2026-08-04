// Pure helpers behind the Settings → Skills section.
//
// The section's own state (what is expanded, what is in flight) lives in the
// component; everything here is a function of the server's repo rows, so the
// summary line, the optimistic toggle and the older-server check can be
// asserted without React or a server.
import type { SkillRepoStatus } from "@chunky/protocol"
import { HttpError } from "./configApi"
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
