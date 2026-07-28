// Typed HTTP + SSE client for the local Chunky server.
// Shapes and routes come from @chunky/protocol — do not fork them.
import {
  ROUTES,
  readSSE,
  type AgentEvent,
  type CreateSessionRequest,
  type CreateSessionResponse,
  type ListSessionsResponse,
  type MessageDelivery,
  type FileSearchItem,
  type ReposResponse,
  type SendBlockedResponse,
  type ServerInfoResponse,
  type SessionSummary,
  type ForkResponse, type GoalRequest, type GoalSnapshot, type RewindPoint,
} from "@chunky/protocol"

export type {
  MessageDelivery,
  Repo,
  ReposResponse,
  SendBlockedResponse,
  SessionSummary,
} from "@chunky/protocol"

export interface AppConfig {
  baseUrl: string
  /** Present for auth; never log or render. */
  serverToken?: string
  workspace: string
  /** Bun-side startup/discovery failure safe to show in the connection banner. */
  connectionError?: string
}

export interface ModelSelection {
  provider: string
  model: string | null
  effort?: string | null
  speed?: string | null
}

export interface ModelRow {
  provider: string
  ready: boolean
  model: {
    id: string
    name: string
    reasoning: boolean
    contextLimit?: number
    custom?: boolean
    verified?: boolean
  }
}

export interface ProviderRow {
  id: string
  label: string
  ready: boolean
  active: boolean
}

declare const __CHUNKY_BASE_URL__: string | undefined
declare const __CHUNKY_TOKEN__: string | undefined

import { getRpc } from "./rpc"

const DEFAULT_BASE =
  (typeof __CHUNKY_BASE_URL__ !== "undefined" && __CHUNKY_BASE_URL__) ||
  "http://localhost:4620"

const DEFAULT_CONFIG: AppConfig = {
  baseUrl: DEFAULT_BASE,
  workspace: "",
}

let fetchInstalled = false

/** Install a once-only fetch wrapper that attaches the bearer token. Never logs it. */
function installAuthFetch(token?: string): void {
  if (fetchInstalled || !token) return
  fetchInstalled = true
  const original = globalThis.fetch
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers)
    if (!headers.has("Authorization")) {
      headers.set("Authorization", `Bearer ${token}`)
    }
    return original(input, { ...init, headers })
  }) as typeof fetch
}

export async function loadConfig(): Promise<AppConfig> {
  // When the renderer is loaded from Vite, always use its authenticated
  // same-origin proxy. This applies to both a normal browser and Electrobun's
  // HMR webview; letting the native RPC override it would send the webview
  // directly to :4620, where WebKit rejects JSON responses missing CORS.
  if (
    typeof window !== "undefined" &&
    (window.location.origin === "http://localhost:5173" ||
      window.location.origin === "http://127.0.0.1:5173")
  ) {
    return { baseUrl: "/chunky-api", workspace: DEFAULT_CONFIG.workspace }
  }

  // Inside electrobun, prefer bun-side config (real URL + token from settings).
  try {
    const rpc = await getRpc()
    const fn = rpc?.request?.getConfig
    if (fn) {
      const data = (await fn()) as Partial<AppConfig> | null
      if (data?.baseUrl) {
        installAuthFetch(data.serverToken)
        return {
          baseUrl: data.baseUrl,
          serverToken: data.serverToken,
          workspace: data.workspace || DEFAULT_CONFIG.workspace,
          connectionError: data.connectionError,
        }
      }
    }
  } catch {
    /* fall through */
  }

  // Vite define injection (dev + production web build).
  const injectedToken =
    typeof __CHUNKY_TOKEN__ !== "undefined" && __CHUNKY_TOKEN__ ? __CHUNKY_TOKEN__ : undefined
  installAuthFetch(injectedToken)

  try {
    const res = await fetch("/chunky-config.json", { cache: "no-store" })
    if (res.ok) {
      const data = (await res.json()) as Partial<AppConfig>
      // Never require a token in this static file; Vite define covers auth.
      return {
        baseUrl: data.baseUrl || DEFAULT_CONFIG.baseUrl,
        serverToken: injectedToken,
        workspace: data.workspace || DEFAULT_CONFIG.workspace,
      }
    }
  } catch {
    /* fall through */
  }

  return {
    baseUrl: DEFAULT_CONFIG.baseUrl,
    serverToken: injectedToken,
    workspace: DEFAULT_CONFIG.workspace,
  }
}

export async function fetchServerInfo(baseUrl: string): Promise<ServerInfoResponse> {
  if (!baseUrl) throw new Error("Chunky server is unavailable")
  const res = await fetch(baseUrl + ROUTES.serverInfo)
  if (!res.ok) throw new Error(`server info failed (${res.status})`)
  return (await res.json()) as ServerInfoResponse
}

