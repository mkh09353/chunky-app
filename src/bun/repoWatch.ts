// Competitor watch: what a comparable open-source product shipped since we last
// looked.
//
// Lives in the Bun process because it talks to GitHub — the renderer never
// makes these calls and never sees the token. Everything here takes an injected
// `fetch`, so the whole delta computation is unit-testable without touching the
// network (repoWatch.test.ts).
//
// A watch produces ARTIFACTS, not insights: the formatted delta is inserted as a
// source artifact and then flows through the ordinary artifact -> insight
// pipeline that Linear and transcripts already use. There is no parallel
// synthesis path.

const API = "https://api.github.com"
const UA = "chunky-app-competitor-watch"

/** Kept small on purpose: six calls per watch already strains the 60/hour
 *  unauthenticated budget, so each list is a single page. */
const PER_PAGE = 30
const MAX_RELEASES = 10
const MAX_PULLS = 25
const MAX_COMMITS = 10
const MAX_SEEN_TAGS = 60
const MAX_BODY_CHARS = 1200

/** Files whose changes are worth reading even without a release. GitHub's
 *  commits API takes an exact path (no globs), so this is a short explicit list. */
const CHANGELOG_PATHS = ["CHANGELOG.md", "README.md"]

export type WatchRef = { owner: string; name: string }

export type WatchRelease = { tag: string; name: string; publishedAt: number; url: string; body: string }
export type WatchPull = { number: number; title: string; mergedAt: number; url: string; author: string }
export type WatchCommit = { sha: string; message: string; committedAt: number; url: string; path: string }

export type WatchDelta = {
  ref: WatchRef
  since: number | null
  until: number
  description: string
  defaultBranch: string
  releases: WatchRelease[]
  /** Tags that were not present at the previous check (undated, so diffed). */
  newTags: string[]
  pulls: WatchPull[]
  commits: WatchCommit[]
}

/**
 * One check's outcome.
 *
 * `skipped` is a first-class result, not an error: a rate-limited or offline
 * check must leave the watch (and the scheduler) exactly as healthy as it found
 * them.
 */
export type WatchCheckOutcome =
  | { status: "ok"; delta: WatchDelta; changed: boolean; tags: string[] }
  | { status: "skipped"; note: string; retryAt?: number }
  | { status: "error"; note: string }

export type FetchDeps = {
  fetch: typeof fetch
  /** Optional GITHUB_TOKEN. Never logged, never returned in a note. */
  token?: string | null
  now?: () => number
}

/** "owner/name", a full GitHub URL, or "owner name" — all land in the same place. */
export function parseRepoRef(input: unknown): WatchRef | null {
  if (typeof input !== "string") return null
  const trimmed = input.trim().replace(/^https?:\/\/(www\.)?github\.com\//i, "").replace(/\.git$/i, "")
  const match = /^([A-Za-z0-9][A-Za-z0-9-_.]*)[/\s]+([A-Za-z0-9][A-Za-z0-9-_.]*)$/.exec(trimmed)
  if (!match) return null
  const owner = match[1]!
  const name = match[2]!.replace(/\/+$/, "")
  if (!owner || !name || owner.length > 100 || name.length > 100) return null
  return { owner, name }
}

export function repoLabel(ref: WatchRef): string {
  return `${ref.owner}/${ref.name}`
}

function time(value: unknown): number | null {
  if (typeof value !== "string") return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function str(value: unknown, max = 4000): string {
  return typeof value === "string" ? value.slice(0, max) : ""
}

type GetResult =
  | { ok: true; body: unknown }
  | { ok: false; rateLimited: boolean; missing: boolean; note: string; retryAt?: number }

/**
 * One GitHub GET.
 *
 * Never throws and never surfaces anything token-shaped: a caller only learns
 * "worked", "rate limited (retry at)", "missing", or a short reason.
 */
async function get(url: string, deps: FetchDeps): Promise<GetResult> {
  let response: Response
  try {
    response = await deps.fetch(url, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": UA,
        "X-GitHub-Api-Version": "2022-11-28",
        ...(deps.token ? { Authorization: `Bearer ${deps.token}` } : {}),
      },
    })
  } catch {
    return { ok: false, rateLimited: false, missing: false, note: "GitHub is unreachable" }
  }

  if (response.ok) {
    try {
      return { ok: true, body: await response.json() }
    } catch {
      return { ok: false, rateLimited: false, missing: false, note: "GitHub returned an unreadable response" }
    }
  }

  const remaining = response.headers.get("x-ratelimit-remaining")
  const resetHeader = Number(response.headers.get("x-ratelimit-reset"))
  const retryAt = Number.isFinite(resetHeader) && resetHeader > 0 ? resetHeader * 1000 : undefined
  if (response.status === 429 || (response.status === 403 && (remaining === "0" || !remaining))) {
    return {
      ok: false,
      rateLimited: true,
      missing: false,
      note: "GitHub rate limit reached",
      ...(retryAt ? { retryAt } : {}),
    }
  }
  if (response.status === 404) {
    return { ok: false, rateLimited: false, missing: true, note: "Repository not found (or private)" }
  }
  return { ok: false, rateLimited: false, missing: false, note: `GitHub request failed (${response.status})` }
}

