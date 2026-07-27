// Native-only Git and hosted-source-control bridge. Commands are always passed
// as argv (never through a shell), and every public function converts failures
// into a safe RPC result.
import { existsSync, statSync } from "node:fs"
import { isAbsolute, join, resolve } from "node:path"

export type GitFile = { path: string; status: string }
export type GitStatus = {
  isRepo: boolean
  branch: string
  upstream: string | null
  ahead: number
  behind: number
  staged: GitFile[]
  unstaged: GitFile[]
  untracked: string[]
}
export type GitBranches = {
  current: string
  local: string[]
  remote: string[]
  worktrees: { path: string; branch: string }[]
}
export type CommandResult = { ok: boolean; output: string }
export type ScmProvider = "github" | "gitlab" | "bitbucket" | "azure"
export type ScmInfo = {
  provider: ScmProvider | null
  remoteUrl: string | null
  cliAvailable: boolean
  cliName: string | null
}
export type ScmPr = {
  number: number
  title: string
  url: string
  state: string
  headBranch: string
  author: string
}
export type ScmCreatePrResult = CommandResult & { url: string | null }
export type ScmListPrsResult = CommandResult & { prs: ScmPr[] }
export type ScmCloneResult = CommandResult & { path: string | null }

const EMPTY_STATUS: GitStatus = {
  isRepo: false, branch: "", upstream: null, ahead: 0, behind: 0, staged: [], unstaged: [], untracked: [],
}
const EMPTY_BRANCHES: GitBranches = { current: "", local: [], remote: [], worktrees: [] }
const UNSUPPORTED = "Provider CLI not supported yet"

function validDirectory(value: unknown): string | null {
  if (typeof value !== "string" || !value || !isAbsolute(value) || value.includes("\0")) return null
  try {
    const cwd = resolve(value)
    return existsSync(cwd) && statSync(cwd).isDirectory() ? cwd : null
  } catch {
    return null
  }
}

function validPaths(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.some((path) => typeof path !== "string" || !path || path.includes("\0"))) return null
  return value as string[]
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error || "Command failed")
}

async function command(args: string[], cwd: string, timeout = 60_000): Promise<CommandResult> {
  try {
    const child = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "pipe" })
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, timeout)
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    clearTimeout(timer)
    const output = `${stdout}${stderr}`.trim()
    return { ok: !timedOut && exitCode === 0, output: timedOut ? `${output}\nCommand timed out`.trim() : output }
  } catch (error) {
    return { ok: false, output: errorText(error) }
  }
}

async function git(args: string[], cwd: string): Promise<CommandResult> {
  return command(["git", ...args], cwd)
}

function pathAfterWords(line: string, words: number): string {
  let cursor = 0
  for (let i = 0; i < words; i++) {
    const space = line.indexOf(" ", cursor)
    if (space < 0) return ""
    cursor = space + 1
  }
  return line.slice(cursor).split("\t", 1)[0] || ""
}

function providerFor(remoteUrl: string | null): ScmProvider | null {
  if (!remoteUrl) return null
  const url = remoteUrl.toLowerCase()
  if (url.includes("github.com")) return "github"
  if (url.includes("gitlab")) return "gitlab"
  if (url.includes("bitbucket.org")) return "bitbucket"
  if (url.includes("dev.azure.com") || url.includes("visualstudio.com")) return "azure"
  return null
}

function cliFor(provider: ScmProvider | null): "gh" | "glab" | null {
  return provider === "github" ? "gh" : provider === "gitlab" ? "glab" : null
}

async function info(cwd: string): Promise<ScmInfo> {
  const remote = await git(["remote", "get-url", "origin"], cwd)
  const remoteUrl = remote.ok && remote.output ? remote.output.split(/\r?\n/, 1)[0]!.trim() : null
  const provider = providerFor(remoteUrl)
  const cliName = cliFor(provider)
  return { provider, remoteUrl, cliAvailable: !!cliName && !!Bun.which(cliName), cliName }
}

function invalidCommand(): CommandResult {
  return { ok: false, output: "cwd must be an absolute existing directory" }
}

export async function gitStatus(params: { cwd?: unknown }): Promise<GitStatus> {
  const cwd = validDirectory(params?.cwd)
  if (!cwd) return { ...EMPTY_STATUS }
  const result = await git(["status", "--porcelain=v2", "--branch"], cwd)
  if (!result.ok) return { ...EMPTY_STATUS }
  const status: GitStatus = { ...EMPTY_STATUS, isRepo: true, staged: [], unstaged: [], untracked: [] }
  for (const line of result.output.split(/\r?\n/)) {
    if (line.startsWith("# branch.head ")) status.branch = line.slice(14).trim() === "(detached)" ? "" : line.slice(14).trim()
    else if (line.startsWith("# branch.upstream ")) status.upstream = line.slice(18).trim() || null
    else if (line.startsWith("# branch.ab ")) {
      const match = /\+(\d+)\s+-(\d+)/.exec(line)
      status.ahead = Number(match?.[1] || 0)
      status.behind = Number(match?.[2] || 0)
    } else if (line.startsWith("? ")) status.untracked.push(line.slice(2))
    else if (line.startsWith("1 ") || line.startsWith("2 ")) {
      const xy = line.slice(2, 4)
      const path = pathAfterWords(line, line.startsWith("1 ") ? 8 : 9)
      if (path && xy[0] && xy[0] !== ".") status.staged.push({ path, status: xy[0] })
      if (path && xy[1] && xy[1] !== ".") status.unstaged.push({ path, status: xy[1] })
    } else if (line.startsWith("u ")) {
      const path = pathAfterWords(line, 10)
      if (path) {
        status.staged.push({ path, status: "U" })
        status.unstaged.push({ path, status: "U" })
      }
    }
  }
  return status
}