export async function listSessions(
  baseUrl: string,
  repoId?: string | null,
): Promise<SessionSummary[]> {
  const path = baseUrl.replace(/\/$/, "") + ROUTES.listSessions
  const url =
    path.startsWith("http://") || path.startsWith("https://")
      ? new URL(path)
      : new URL(path, typeof window !== "undefined" ? window.location.origin : "http://localhost")
  if (repoId) url.searchParams.set("repo", repoId)
  const res = await fetch(url)
  if (!res.ok) throw new Error(`list sessions failed (${res.status})`)
  const data = (await res.json()) as ListSessionsResponse
  const sessions = data.sessions ?? []
  return sessions.slice().sort((a, b) => b.lastActivity - a.lastActivity)
}

// ---- Repos (workspaces) ---------------------------------------------------

export async function listRepos(baseUrl: string): Promise<ReposResponse> {
  const res = await fetch(baseUrl + ROUTES.repos)
  if (!res.ok) throw new Error(`list repos failed (${res.status})`)
  return (await res.json()) as ReposResponse
}

/** Add a folder as a repo; server also makes it the default. */
export async function addRepo(baseUrl: string, path: string): Promise<ReposResponse> {
  const res = await fetch(baseUrl + ROUTES.repos, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  })
  const data = (await res.json().catch(() => ({}))) as ReposResponse & { error?: string }
  if (!res.ok) throw new Error(data.error || `add repo failed (${res.status})`)
  return data
}

/** Remove a repo registration only — never deletes files on disk. */
export async function removeRepo(baseUrl: string, id: string): Promise<ReposResponse> {
  const res = await fetch(baseUrl + ROUTES.removeRepo(id), { method: "DELETE" })
  const data = (await res.json().catch(() => ({}))) as ReposResponse & { error?: string }
  if (!res.ok) throw new Error(data.error || `remove repo failed (${res.status})`)
  return data
}

export interface CreatedSession {
  sessionId: string
  incognito: boolean
}

/** `cwd` pins the session to an arbitrary directory (it wins over `repoId`
 *  server-side) — used by the clone bootstrap session, which has to run in a
 *  folder that is not a registered repo yet. */
export async function createSession(
  baseUrl: string,
  repoId?: string | null,
  cwd?: string | null,
): Promise<CreatedSession> {
  const body: CreateSessionRequest = {
    ...(repoId ? { repoId } : {}),
    ...(cwd ? { cwd } : {}),
  }
  const res = await fetch(baseUrl + ROUTES.createSession, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`create session failed (${res.status})`)
  const data = (await res.json()) as CreateSessionResponse & { incognito?: boolean }
  return { sessionId: data.sessionId, incognito: data.incognito === true }
}

export class QueueFullError extends Error {
  constructor(
    message = "Chunky's prompt queue is full — wait for it to work through the queued messages, then send this again.",
  ) {
    super(message)
    this.name = "QueueFullError"
  }
}

export async function sendMessage(
  baseUrl: string,
  sessionId: string,
  text: string,
  opts: {
    force?: boolean
    delivery?: MessageDelivery
    images?: { base64: string; mediaType: string }[]
  } = {},
): Promise<SendBlockedResponse | null> {
  const res = await fetch(baseUrl + ROUTES.sendMessage(sessionId), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text,
      ...(opts.force ? { force: true } : {}),
      ...(opts.delivery && opts.delivery !== "auto" ? { delivery: opts.delivery } : {}),
      ...(opts.images?.length ? { images: opts.images } : {}),
    }),
  })
  if (res.status === 409) {
    return (await res.json()) as SendBlockedResponse
  }
  if (res.status === 429) {
    throw new QueueFullError()
  }
  if (!res.ok && res.status !== 202) {
    throw new Error(`send message failed (${res.status})`)
  }
  return null
}

/** Fuzzy file/directory search used by the composer @-mention menu. */
export async function searchFiles(
  baseUrl: string,
  query: string,
  repoId?: string | null,
): Promise<FileSearchItem[]> {
  const url = new URL(baseUrl + ROUTES.fileSearch, window.location.origin)
  url.searchParams.set("q", query)
  url.searchParams.set("limit", "12")
  if (repoId) url.searchParams.set("repo", repoId)
  const res = await fetch(url)
  if (!res.ok) throw new Error(`file search failed (${res.status})`)
  const body = (await res.json()) as { items?: FileSearchItem[] }
  return body.items ?? []
}

export async function interruptSession(baseUrl: string, sessionId: string): Promise<void> {
  await fetch(baseUrl + ROUTES.interrupt(sessionId), { method: "POST" }).catch(() => {})
}