function list(body: unknown): Record<string, unknown>[] {
  return Array.isArray(body)
    ? body.filter((row): row is Record<string, unknown> => !!row && typeof row === "object" && !Array.isArray(row))
    : []
}

/**
 * Everything `owner/name` shipped since `since`.
 *
 * Dated signals (releases, merged PRs, changelog commits) are filtered by their
 * own timestamps. Tags carry no date on the list endpoint, so they are diffed
 * against the tags seen at the previous check instead of being re-reported
 * forever.
 */
export async function fetchRepoDelta(params: {
  ref: WatchRef
  since: number | null
  seenTags?: readonly string[]
  deps: FetchDeps
}): Promise<WatchCheckOutcome> {
  const { ref, since, deps } = params
  const now = deps.now?.() ?? Date.now()
  const base = `${API}/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.name)}`
  const sinceIso = since ? new Date(since).toISOString() : null

  const repo = await get(base, deps)
  if (!repo.ok) {
    return repo.rateLimited
      ? { status: "skipped", note: repo.note, ...(repo.retryAt ? { retryAt: repo.retryAt } : {}) }
      : { status: "error", note: repo.note }
  }
  const repoBody = (repo.body ?? {}) as Record<string, unknown>
  const defaultBranch = str(repoBody.default_branch, 200) || "main"
  const description = str(repoBody.description, 500)

  /** A skip anywhere in the sequence skips the WHOLE watch: half a delta would
   *  advance the cursor and silently lose the rest. */
  let skipped: { note: string; retryAt?: number } | null = null
  const fetchList = async (url: string): Promise<Record<string, unknown>[]> => {
    if (skipped) return []
    const result = await get(url, deps)
    if (result.ok) return list(result.body)
    if (result.rateLimited) skipped = { note: result.note, ...(result.retryAt ? { retryAt: result.retryAt } : {}) }
    // A missing sub-resource (no releases, no CHANGELOG) is simply "nothing".
    return []
  }

  const releaseRows = await fetchList(`${base}/releases?per_page=${PER_PAGE}`)
  const releases: WatchRelease[] = []
  for (const row of releaseRows) {
    if (row.draft === true) continue
    const publishedAt = time(row.published_at) ?? time(row.created_at)
    if (publishedAt === null || (since !== null && publishedAt <= since)) continue
    releases.push({
      tag: str(row.tag_name, 200),
      name: str(row.name, 300) || str(row.tag_name, 200),
      publishedAt,
      url: str(row.html_url, 500),
      body: str(row.body, MAX_BODY_CHARS),
    })
    if (releases.length >= MAX_RELEASES) break
  }

  const tagRows = await fetchList(`${base}/tags?per_page=${PER_PAGE}`)
  const tags = tagRows.map((row) => str(row.name, 200)).filter(Boolean)
  const seen = new Set(params.seenTags ?? [])
  // First check: everything is "new", which would be noise. Tags only become a
  // signal once we have a baseline to diff against.
  const newTags = seen.size === 0 ? [] : tags.filter((tag) => !seen.has(tag))

  const pullRows = await fetchList(
    `${base}/pulls?state=closed&sort=updated&direction=desc&per_page=${PER_PAGE}`,
  )
  const pulls: WatchPull[] = []
  for (const row of pullRows) {
    const mergedAt = time(row.merged_at)
    if (mergedAt === null || (since !== null && mergedAt <= since)) continue
    const branch = ((row.base as Record<string, unknown> | undefined)?.ref ?? "") as string
    if (branch && branch !== defaultBranch) continue
    pulls.push({
      number: typeof row.number === "number" ? row.number : 0,
      title: str(row.title, 300),
      mergedAt,
      url: str(row.html_url, 500),
      author: str((row.user as Record<string, unknown> | undefined)?.login, 200),
    })
    if (pulls.length >= MAX_PULLS) break
  }

  const commits: WatchCommit[] = []
  for (const path of CHANGELOG_PATHS) {
    const query = new URLSearchParams({ sha: defaultBranch, path, per_page: "10" })
    if (sinceIso) query.set("since", sinceIso)
    for (const row of await fetchList(`${base}/commits?${query.toString()}`)) {
      const detail = (row.commit ?? {}) as Record<string, unknown>
      const author = (detail.author ?? {}) as Record<string, unknown>
      const committedAt = time(author.date)
      if (committedAt === null || (since !== null && committedAt <= since)) continue
      commits.push({
        sha: str(row.sha, 40).slice(0, 10),
        message: str(detail.message, 300).split("\n")[0] ?? "",
        committedAt,
        url: str(row.html_url, 500),
        path,
      })
      if (commits.length >= MAX_COMMITS) break
    }
  }

  if (skipped) {
    const stop = skipped as { note: string; retryAt?: number }
    return { status: "skipped", note: stop.note, ...(stop.retryAt ? { retryAt: stop.retryAt } : {}) }
  }

  const delta: WatchDelta = {
    ref,
    since,
    until: now,
    description,
    defaultBranch,
    releases,
    newTags,
    pulls,
    commits,
  }
  const changed = releases.length + newTags.length + pulls.length + commits.length > 0
  return { status: "ok", delta, changed, tags: tags.slice(0, MAX_SEEN_TAGS) }
}

