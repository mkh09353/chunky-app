import type { SessionSummary } from "@chunky/protocol"
import { QueueFullError, createSession, interruptSession, renameSession, sendMessage, setGoal, shipSession } from "../api"

export interface VoiceToolContext {
  baseUrl: string
  getRepos(): Promise<{ id: string; name: string; path: string }[]>
  getSessions(repoId?: string | null): Promise<SessionSummary[]>
  dispatchAppAction(action: { type: "select-repo"; repoId: string } | { type: "select-session"; sessionId: string } | { type: "new-session" }): void
  refresh(): void
}

export type VoiceToolCall = { name: string; callId: string; args: Record<string, unknown> }
export type VoiceTool = { type: "function"; name: string; description: string; parameters: Record<string, unknown> }
const object = { type: "object", properties: {}, additionalProperties: false }
const string = { type: "string" }
const delivery = { type: "string", enum: ["queue", "interject", "steer"] }

export const voiceTools: VoiceTool[] = [
  { type: "function", name: "list_repos", description: "List coding repositories available in Chunky.", parameters: object },
  { type: "function", name: "list_threads", description: "List threads in a repository, optionally named by the user.", parameters: { ...object, properties: { repo_name: string } } },
  { type: "function", name: "create_thread", description: "Create a coding thread in a repository and give it a prompt.", parameters: { ...object, required: ["repo_name", "prompt"], properties: { repo_name: string, prompt: string, title: string } } },
  { type: "function", name: "send_to_thread", description: "Send work to a named coding thread.", parameters: { ...object, required: ["thread_query", "text"], properties: { thread_query: string, text: string, delivery } } },
  { type: "function", name: "thread_status", description: "Check whether a coding thread is working or idle.", parameters: { ...object, required: ["thread_query"], properties: { thread_query: string } } },
  { type: "function", name: "interrupt_thread", description: "Stop the active work in a coding thread.", parameters: { ...object, required: ["thread_query"], properties: { thread_query: string } } },
  { type: "function", name: "rename_thread", description: "Rename a coding thread.", parameters: { ...object, required: ["thread_query", "new_title"], properties: { thread_query: string, new_title: string } } },
  { type: "function", name: "set_thread_goal", description: "Set an autonomous goal for a coding thread.", parameters: { ...object, required: ["thread_query", "objective"], properties: { thread_query: string, objective: string } } },
  { type: "function", name: "ship_thread", description: "Ship a thread's plan to a fresh goal thread.", parameters: { ...object, required: ["thread_query"], properties: { thread_query: string, notes: string } } },
  { type: "function", name: "open_in_app", description: "Open a named repository or thread in the Chunky app.", parameters: { ...object, required: ["target"], properties: { target: string } } },
]

function text(value: unknown): string { return typeof value === "string" ? value.trim() : "" }
/** Case-insensitive subsequence scoring supports spoken fragments without dependencies. */
export function fuzzyMatch<T>(query: string, values: T[], label: (value: T) => string): T | undefined {
  const q = query.toLowerCase().trim()
  if (!q) return undefined
  let best: T | undefined; let bestScore = -1
  for (const value of values) {
    const candidate = label(value).toLowerCase()
    const direct = candidate.indexOf(q)
    let score = direct >= 0 ? 10_000 - direct : 0
    if (direct < 0) {
      let at = 0
      for (const char of q) { at = candidate.indexOf(char, at); if (at < 0) break; at += 1; score += 1 }
      if (score !== q.length) continue
    }
    if (score > bestScore) { best = value; bestScore = score }
  }
  return best
}

async function allSessions(ctx: VoiceToolContext): Promise<SessionSummary[]> {
  const repos = await ctx.getRepos()
  const groups = await Promise.all(repos.map((repo) => ctx.getSessions(repo.id)))
  return groups.flat()
}
async function resolveThread(ctx: VoiceToolContext, query: string): Promise<SessionSummary | undefined> {
  const sessions = await allSessions(ctx)
  if (/^(current|latest|recent)$/i.test(query.trim())) return sessions.sort((a, b) => b.lastActivity - a.lastActivity)[0]
  return fuzzyMatch(query, sessions, (session) => `${session.title} ${session.sessionId}`)
}
function label(name: string): string { return name.replaceAll("_", " ") }

