// Competitor-watch delta computation and artifact formatting.
// Every request is served by an injected fetch — these tests never touch GitHub.
// Run with: bun test src/bun/repoWatch.test.ts
import { describe, expect, it } from "bun:test"
import { fetchRepoDelta, formatWatchArtifact, parseRepoRef, repoLabel } from "./repoWatch"

const REF = { owner: "sst", name: "opencode" }
const DAY = 86_400_000
const NOW = Date.UTC(2026, 0, 10, 9, 0, 0)
const SINCE = NOW - 3 * DAY

const iso = (ms: number) => new Date(ms).toISOString()

type Routes = Record<string, unknown>

/** Serves the six endpoints a check touches; anything unrouted 404s (which is
 *  how a repo with no releases or no CHANGELOG really behaves). */
function fakeFetch(routes: Routes, options: { calls?: string[]; status?: (url: string) => Response | null } = {}) {
  return (async (url: RequestInfo | URL) => {
    const href = String(url)
    options.calls?.push(href)
    const override = options.status?.(href)
    if (override) return override
    const key = Object.keys(routes).find((route) => href.includes(route))
    if (!key) return new Response("[]", { status: 200, headers: { "content-type": "application/json" } })
    return new Response(JSON.stringify(routes[key]), { status: 200, headers: { "content-type": "application/json" } })
  }) as typeof fetch
}

const repoBody = { default_branch: "dev", description: "AI coding agent for the terminal" }

describe("parseRepoRef", () => {
  it("accepts owner/name, a URL, or whitespace between them", () => {
    expect(parseRepoRef("sst/opencode")).toEqual(REF)
    expect(parseRepoRef("  sst / opencode ")).toEqual({ owner: "sst", name: "opencode" })
    expect(parseRepoRef("https://github.com/sst/opencode")).toEqual(REF)
    expect(parseRepoRef("https://github.com/sst/opencode.git")).toEqual(REF)
    expect(repoLabel(REF)).toBe("sst/opencode")
  })

  it("rejects anything that is not one repository", () => {
    for (const bad of ["", "opencode", "sst/opencode/extra", "sst/", "/opencode", 42, null, "a/b c/d"]) {
      expect(parseRepoRef(bad)).toBeNull()
    }
  })
})

