// "Add repo from a git URL": the app spins up a throwaway BOOTSTRAP session in
// the destination parent directory and gives it a goal — clone this URL here —
// then watches it work over SSE. The agent never touches the server's repo
// registry (its shell has no server port/token); when the goal finishes, the APP
// resolves the clone path and registers it through the normal addRepo flow.
//
// Everything above `runCloneSession` is pure so the URL/path parsing that
// decides what gets registered is testable without a server.
import type { AgentEvent, GoalStatus } from "@chunky/protocol"
import { createSession, openEventStream, setGoal } from "./api"

// ---- URL parsing ---------------------------------------------------------

export interface ParsedGitUrl {
  /** The URL to hand to git, normalized (whitespace/trailing slash trimmed). */
  url: string
  /** Directory name `git clone` would create — the repo leaf, minus `.git`. */
  leaf: string
  /** `owner/repo` when the URL carries one; used for the session title. */
  slug: string
}

/** Path segments that mean "we're past owner/repo" in a web URL. */
const WEB_SUFFIXES = new Set(["tree", "blob", "commit", "commits", "releases", "pull", "issues"])

const SAFE_LEAF = /^[A-Za-z0-9._-]+$/

/**
 * Accepts the shapes a user actually pastes:
 *   https://github.com/owner/repo          git@github.com:owner/repo.git
 *   https://github.com/owner/repo.git      ssh://git@host/owner/repo.git
 *   https://github.com/owner/repo/tree/main    (branch/file URLs are trimmed)
 * Returns null for anything without a usable repo name — the caller shows a
 * validation message rather than shipping a bad objective to an agent.
 */