export async function executeVoiceTool(ctx: VoiceToolContext, call: VoiceToolCall): Promise<Record<string, unknown>> {
  try {
    const args = call.args
    if (call.name === "list_repos") return { repos: await ctx.getRepos() }
    if (call.name === "list_threads") {
      const repos = await ctx.getRepos(); const repo = text(args.repo_name) ? fuzzyMatch(text(args.repo_name), repos, (r) => r.name) : undefined
      if (text(args.repo_name) && !repo) return { error: `Repository not found: ${text(args.repo_name)}` }
      const sessions = repo ? await ctx.getSessions(repo.id) : await allSessions(ctx)
      return { threads: sessions.map((s) => ({ sessionId: s.sessionId, title: s.title, status: s.running ? "running" : "idle", lastActivity: s.lastActivity })) }
    }
    if (call.name === "create_thread") {
      const repos = await ctx.getRepos(); const repo = fuzzyMatch(text(args.repo_name), repos, (r) => r.name)
      const prompt = text(args.prompt); if (!repo || !prompt) return { error: !repo ? "Repository not found." : "A prompt is required." }
      const created = await createSession(ctx.baseUrl, repo.id)
      if (text(args.title)) await renameSession(ctx.baseUrl, created.sessionId, text(args.title))
      const blocked = await sendMessage(ctx.baseUrl, created.sessionId, prompt)
      if (blocked) return { error: "The prompt was blocked by the cache guard.", blocked }
      ctx.dispatchAppAction({ type: "select-session", sessionId: created.sessionId }); ctx.refresh()
      return { ok: true, sessionId: created.sessionId, title: text(args.title) || "New session" }
    }
    if (call.name === "open_in_app") {
      const target = text(args.target); const repos = await ctx.getRepos(); const repo = fuzzyMatch(target, repos, (r) => r.name)
      if (repo) { ctx.dispatchAppAction({ type: "select-repo", repoId: repo.id }); return { ok: true, opened: repo.name } }
      const thread = await resolveThread(ctx, target); if (!thread) return { error: `No repository or thread matches ${target}.` }
      ctx.dispatchAppAction({ type: "select-session", sessionId: thread.sessionId }); return { ok: true, opened: thread.title }
    }
    const thread = await resolveThread(ctx, text(args.thread_query))
    if (!thread) return { error: `Thread not found: ${text(args.thread_query)}` }
    if (call.name === "thread_status") return { sessionId: thread.sessionId, title: thread.title, status: thread.running ? "running" : "idle", lastActivity: thread.lastActivity }
    if (call.name === "interrupt_thread") { await interruptSession(ctx.baseUrl, thread.sessionId); ctx.refresh(); return { ok: true, title: thread.title } }
    if (call.name === "rename_thread") { const title = text(args.new_title); if (!title) return { error: "A new title is required." }; await renameSession(ctx.baseUrl, thread.sessionId, title); ctx.refresh(); return { ok: true, title } }
    if (call.name === "set_thread_goal") { const objective = text(args.objective); if (!objective) return { error: "An objective is required." }; const goal = await setGoal(ctx.baseUrl, thread.sessionId, { objective }); return { ok: true, goal } }
    if (call.name === "ship_thread") { await shipSession(ctx.baseUrl, thread.sessionId, text(args.notes) || undefined); return { ok: true, title: thread.title } }
    if (call.name === "send_to_thread") {
      const requested = text(args.delivery); const mode = requested === "queue" || requested === "interject" || requested === "steer" ? requested : undefined
      const blocked = await sendMessage(ctx.baseUrl, thread.sessionId, text(args.text), mode ? { delivery: mode } : {})
      if (blocked) return { error: "The prompt was blocked by the cache guard.", blocked }
      return { ok: true, title: thread.title }
    }
    return { error: `Unknown voice tool: ${label(call.name)}` }
  } catch (error) {
    return { error: error instanceof QueueFullError ? error.message : error instanceof Error ? error.message : "Voice tool failed." }
  }
}