describe("fetchRepoDelta", () => {
  it("collects releases, merged PRs and changelog commits newer than the cursor", async () => {
    const calls: string[] = []
    const deps = {
      fetch: fakeFetch(
        {
          "/releases": [
            { tag_name: "v0.9.0", name: "v0.9.0", published_at: iso(NOW - DAY), html_url: "https://gh/r/1", body: "Adds subagents" },
            { tag_name: "v0.8.0", name: "v0.8.0", published_at: iso(SINCE - DAY), html_url: "https://gh/r/0", body: "old" },
            { tag_name: "v1.0.0-rc", name: "draft", draft: true, published_at: iso(NOW), html_url: "https://gh/r/d", body: "" },
          ],
          "/tags": [{ name: "v0.9.0" }, { name: "v0.8.0" }],
          "/pulls": [
            { number: 12, title: "Add MCP support", merged_at: iso(NOW - 2 * DAY), html_url: "https://gh/p/12", base: { ref: "dev" }, user: { login: "ada" } },
            { number: 11, title: "Old work", merged_at: iso(SINCE - DAY), html_url: "https://gh/p/11", base: { ref: "dev" }, user: { login: "bob" } },
            { number: 10, title: "Never merged", merged_at: null, html_url: "https://gh/p/10", base: { ref: "dev" }, user: { login: "cy" } },
            { number: 9, title: "Onto a side branch", merged_at: iso(NOW - DAY), html_url: "https://gh/p/9", base: { ref: "next" }, user: { login: "dee" } },
          ],
          "path=CHANGELOG.md": [
            { sha: "abcdef1234567", html_url: "https://gh/c/1", commit: { message: "docs: 0.9 notes\n\nbody", author: { date: iso(NOW - DAY) } } },
          ],
          "/repos/sst/opencode?": repoBody,
        },
        { calls },
      ),
      now: () => NOW,
    }
    // The repo endpoint has no suffix, so route it by exact tail match instead.
    const result = await fetchRepoDelta({
      ref: REF,
      since: SINCE,
      seenTags: ["v0.8.0"],
      deps: {
        ...deps,
        fetch: (async (url: RequestInfo | URL) => {
          const href = String(url)
          calls.push(href)
          if (href.endsWith("/repos/sst/opencode")) return new Response(JSON.stringify(repoBody))
          return deps.fetch(url)
        }) as typeof fetch,
      },
    })

    expect(result.status).toBe("ok")
    if (result.status !== "ok") return
    expect(result.changed).toBe(true)
    expect(result.delta.defaultBranch).toBe("dev")
    expect(result.delta.releases.map((row) => row.tag)).toEqual(["v0.9.0"])
    expect(result.delta.releases[0]?.body).toBe("Adds subagents")
    expect(result.delta.pulls.map((row) => row.number)).toEqual([12])
    expect(result.delta.commits.map((row) => row.message)).toEqual(["docs: 0.9 notes"])
    expect(result.delta.newTags).toEqual(["v0.9.0"])
    expect(result.tags).toEqual(["v0.9.0", "v0.8.0"])
    // The default branch from /repos is what the commits query filters on.
    expect(calls.some((url) => url.includes("sha=dev"))).toBe(true)
  })

  it("reports no change when nothing landed since the cursor", async () => {
    const result = await fetchRepoDelta({
      ref: REF,
      since: SINCE,
      seenTags: ["v0.8.0"],
      deps: {
        fetch: fakeFetch({
          "/releases": [{ tag_name: "v0.8.0", name: "v0.8.0", published_at: iso(SINCE - DAY), html_url: "", body: "" }],
          "/tags": [{ name: "v0.8.0" }],
          "/pulls": [{ number: 1, title: "Old", merged_at: iso(SINCE - DAY), base: { ref: "main" }, user: { login: "ada" } }],
        }),
        now: () => NOW,
      },
    })
    expect(result.status).toBe("ok")
    if (result.status !== "ok") return
    expect(result.changed).toBe(false)
    expect(result.delta.releases).toEqual([])
    expect(result.delta.newTags).toEqual([])
  })

  it("suppresses the tag flood on a first check (no baseline to diff)", async () => {
    const result = await fetchRepoDelta({
      ref: REF,
      since: null,
      seenTags: [],
      deps: {
        fetch: fakeFetch({ "/tags": [{ name: "v1" }, { name: "v2" }] }),
        now: () => NOW,
      },
    })
    expect(result.status).toBe("ok")
    if (result.status !== "ok") return
    expect(result.delta.newTags).toEqual([])
    expect(result.tags).toEqual(["v1", "v2"])
  })

  it("skips (never throws) when GitHub rate-limits the very first call", async () => {
    const result = await fetchRepoDelta({
      ref: REF,
      since: SINCE,
      deps: {
        fetch: (async () =>
          new Response(JSON.stringify({ message: "API rate limit exceeded" }), {
            status: 403,
            headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Math.floor((NOW + 3600_000) / 1000)) },
          })) as typeof fetch,
        now: () => NOW,
      },
    })
    expect(result.status).toBe("skipped")
    if (result.status !== "skipped") return
    expect(result.note).toContain("rate limit")
    expect(result.retryAt).toBe(NOW + 3600_000)
  })

  it("skips the WHOLE watch when the limit is hit midway, so no cursor advances", async () => {
    let seen = 0
    const result = await fetchRepoDelta({
      ref: REF,
      since: SINCE,
      seenTags: ["v0.8.0"],
      deps: {
        fetch: (async (url: RequestInfo | URL) => {
          seen += 1
          if (String(url).includes("/pulls")) {
            return new Response("{}", { status: 403, headers: { "x-ratelimit-remaining": "0" } })
          }
          if (String(url).includes("/releases")) {
            return new Response(JSON.stringify([{ tag_name: "v0.9.0", name: "v0.9.0", published_at: iso(NOW - DAY), html_url: "", body: "" }]))
          }
          return new Response(JSON.stringify(String(url).endsWith("/repos/sst/opencode") ? repoBody : []))
        }) as typeof fetch,
        now: () => NOW,
      },
    })
    expect(result.status).toBe("skipped")
    expect(seen).toBeGreaterThan(1)
  })

  it("reports a missing repository as an error, and an unreachable GitHub as one too", async () => {
    const missing = await fetchRepoDelta({
      ref: REF,
      since: null,
      deps: { fetch: (async () => new Response("{}", { status: 404 })) as typeof fetch, now: () => NOW },
    })
    expect(missing).toMatchObject({ status: "error" })
    if (missing.status === "error") expect(missing.note).toContain("not found")

    const offline = await fetchRepoDelta({
      ref: REF,
      since: null,
      deps: {
        fetch: (async () => {
          throw new Error("getaddrinfo ENOTFOUND")
        }) as typeof fetch,
        now: () => NOW,
      },
    })
    expect(offline).toMatchObject({ status: "error", note: "GitHub is unreachable" })
  })

  it("sends the token only as a header, and works without one", async () => {
    const headers: (Headers | undefined)[] = []
    const capture = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      headers.push(new Headers(init?.headers))
      return new Response("[]")
    }) as typeof fetch

    await fetchRepoDelta({ ref: REF, since: null, deps: { fetch: capture, token: "ghp_secret", now: () => NOW } })
    expect(headers[0]?.get("authorization")).toBe("Bearer ghp_secret")
    headers.length = 0
    await fetchRepoDelta({ ref: REF, since: null, deps: { fetch: capture, now: () => NOW } })
    expect(headers[0]?.get("authorization")).toBeNull()
  })
})