export function parseGitUrl(raw: string): ParsedGitUrl | null {
  const url = (raw ?? "").trim()
  // Reject shell/control hazards outright: this string ends up in an objective
  // an agent will run `git clone` with.
  if (!url || /[\s\0"'`$;|&<>\\]/.test(url)) return null

  const scp = /^([A-Za-z0-9._-]+@)?([A-Za-z0-9.-]+):(?!\/)(.+)$/.exec(url)
  let segments: string[]
  if (scp) {
    // git@github.com:owner/repo.git — SCP-like, no scheme.
    segments = scp[3]!.split("/").filter(Boolean)
  } else {
    const withScheme = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(url) ? url : `https://${url}`
    let parsed: URL
    try {
      parsed = new URL(withScheme)
    } catch {
      return null
    }
    if (!parsed.hostname.includes(".")) return null
    segments = parsed.pathname.split("/").filter(Boolean)
  }

  // Trim `/tree/main`, `/blob/main/README.md`, … back to owner/repo.
  const cut = segments.findIndex((s) => WEB_SUFFIXES.has(s.toLowerCase()))
  if (cut > 0) segments = segments.slice(0, cut)
  if (segments.length === 0) return null

  const leaf = segments[segments.length - 1]!.replace(/\.git$/i, "")
  if (!leaf || leaf === "." || leaf === ".." || !SAFE_LEAF.test(leaf)) return null

  const slug = segments.length >= 2 ? `${segments[segments.length - 2]}/${leaf}` : leaf
  return { url, leaf, slug }
}

// ---- Destination directory ------------------------------------------------

/** Join without doubling or dropping the separator (no node:path in the renderer). */
export function joinPath(parent: string, child: string): string {
  return `${parent.replace(/\/+$/, "")}/${child.replace(/^\/+/, "")}`
}

/** Parent of an absolute path, or null when there isn't a meaningful one. */
export function parentDirOf(path: string | null | undefined): string | null {
  if (!path || !path.startsWith("/")) return null
  const trimmed = path.replace(/\/+$/, "")
  const slash = trimmed.lastIndexOf("/")
  if (slash <= 0) return null
  return trimmed.slice(0, slash)
}

/**
 * Where a clone should land by default: the first native candidate root
 * (~/code, ~/Projects, …), else the folder holding the repo the user is in.
 * Returns "" when nothing is known — the field then just starts empty.
 */
export function defaultCloneParent(roots: string[], fallbackRepoPath?: string | null): string {
  const root = roots.find((r) => typeof r === "string" && r.startsWith("/"))
  if (root) return root.replace(/\/+$/, "")
  return parentDirOf(fallbackRepoPath) ?? ""
}

// ---- The agent's brief ----------------------------------------------------

/**
 * The goal objective. It is deliberately explicit about the destination and
 * about ending with the absolute path on its own line: that printed line is
 * what the app parses to decide which folder to register.
 */
export function cloneObjective(input: { url: string; parentDir: string; leaf: string }): string {
  const target = joinPath(input.parentDir, input.leaf)
  return `Clone the git repository ${input.url} into the directory ${input.parentDir}, then report where it landed.

Steps:
1. Stay in ${input.parentDir}. Do not cd anywhere else, and do not clone into any other directory.
2. Clone with \`gh repo clone ${input.url} -- --progress\` when the \`gh\` CLI is available and authenticated (it handles private repos); otherwise use \`git clone ${input.url}\`.
3. If ${target} already exists and is a git clone of that URL, keep it — do not delete or re-clone it. If it exists but is something else, clone into a sibling directory with a suffixed name instead.
4. Verify the result: the directory must exist and contain a .git directory.

Do not install dependencies, run builds, open editors, or change anything else on this machine — cloning and verifying is the whole job.

Finish by printing the absolute path of the cloned repository on a line of its own, with no quotes, backticks, or trailing punctuation, e.g.:
${target}

Then call goal_complete with that path in the summary. If the clone cannot be done (bad URL, auth required, network failure), call goal_blocked with the exact error instead of guessing.`
}

// ---- Reading the agent's output ------------------------------------------

const PATH_LINE = /(\/(?:[^\s"'`,;:()[\]{}]+))/g

/**
 * Find the cloned directory in whatever the agent printed. Prefers the LAST
 * absolute path that looks like the expected clone (inside the parent dir, or
 * ending in the repo leaf), which is the "print the path on its own line" ask.
 * Returns null when nothing matches — the caller decides whether to fall back.
 */
export function extractClonePath(
  text: string,
  input: { parentDir: string; leaf: string },
): string | null {
  if (!text) return null
  const parent = input.parentDir.replace(/\/+$/, "")
  const expected = parent ? joinPath(parent, input.leaf) : ""
  const candidates: string[] = []
  for (const raw of text.split(/\r?\n/)) {
    // Strip markdown/quoting noise around an otherwise bare path line.
    const line = raw.trim().replace(/^[-*>\s]+/, "").replace(/[`'"]/g, "").trim()
    for (const match of line.matchAll(PATH_LINE)) {
      const candidate = match[1]!.replace(/[.,;:)]+$/, "").replace(/\/+$/, "")
      if (candidate.length < 2) continue
      candidates.push(candidate)
    }
  }
  // Exact expected path wins wherever it appears; otherwise the last path that
  // sits under the destination parent; otherwise the last one ending in `leaf`.
  if (expected && candidates.includes(expected)) return expected
  const underParent = candidates.filter((c) => parent && c.startsWith(`${parent}/`))
  if (underParent.length) return underParent[underParent.length - 1]!
  const byLeaf = candidates.filter((c) => c.endsWith(`/${input.leaf}`))
  if (byLeaf.length) return byLeaf[byLeaf.length - 1]!
  return null
}

/** One short, human-readable progress line for the popover, or null to ignore. */
export function summarizeEvent(ev: AgentEvent): string | null {
  switch (ev.type) {
    case "tool.start": {
      const input = ev.input as { command?: unknown; description?: unknown } | null
      const command = typeof input?.command === "string" ? input.command : null
      const description = typeof input?.description === "string" ? input.description : null
      return `⚒ ${ev.name}${command ? `: ${firstLine(command)}` : description ? `: ${description}` : ""}`
    }
    case "tool.end":
      return ev.ok ? null : `⚠ ${firstLine(ev.output) || "tool failed"}`
    case "goal.update":
      return ev.message ? firstLine(ev.message) : null
    case "error":
      return `⚠ ${firstLine(ev.message)}`
    default:
      return null
  }
}

function firstLine(text: string, max = 120): string {
  const line = (text ?? "").split(/\r?\n/).find((l) => l.trim()) ?? ""
  const trimmed = line.trim()
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed
}

// ---- The bootstrap session ------------------------------------------------

/** A goal that stopped: `complete` is success, the rest are for the error text. */
const TERMINAL: GoalStatus[] = ["complete", "blocked", "paused"]

/** Hard ceiling on one clone run (big repos are slow; hung goals are worse). */
const RUN_TIMEOUT_MS = 10 * 60_000

export interface CloneRunHandlers {
  /** Fires once the bootstrap session exists, so the UI can offer "view thread". */
  onSession?: (sessionId: string) => void
  /** A new progress line (already summarized). */
  onProgress?: (line: string) => void
}

export interface CloneRunResult {
  sessionId: string
  /** Terminal goal status, or null when the stream ended without one. */
  status: GoalStatus | null
  /** Everything the agent said, for path extraction + error reporting. */
  text: string
  /** The last assistant message, shown verbatim when things go wrong. */
  lastMessage: string
}

/**
 * Create the bootstrap session in `parentDir`, set the clone goal (the POST
 * starts the run server-side), and stream until the goal reaches a terminal
 * state. Resolves with what the agent said; the CALLER registers the repo.
 */
export async function runCloneSession(
  baseUrl: string,
  input: { url: string; parentDir: string; leaf: string },
  handlers: CloneRunHandlers = {},
  signal?: AbortSignal,
): Promise<CloneRunResult> {
  const { sessionId } = await createSession(baseUrl, null, input.parentDir)
  handlers.onSession?.(sessionId)

  let text = ""
  let message = ""
  let lastMessage = ""
  let status: GoalStatus | null = null

  const stop = new AbortController()
  const onAbort = () => stop.abort()
  if (signal) {
    if (signal.aborted) stop.abort()
    else signal.addEventListener("abort", onAbort, { once: true })
  }

  // Cap the run so a goal that never settles can't hang the popover forever.
  const timer = window.setTimeout(() => stop.abort(), RUN_TIMEOUT_MS)

  let markOpen: () => void = () => {}
  const opened = new Promise<void>((resolve) => {
    markOpen = resolve
  })

  try {
    // Attach BEFORE setting the goal: the goal POST dispatches the run
    // immediately, and goal.update is not replayed on a late attach.
    const stream = openEventStream(
      baseUrl,
      sessionId,
      (ev) => {
        if (ev.type === "message.delta" && !ev.threadId) message += ev.text
        if (ev.type === "message.end" && !ev.threadId) {
          if (message.trim()) {
            lastMessage = message.trim()
            text += `${message}\n`
          }
          message = ""
        }
        // Tool output can carry the printed path too (e.g. `pwd` after cloning).
        if (ev.type === "tool.end" && ev.ok) text += `${ev.output}\n`
        const line = summarizeEvent(ev)
        if (line) handlers.onProgress?.(line)
        if (ev.type === "goal.update" && ev.goal && TERMINAL.includes(ev.goal.status)) {
          status = ev.goal.status
          // The goal is settled; stop reading rather than hold the stream open.
          stop.abort()
        }
        if (ev.type === "goal.update" && !ev.goal) stop.abort()
      },
      stop.signal,
      markOpen,
    ).catch((err: unknown) => {
      // An aborted read is how we stop on purpose — only real failures matter.
      if (!stop.signal.aborted) throw err
    })

    await Promise.race([opened, stream])
    await setGoal(baseUrl, sessionId, {
      objective: cloneObjective(input),
      mode: "direct",
      maxTurns: 8,
    })
    await stream
  } catch (err) {
    stop.abort()
    throw err
  } finally {
    window.clearTimeout(timer)
    signal?.removeEventListener("abort", onAbort)
  }

  if (message.trim()) {
    lastMessage = message.trim()
    text += `${message}\n`
  }
  return { sessionId, status, text, lastMessage }
}
