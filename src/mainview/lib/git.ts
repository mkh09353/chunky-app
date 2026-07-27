// Typed renderer bridge for native Git/source-control operations. These are
// deliberately app-local RPC contracts, not Chunky server protocol types.
import { getRpc, nativeRpcAvailable } from "./rpc"

export type GitFile = { path: string; status: string }
export type GitStatus = { isRepo: boolean; branch: string; upstream: string | null; ahead: number; behind: number; staged: GitFile[]; unstaged: GitFile[]; untracked: string[] }
export type GitBranches = { current: string; local: string[]; remote: string[]; worktrees: { path: string; branch: string }[] }
export type CommandResult = { ok: boolean; output: string }
export type ScmProvider = "github" | "gitlab" | "bitbucket" | "azure"
export type ScmInfo = { provider: ScmProvider | null; remoteUrl: string | null; cliAvailable: boolean; cliName: string | null }
export type ScmPr = { number: number; title: string; url: string; state: string; headBranch: string; author: string }
export type ScmCreatePrResult = CommandResult & { url: string | null }
export type ScmListPrsResult = CommandResult & { prs: ScmPr[] }
export type ScmCloneResult = CommandResult & { path: string | null }

const noStatus = (): GitStatus => ({ isRepo: false, branch: "", upstream: null, ahead: 0, behind: 0, staged: [], unstaged: [], untracked: [] })
const noBranches = (): GitBranches => ({ current: "", local: [], remote: [], worktrees: [] })
const unavailable = (): CommandResult => ({ ok: false, output: "Native Git RPC is unavailable" })
async function call<T>(name: string, params: object, fallback: T): Promise<T> {
  if (!nativeRpcAvailable()) return fallback
  const rpc = await getRpc(); const fn = rpc?.request?.[name]
  if (!fn) return fallback
  try { return await fn(params) as T } catch { return fallback }
}

export async function gitStatus(params: { cwd: string }): Promise<GitStatus> { return call("gitStatus", params, noStatus()) }
export async function gitBranches(params: { cwd: string }): Promise<GitBranches> { return call("gitBranches", params, noBranches()) }
export async function gitStage(params: { cwd: string; paths: string[] }): Promise<CommandResult> { return call("gitStage", params, unavailable()) }
export async function gitUnstage(params: { cwd: string; paths: string[] }): Promise<CommandResult> { return call("gitUnstage", params, unavailable()) }
export async function gitCommit(params: { cwd: string; message: string; stageAll: boolean }): Promise<CommandResult> { return call("gitCommit", params, unavailable()) }
export async function gitSwitch(params: { cwd: string; branch: string; create?: boolean }): Promise<CommandResult> { return call("gitSwitch", params, unavailable()) }
export async function gitPull(params: { cwd: string }): Promise<CommandResult> { return call("gitPull", params, unavailable()) }
export async function gitPush(params: { cwd: string; setUpstream: boolean }): Promise<CommandResult> { return call("gitPush", params, unavailable()) }
export async function scmInfo(params: { cwd: string }): Promise<ScmInfo> { return call("scmInfo", params, { provider: null, remoteUrl: null, cliAvailable: false, cliName: null }) }
export async function scmCreatePr(params: { cwd: string; title: string; body?: string; draft?: boolean; base?: string }): Promise<ScmCreatePrResult> { return call("scmCreatePr", params, { ...unavailable(), url: null }) }
export async function scmListPrs(params: { cwd: string }): Promise<ScmListPrsResult> { return call("scmListPrs", params, { ...unavailable(), prs: [] }) }
export async function scmCheckoutPr(params: { cwd: string; number: number }): Promise<CommandResult> { return call("scmCheckoutPr", params, unavailable()) }
export async function scmClone(params: { url: string; parentDir: string }): Promise<ScmCloneResult> { return call("scmClone", params, { ...unavailable(), path: null }) }
export async function scmPublish(params: { cwd: string; name: string; visibility: "public" | "private" }): Promise<ScmCreatePrResult> { return call("scmPublish", params, { ...unavailable(), url: null }) }