// ---- artifact formatting --------------------------------------------------

function day(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

/**
 * The artifact a delta becomes.
 *
 * Written for the extraction pass that reads it next: what shipped, when, with
 * links, and an explicit instruction-free framing ("Competitor activity") so the
 * insight it produces reads as a decision signal rather than a news item.
 */
export function formatWatchArtifact(delta: WatchDelta): { externalId: string; title: string; content: string } {
  const label = repoLabel(delta.ref)
  const window = delta.since ? `${day(delta.since)} to ${day(delta.until)}` : `up to ${day(delta.until)}`
  const counts: string[] = []
  if (delta.releases.length) counts.push(`${delta.releases.length} release${delta.releases.length === 1 ? "" : "s"}`)
  if (delta.newTags.length) counts.push(`${delta.newTags.length} tag${delta.newTags.length === 1 ? "" : "s"}`)
  if (delta.pulls.length) counts.push(`${delta.pulls.length} merged PR${delta.pulls.length === 1 ? "" : "s"}`)
  if (delta.commits.length) counts.push(`${delta.commits.length} doc commit${delta.commits.length === 1 ? "" : "s"}`)

  const lines: string[] = [
    `Competitor activity: ${label}`,
    `Window: ${window}`,
    `Repository: https://github.com/${label}${delta.description ? ` — ${delta.description}` : ""}`,
    `Shipped: ${counts.length ? counts.join(", ") : "nothing"}`,
  ]

  if (delta.releases.length) {
    lines.push("", "Releases:")
    for (const release of delta.releases) {
      lines.push(`- ${release.name}${release.tag && release.tag !== release.name ? ` (${release.tag})` : ""} — ${day(release.publishedAt)}`)
      if (release.url) lines.push(`  ${release.url}`)
      const body = release.body.trim()
      if (body) for (const line of body.split("\n")) lines.push(`  ${line}`)
    }
  }
  if (delta.newTags.length) {
    lines.push("", `New tags: ${delta.newTags.join(", ")}`)
  }
  if (delta.pulls.length) {
    lines.push("", "Merged pull requests:")
    for (const pull of delta.pulls) {
      lines.push(`- #${pull.number} ${pull.title} — ${day(pull.mergedAt)}${pull.author ? ` by ${pull.author}` : ""}`)
      if (pull.url) lines.push(`  ${pull.url}`)
    }
  }
  if (delta.commits.length) {
    lines.push("", "Changelog / README commits:")
    for (const commit of delta.commits) {
      lines.push(`- ${commit.path}: ${commit.message} (${commit.sha}) — ${day(commit.committedAt)}`)
      if (commit.url) lines.push(`  ${commit.url}`)
    }
  }

  return {
    // One artifact per repo per window: re-checking the same window with the
    // same content is deduped by the store's content hash.
    externalId: `${label}@${new Date(delta.until).toISOString()}`,
    title: `${label} — ${counts.length ? counts.join(", ") : "no change"}`,
    content: lines.join("\n"),
  }
}