export async function gitBranches(params: { cwd?: unknown }): Promise<GitBranches> {
  const cwd = validDirectory(params?.cwd)
  if (!cwd) return { ...EMPTY_BRANCHES, local: [], remote: [], worktrees: [] }
  const [current, local, remote, worktree] = await Promise.all([
    git(["branch", "--show-current"], cwd), git(["branch", "--format=%(refname:short)"], cwd),
    git(["branch", "-r", "--format=%(refname:short)"], cwd), git(["worktree", "list", "--porcelain"], cwd),
  ])
  if (!current.ok) return { ...EMPTY_BRANCHES, local: [], remote: [], worktrees: [] }
  const worktrees: GitBranches["worktrees"] = []
  let path = ""
  for (const line of worktree.output.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) path = line.slice(9)
    else if (line.startsWith("branch ") && path) {
      worktrees.push({ path, branch: line.slice(7).replace(/^refs\/heads\//, "") })
      path = ""
    } else if (!line && path) { worktrees.push({ path, branch: "" }); path = "" }
  }
  return {
    current: current.output.trim(), local: local.ok ? local.output.split(/\r?\n/).filter(Boolean) : [],
    remote: remote.ok ? remote.output.split(/\r?\n/).filter(Boolean) : [], worktrees,
  }
}

export async function gitStage(params: { cwd?: unknown; paths?: unknown }): Promise<CommandResult> {
  const cwd = validDirectory(params?.cwd); const paths = validPaths(params?.paths)
  return !cwd || !paths ? invalidCommand() : git(paths.length ? ["add", "--", ...paths] : ["add", "-A"], cwd)
}

export async function gitUnstage(params: { cwd?: unknown; paths?: unknown }): Promise<CommandResult> {
  const cwd = validDirectory(params?.cwd); const paths = validPaths(params?.paths)
  return !cwd || !paths ? invalidCommand() : git(paths.length ? ["restore", "--staged", "--", ...paths] : ["restore", "--staged", "."], cwd)
}

export async function gitCommit(params: { cwd?: unknown; message?: unknown; stageAll?: unknown }): Promise<CommandResult> {
  const cwd = validDirectory(params?.cwd)
  if (!cwd) return invalidCommand()
  if (typeof params?.message !== "string" || !params.message.trim() || params.message.includes("\0")) return { ok: false, output: "A commit message is required" }
  if (params.stageAll === true) {
    const staged = await git(["add", "-A"], cwd)
    if (!staged.ok) return staged
  }
  return git(["commit", "-m", params.message], cwd)
}

export async function gitSwitch(params: { cwd?: unknown; branch?: unknown; create?: unknown }): Promise<CommandResult> {
  const cwd = validDirectory(params?.cwd)
  if (!cwd) return invalidCommand()
  if (typeof params?.branch !== "string" || !params.branch.trim() || params.branch.includes("\0")) return { ok: false, output: "A branch is required" }
  return git(params.create === true ? ["switch", "-c", params.branch] : ["switch", params.branch], cwd)
}

export async function gitPull(params: { cwd?: unknown }): Promise<CommandResult> { const cwd = validDirectory(params?.cwd); return cwd ? git(["pull"], cwd) : invalidCommand() }
export async function gitPush(params: { cwd?: unknown; setUpstream?: unknown }): Promise<CommandResult> { const cwd = validDirectory(params?.cwd); return cwd ? git(params?.setUpstream === true ? ["push", "-u", "origin", "HEAD"] : ["push"], cwd) : invalidCommand() }
export async function scmInfo(params: { cwd?: unknown }): Promise<ScmInfo> { const cwd = validDirectory(params?.cwd); return cwd ? info(cwd) : { provider: null, remoteUrl: null, cliAvailable: false, cliName: null } }

async function supportedScm(cwd: string): Promise<{ provider: ScmProvider; cli: "gh" | "glab" } | CommandResult> {
  const scm = await info(cwd)
  if (scm.provider === "bitbucket" || scm.provider === "azure") return { ok: false, output: UNSUPPORTED }
  if (!scm.provider || !scm.cliName) return { ok: false, output: "No supported source-control provider remote found" }
  if (!scm.cliAvailable) return { ok: false, output: `${scm.cliName} is not available on PATH` }
  return { provider: scm.provider, cli: scm.cliName }
}

function isFailure(value: { provider: ScmProvider; cli: "gh" | "glab" } | CommandResult): value is CommandResult { return "ok" in value }
function urlFrom(output: string): string | null { return output.match(/https?:\/\/[^\s]+/)?.[0] ?? null }

export async function scmCreatePr(params: { cwd?: unknown; title?: unknown; body?: unknown; draft?: unknown; base?: unknown }): Promise<ScmCreatePrResult> {
  const cwd = validDirectory(params?.cwd)
  if (!cwd) return { ...invalidCommand(), url: null }
  if (typeof params?.title !== "string" || !params.title.trim()) return { ok: false, url: null, output: "A pull request title is required" }
  const scm = await supportedScm(cwd); if (isFailure(scm)) return { ...scm, url: null }
  const args = scm.cli === "gh" ? ["pr", "create", "--title", params.title] : ["mr", "create", "--title", params.title]
  if (typeof params.body === "string") args.push(scm.cli === "gh" ? "--body" : "--description", params.body)
  if (params.draft === true) args.push("--draft")
  if (typeof params.base === "string" && params.base.trim()) args.push(scm.cli === "gh" ? "--base" : "--target-branch", params.base)
  const result = await command([scm.cli, ...args], cwd)
  return { ...result, url: result.ok ? urlFrom(result.output) : null }
}

export async function scmListPrs(params: { cwd?: unknown }): Promise<ScmListPrsResult> {
  const cwd = validDirectory(params?.cwd)
  if (!cwd) return { ...invalidCommand(), prs: [] }
  const scm = await supportedScm(cwd); if (isFailure(scm)) return { ...scm, prs: [] }
  const result = await command(scm.cli === "gh" ? ["gh", "pr", "list", "--json", "number,title,url,state,headRefName,author"] : ["glab", "mr", "list", "-F", "json"], cwd)
  if (!result.ok) return { ...result, prs: [] }
  try {
    const rows = JSON.parse(result.output) as unknown[]
    const prs = rows.map((row): ScmPr | null => {
      if (!row || typeof row !== "object") return null
      const r = row as Record<string, unknown>; const author = r.author as Record<string, unknown> | null
      const number = r.number ?? r.iid; const url = r.url ?? r.web_url; const head = r.headRefName ?? r.source_branch
      return typeof number === "number" && typeof r.title === "string" && typeof url === "string" && typeof r.state === "string" && typeof head === "string"
        ? { number, title: r.title, url, state: r.state, headBranch: head, author: typeof author?.login === "string" ? author.login : typeof author?.username === "string" ? author.username : typeof author?.name === "string" ? author.name : "" } : null
    }).filter((pr): pr is ScmPr => pr !== null)
    return { ok: true, prs, output: result.output }
  } catch { return { ok: false, prs: [], output: "Provider CLI returned invalid JSON" } }
}

export async function scmCheckoutPr(params: { cwd?: unknown; number?: unknown }): Promise<CommandResult> {
  const cwd = validDirectory(params?.cwd)
  if (!cwd) return invalidCommand()
  if (!Number.isInteger(params?.number) || (params.number as number) <= 0) return { ok: false, output: "A valid pull request number is required" }
  const scm = await supportedScm(cwd); if (isFailure(scm)) return scm
  return command(scm.cli === "gh" ? ["gh", "pr", "checkout", String(params.number)] : ["glab", "mr", "checkout", String(params.number)], cwd)
}

export async function scmClone(params: { url?: unknown; parentDir?: unknown }): Promise<ScmCloneResult> {
  const parentDir = validDirectory(params?.parentDir)
  if (!parentDir) return { ...invalidCommand(), path: null }
  if (typeof params?.url !== "string" || !params.url.trim() || params.url.includes("\0")) return { ok: false, path: null, output: "A repository URL is required" }
  const result = await command(["git", "clone", params.url], parentDir, 300_000)
  const leaf = params.url.replace(/\/$/, "").split("/").pop()?.replace(/\.git$/, "")
  return { ...result, path: result.ok && leaf ? join(parentDir, leaf) : null }
}

export async function scmPublish(params: { cwd?: unknown; name?: unknown; visibility?: unknown }): Promise<ScmCreatePrResult> {
  const cwd = validDirectory(params?.cwd)
  if (!cwd) return { ...invalidCommand(), url: null }
  if (typeof params?.name !== "string" || !params.name.trim()) return { ok: false, url: null, output: "A repository name is required" }
  if (params.visibility !== "public" && params.visibility !== "private") return { ok: false, url: null, output: "Visibility must be public or private" }
  const scm = await info(cwd)
  if (scm.provider && scm.provider !== "github") return { ok: false, url: null, output: scm.provider === "bitbucket" || scm.provider === "azure" ? UNSUPPORTED : "Publishing is currently supported only for GitHub" }
  if (!Bun.which("gh")) return { ok: false, url: null, output: "gh is not available on PATH" }
  const result = await command(["gh", "repo", "create", params.name, `--${params.visibility}`, "--source=.", "--push"], cwd)
  return { ...result, url: result.ok ? urlFrom(result.output) : null }
}