async function jsonRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init)
  const body = await res.json().catch(() => ({})) as T & { error?: string }
  if (!res.ok) throw new Error(body.error || `request failed (${res.status})`)
  return body
}
export const renameSession = (baseUrl: string, id: string, title: string) => jsonRequest<SessionSummary>(baseUrl + ROUTES.renameSession(id), { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title }) })
export const forkSession = (baseUrl: string, id: string, body: { worktree?: boolean; directive?: string }) => jsonRequest<ForkResponse>(baseUrl + ROUTES.fork(id), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
export const getRewindPoints = async (baseUrl: string, id: string) => (await jsonRequest<{ points: RewindPoint[] }>(baseUrl + ROUTES.rewindPoints(id))).points
export const rewindSession = (baseUrl: string, id: string, turn: number) => jsonRequest(baseUrl + ROUTES.rewind(id), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ turn }) })
export const getGoal = async (baseUrl: string, id: string) => (await jsonRequest<{ goal: GoalSnapshot | null }>(baseUrl + ROUTES.goal(id))).goal
export const setGoal = async (baseUrl: string, id: string, body: GoalRequest) => (await jsonRequest<{ goal: GoalSnapshot | null }>(baseUrl + ROUTES.goal(id), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).goal
export const shipSession = (baseUrl: string, id: string, notes?: string) => jsonRequest(baseUrl + ROUTES.ship(id), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(notes ? { notes } : {}) })
export const getUsage = (baseUrl: string, id: string) => jsonRequest<unknown>(`${baseUrl}/api/usage?session=${encodeURIComponent(id)}`)
export const getScoreboard = (baseUrl: string, id?: string) => jsonRequest<unknown>(`${baseUrl}/api/scoreboard${id ? `?session=${encodeURIComponent(id)}` : ""}`)

/**
 * Open a session's SSE stream. Resolves when the server closes it.
 * `onOpen` fires once the response is accepted (the only "connected" signal —
 * empty sessions send no events until the first turn).
 */
export async function openEventStream(
  baseUrl: string,
  sessionId: string,
  onEvent: (ev: AgentEvent) => void,
  signal?: AbortSignal,
  onOpen?: () => void,
): Promise<void> {
  const res = await fetch(baseUrl + ROUTES.events(sessionId), { signal })
  if (!res.ok) throw new Error(`events stream failed (${res.status})`)
  onOpen?.()
  for await (const ev of readSSE(res)) {
    if (signal?.aborted) break
    onEvent(ev)
  }
}

export async function fetchModel(baseUrl: string): Promise<ModelSelection | null> {
  try {
    const res = await fetch(baseUrl + "/api/model")
    if (!res.ok) return null
    return (await res.json()) as ModelSelection
  } catch {
    return null
  }
}

export async function listProviders(baseUrl: string): Promise<ProviderRow[]> {
  try {
    const res = await fetch(baseUrl + "/api/providers")
    if (!res.ok) return []
    const body = (await res.json()) as { providers?: ProviderRow[] }
    return body.providers ?? []
  } catch {
    return []
  }
}

export async function listAllModels(baseUrl: string): Promise<ModelRow[]> {
  const providers = await listProviders(baseUrl)
  const groups = await Promise.all(
    providers.map(async (p): Promise<ModelRow[]> => {
      try {
        const r = await fetch(baseUrl + `/api/providers/${p.id}/models`)
        if (!r.ok) return []
        const b = (await r.json()) as { models?: ModelRow["model"][] }
        return (b.models ?? []).map((model) => ({ provider: p.id, ready: p.ready, model }))
      } catch {
        return []
      }
    }),
  )
  return groups.flat()
}

export async function selectModel(
  baseUrl: string,
  payload: { provider: string; model: string; effort?: string; speed?: string },
): Promise<ModelSelection> {
  const res = await fetch(baseUrl + "/api/model/select", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  })
  const data = (await res.json().catch(() => ({}))) as ModelSelection & { error?: string }
  if (!res.ok || data.error) throw new Error(data.error || `select model failed (${res.status})`)
  return data
}

/** Pretty-print a model id for the picker label. */
export function prettyModel(id: string | null | undefined): string {
  if (!id) return "…"
  const ACRONYMS = new Set(["glm", "gpt", "api", "llm"])
  return id
    .replace(/\[.*?\]/g, "")
    .split(/[-_]/)
    .filter(Boolean)
    .map((p) =>
      ACRONYMS.has(p.toLowerCase())
        ? p.toUpperCase()
        : /^[\d.]+$/.test(p)
          ? p
          : p[0]!.toUpperCase() + p.slice(1),
    )
    .join(" ")
}

/** Split a UI model key `provider/model-id` on the first slash only. */
export function splitModelKey(id: string): { provider: string; model: string } | null {
  const slash = id.indexOf("/")
  if (slash <= 0 || slash === id.length - 1) return null
  return { provider: id.slice(0, slash), model: id.slice(slash + 1) }
}

/** Human label for a provider id. */
export function providerLabel(id: string | null | undefined): string {
  if (!id) return "Provider"
  const known: Record<string, string> = {
    anthropic: "Anthropic",
    codex: "Codex",
    grok: "Grok",
    zen: "Zen",
  }
  return known[id.toLowerCase()] ?? id[0]!.toUpperCase() + id.slice(1)
}