describe("formatWatchArtifact", () => {
  const delta = {
    ref: REF,
    since: SINCE,
    until: NOW,
    description: "AI coding agent",
    defaultBranch: "dev",
    releases: [{ tag: "v0.9.0", name: "0.9.0", publishedAt: NOW - DAY, url: "https://gh/r/1", body: "- subagents\n- faster" }],
    newTags: ["v0.9.1"],
    pulls: [{ number: 12, title: "Add MCP support", mergedAt: NOW - 2 * DAY, url: "https://gh/p/12", author: "ada" }],
    commits: [{ sha: "abcdef1", message: "docs: notes", committedAt: NOW - DAY, url: "https://gh/c/1", path: "CHANGELOG.md" }],
  }

  it("writes a decision-ready artifact: what shipped, when, and where to read it", () => {
    const artifact = formatWatchArtifact(delta)
    expect(artifact.title).toBe("sst/opencode — 1 release, 1 tag, 1 merged PR, 1 doc commit")
    expect(artifact.externalId).toBe(`sst/opencode@${iso(NOW)}`)
    expect(artifact.content).toContain("Competitor activity: sst/opencode")
    expect(artifact.content).toContain("Window: 2026-01-07 to 2026-01-10")
    expect(artifact.content).toContain("https://github.com/sst/opencode — AI coding agent")
    expect(artifact.content).toContain("- 0.9.0 (v0.9.0) — 2026-01-09")
    expect(artifact.content).toContain("  - subagents")
    expect(artifact.content).toContain("New tags: v0.9.1")
    expect(artifact.content).toContain("- #12 Add MCP support — 2026-01-08 by ada")
    expect(artifact.content).toContain("- CHANGELOG.md: docs: notes (abcdef1) — 2026-01-09")
  })

  it("still describes an empty window without inventing activity", () => {
    const empty = formatWatchArtifact({ ...delta, releases: [], newTags: [], pulls: [], commits: [] })
    expect(empty.title).toBe("sst/opencode — no change")
    expect(empty.content).toContain("Shipped: nothing")
    expect(empty.content).not.toContain("Releases:")
  })

  it("labels a first-ever check as an open window", () => {
    expect(formatWatchArtifact({ ...delta, since: null }).content).toContain("Window: up to 2026-01-10")
  })
})
