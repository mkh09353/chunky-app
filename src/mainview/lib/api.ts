// Typed HTTP + SSE client for the local Chunky server.
// Shapes and routes come from @chunky/protocol — do not fork them.
import {
  ROUTES,
  readSSE,
  readSessionEventStream,
  sessionEventsUrl,
  type AgentEvent,
  type AppBrowserAnnounce,
  type AppBrowserEndpoint,
  type AppBrowserResponse,
  type AppZooAnnounce,
  type AppZooResponse,
  type CreateSessionRequest,
  type CreateSessionResponse,
  type ListSessionsResponse,
  type MessageDelivery,
  type FileSearchItem,
  type PromoteQueueRequest,
  type PromoteQueueResult,
  type QueueEntry,
  type ReposResponse,
  type SendBlockedResponse,
  type ServerInfoResponse,
  type SessionDelta,
  type SessionHistoryRequest,
  type SessionHistoryResponse,
  type SessionSummary,
  type ShellSessionsResponse,
  type StopDelegateRequest,
  type StopDelegateResponse,
  type TodoSnapshot,
  type ForkResponse, type GoalRequest, type GoalSnapshot, type RewindPoint,
} from "@chunky/protocol"
import { readNamedSSE } from "./sse"
import type { SessionStreamFrame } from "./sessionStream"

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
  installedRuntime?: { version: string; buildId: string } | null
  /** Bun-side startup/discovery failure safe to show in the connection banner. */
  connectionError?: string
  /**
   * How this renderer resolved the server. `vite-proxy` is plain Vite / HMR
   * (`dev:web`): requests go through `/chunky-api`, not packaged discovery.
   */
  connectionSource?: "vite-proxy" | "native" | "static"
  /**
   * Safe http(s) URL of the Vite proxy target (CHUNKY_URL). Host:port only is
   * derived for chrome; never a token, settings path, or DB path.
   */
  proxyTarget?: string
}

export interface ModelSelection {
  provider: string
  model: string | null
  effort?: string | null
  speed?: string | null
  /** SOLO: this selection runs the model alone — the server suppresses the
   *  sidekick, named seats, the reviewer and the mode advisor, and only the
   *  opt-in solo advisor may run. */
  solo?: boolean
  /** Session reads only: true when this value is pinned rather than inherited. */
  pinned?: boolean
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
import { configuredProxyTarget, isViteDevOrigin } from "./connectionSource"

const DEFAULT_BASE =
  (typeof __CHUNKY_BASE_URL__ !== "undefined" && __CHUNKY_BASE_URL__) ||
  "http://localhost:4620"

const DEFAULT_CONFIG: AppConfig = {
  baseUrl: DEFAULT_BASE,
  workspace: "",
}

let fetchInstalled = false
// Held separately from the wrapper so re-resolving onto another server can swap
// the credential without stacking a second fetch wrapper.
let authToken: string | undefined

/** Install a once-only fetch wrapper that attaches the bearer token. Never logs it. */
function installAuthFetch(token?: string): void {
  if (token) authToken = token
  if (fetchInstalled || !authToken) return
  fetchInstalled = true
  const original = globalThis.fetch
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers)
    if (authToken && !headers.has("Authorization")) {
      headers.set("Authorization", `Bearer ${authToken}`)
    }
    return original(input, { ...init, headers })
  }) as typeof fetch
}

/**
 * Ask Bun to resolve the server again (see src/bun/connectionManager
 * refreshChunkyConnection) and adopt the result — the app moves onto a
 * replacement server after its own was superseded or died. Without the native
 * bridge (plain browser build) this is just loadConfig.
 */
export async function reresolveConfig(): Promise<AppConfig> {
  // Vite/HMR must keep the same-origin proxy even after a reconnect.
  if (typeof window !== "undefined" && isViteDevOrigin(window.location.origin)) {
    return withViteProxy({ baseUrl: "/chunky-api", workspace: DEFAULT_CONFIG.workspace })
  }
  try {
    const rpc = await getRpc()
    const fn = rpc?.request?.chunkyReconnect
    if (fn) {
      const data = (await fn()) as Partial<AppConfig> | null
      if (data?.baseUrl) {
        installAuthFetch(data.serverToken)
        return withNativeConfig(data)
      }
      if (data?.connectionError) {
        return { ...DEFAULT_CONFIG, baseUrl: "", connectionError: data.connectionError, connectionSource: "native" }
      }
    }
  } catch {
    /* fall through to a plain resolve */
  }
  return loadConfig()
}

/** Does this server say it is retiring (draining after being superseded)?
 *  Unauthenticated launcher metadata; false whenever it cannot be determined. */
export async function fetchServerRetiring(baseUrl: string): Promise<boolean> {
  if (!baseUrl) return false
  try {
    const res = await fetch(`${baseUrl}/_chunky/server-identity`, {
      signal: AbortSignal.timeout(2_000),
    })
    if (!res.ok) return false
    const identity = (await res.json()) as { retiring?: unknown }
    return identity?.retiring === true
  } catch {
    return false
  }
}


function withViteProxy(config: AppConfig): AppConfig {
  return {
    ...config,
    connectionSource: "vite-proxy",
    proxyTarget: configuredProxyTarget() || "http://localhost:4620",
  }
}

function withNativeConfig(data: Partial<AppConfig>): AppConfig {
  return {
    baseUrl: data.baseUrl || "",
    serverToken: data.serverToken,
    workspace: data.workspace || DEFAULT_CONFIG.workspace,
    installedRuntime: data.installedRuntime,
    connectionError: data.connectionError,
    connectionSource: "native",
  }
}

export async function loadConfig(): Promise<AppConfig> {
  // When the renderer is loaded from Vite, always use its authenticated
  // same-origin proxy. This applies to both a normal browser and Electrobun's
  // HMR webview; letting the native RPC override it would send the webview
  // directly to :4620, where WebKit rejects JSON responses missing CORS.
  if (typeof window !== "undefined" && isViteDevOrigin(window.location.origin)) {
    // Keep the authenticated same-origin proxy. Native RPC must not override
    // this: WebKit rejects CORS-less JSON from a direct :4620 fetch.
    return withViteProxy({ baseUrl: "/chunky-api", workspace: DEFAULT_CONFIG.workspace })
  }

  // Inside electrobun, prefer bun-side config (real URL + token from settings).
  try {
    const rpc = await getRpc()
    const fn = rpc?.request?.getConfig
    if (fn) {
      const data = (await fn()) as Partial<AppConfig> | null
      if (data?.baseUrl) {
        installAuthFetch(data.serverToken)
        return withNativeConfig(data)
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
        installedRuntime: data.installedRuntime,
        connectionSource: "static",
      }
    }
  } catch {
    /* fall through */
  }

  return {
    baseUrl: DEFAULT_CONFIG.baseUrl,
    serverToken: injectedToken,
    workspace: DEFAULT_CONFIG.workspace,
    connectionSource: "static",
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
  scope?: "none",
): Promise<SessionSummary[]> {
  const path = baseUrl.replace(/\/$/, "") + ROUTES.listSessions
  const url =
    path.startsWith("http://") || path.startsWith("https://")
      ? new URL(path)
      : new URL(path, typeof window !== "undefined" ? window.location.origin : "http://localhost")
  if (scope === "none") url.searchParams.set("scope", "none")
  else if (repoId) url.searchParams.set("repo", repoId)
  const res = await fetch(url)
  if (!res.ok) throw new Error(`list sessions failed (${res.status})`)
  const data = (await res.json()) as ListSessionsResponse
  const sessions = data.sessions ?? []
  return sessions.slice().sort((a, b) => b.lastActivity - a.lastActivity)
}

export interface SessionStreamHandlers {
  /** The full cross-repository session list; sent once, first. */
  onSnapshot: (sessions: SessionSummary[]) => void
  /** Debounced (~250ms server-side) upserts/removals after the snapshot. */
  onDelta: (delta: SessionDelta) => void
  /** Fires once the stream is accepted — the snapshot follows immediately. */
  onOpen?: () => void
}

export class SessionHistoryUnsupported extends Error {
  constructor() {
    super("session history tail is unsupported")
    this.name = "SessionHistoryUnsupported"
  }
}

export class SessionHistoryRewritten extends Error {
  constructor(readonly cursor: SessionHistoryResponse["cursor"]) {
    super("session history was rewritten")
    this.name = "SessionHistoryRewritten"
  }
}

/** Fetch a bounded transcript tail or older page. Authentication is supplied
 * by the renderer's shared fetch wrapper installed during connection setup. */
export async function fetchSessionHistory(
  baseUrl: string,
  sessionId: string,
  request: SessionHistoryRequest = {},
): Promise<SessionHistoryResponse> {
  const path = baseUrl.replace(/\/$/, "") + ROUTES.sessionHistory(sessionId)
  const url = path.startsWith("http://") || path.startsWith("https://")
    ? new URL(path)
    : new URL(path, typeof window !== "undefined" ? window.location.origin : "http://localhost")
  if (request.turns != null) url.searchParams.set("turns", String(request.turns))
  if (request.before) url.searchParams.set("before", request.before)
  const res = await fetch(url)
  if (res.status === 404) throw new SessionHistoryUnsupported()
  if (res.status === 409) {
    const body = await res.json().catch(() => null) as { cursor?: SessionHistoryResponse["cursor"] } | null
    if (body?.cursor) throw new SessionHistoryRewritten(body.cursor)
  }
  if (!res.ok) throw new Error(`session history failed (${res.status})`)
  return await res.json() as SessionHistoryResponse
}

/** Current checklist snapshot; unlike transcript history this remains complete
 * when a cold attachment starts from a bounded tail. */
export async function fetchSessionTodos(baseUrl: string, sessionId: string): Promise<TodoSnapshot[]> {
  const res = await fetch(baseUrl.replace(/\/$/, "") + ROUTES.todos(sessionId))
  if (!res.ok) throw new Error(`session todos failed (${res.status})`)
  return await res.json() as TodoSnapshot[]
}

/**
 * Subscribe to server-pushed session summaries (ROUTES.sessionStream).
 *
 * This replaces polling `listSessions` on a timer: the server debounces state
 * changes at 250ms, so a background session finishing is visible in the sidebar
 * (and to the unread/horn rules) within a quarter second instead of up to five.
 *
 * Current servers put `busy` on these rows as well as `running`; older ones
 * send `running` only. Callers fold them onto known state with
 * lib/sessionSummaries, which trusts a stated `busy` and confirms an absent one
 * with a targeted poll. Resolves when the server closes the stream; throws when
 * the route is missing (older server) so the caller can fall back to polling.
 */
export async function openSessionStream(
  baseUrl: string,
  handlers: SessionStreamHandlers,
  signal?: AbortSignal,
): Promise<void> {
  if (!baseUrl) throw new Error("Chunky server is unavailable")
  const res = await fetch(baseUrl + ROUTES.sessionStream, { signal })
  if (!res.ok) throw new Error(`session stream failed (${res.status})`)
  handlers.onOpen?.()
  for await (const frame of readNamedSSE(res, signal)) {
    if (signal?.aborted) break
    let payload: unknown
    try {
      payload = JSON.parse(frame.data)
    } catch {
      continue
    }
    if (frame.event === "snapshot") {
      handlers.onSnapshot((payload as ShellSessionsResponse).sessions ?? [])
    } else if (frame.event === "delta") {
      const delta = payload as SessionDelta
      handlers.onDelta({ upsert: delta.upsert ?? [], remove: delta.remove ?? [] })
    }
  }
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
  repositoryScope?: "none",
): Promise<CreatedSession> {
  const body: CreateSessionRequest = {
    ...(repoId ? { repoId } : {}),
    ...(cwd ? { cwd } : {}),
    ...(repositoryScope ? { repositoryScope } : {}),
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
    skill?: string
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
      ...(opts.skill ? { skill: opts.skill } : {}),
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

// ---- Queued prompts ------------------------------------------------------
// A queued message is server state (an in-memory PromptQueue), so acting on one
// is a server round-trip: there is no client-side queue to mutate.

/** Remove a still-queued entry. `false` means the server no longer had it —
 *  the drainer already claimed it, so it is running and the chip is stale.
 *  That is a normal outcome, not an error, so it doesn't throw. */
export async function deleteQueueEntry(
  baseUrl: string,
  sessionId: string,
  entryId: string,
): Promise<{ removed: boolean }> {
  const res = await fetch(baseUrl + ROUTES.queueEntry(sessionId, entryId), { method: "DELETE" })
  if (res.status === 404) return { removed: false }
  if (!res.ok) throw new Error(`couldn't remove the queued message (${res.status})`)
  const data = (await res.json().catch(() => ({}))) as { removed?: boolean }
  return { removed: data.removed !== false }
}

/**
 * Claim a queued entry and re-deliver it as a steer/interjection.
 *
 * The claim is atomic server-side (PromptQueue.take), which is what makes this
 * safe: either this call owns the entry and the server delivers it, or the
 * queue drainer already did. The caller never has to remove-then-resend and
 * risk losing the text in between.
 */
export async function promoteQueueEntry(
  baseUrl: string,
  sessionId: string,
  entryId: string,
  delivery: PromoteQueueRequest["delivery"],
): Promise<PromoteQueueResult> {
  const res = await fetch(baseUrl + ROUTES.promoteQueueEntry(sessionId, entryId), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ delivery } satisfies PromoteQueueRequest),
  })
  if (!res.ok) throw new Error(`couldn't steer the queued message (${res.status})`)
  return (await res.json()) as PromoteQueueResult
}

export type { PromoteQueueResult, QueueEntry }

/** Fuzzy file/directory search used by the composer @-mention menu. */
export async function searchFiles(
  baseUrl: string,
  query: string,
  repoId?: string | null,
  limit = 12,
): Promise<FileSearchItem[]> {
  const url = new URL(baseUrl + ROUTES.fileSearch, window.location.origin)
  url.searchParams.set("q", query)
  url.searchParams.set("limit", String(Math.min(50, Math.max(1, limit))))
  if (repoId) url.searchParams.set("repo", repoId)
  const res = await fetch(url)
  if (!res.ok) throw new Error(`file search failed (${res.status})`)
  const body = (await res.json()) as { items?: FileSearchItem[] }
  return body.items ?? []
}

/**
 * Announce this app's browser pane as a remotely drivable CDP target.
 *
 * The server holds this in memory only (it dies with the server), so callers
 * must re-announce on every reconnect. Payload comes from the Bun process — see
 * src/bun/appBrowser.ts and src/mainview/lib/appBrowser.ts.
 */
export async function announceAppBrowser(
  baseUrl: string,
  body: AppBrowserAnnounce,
): Promise<AppBrowserEndpoint | null> {
  if (!baseUrl) throw new Error("Chunky server is unavailable")
  const res = await fetch(baseUrl + ROUTES.appBrowser, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  const data = (await res.json().catch(() => ({}))) as AppBrowserResponse & { error?: string }
  if (!res.ok) throw new Error(data.error || `announce app browser failed (${res.status})`)
  return data.browser ?? null
}

/**
 * Announce the app's local zoo (product-factory) service so the server can
 * expose `zoo_*` tools against this app's board.
 *
 * Same lifetime rules as announceAppBrowser: memory-only server-side, so every
 * reconnect re-announces. The token is passed straight through to the request
 * body — never store or log it (see lib/appZoo.ts).
 */
export async function announceAppZoo(
  baseUrl: string,
  body: AppZooAnnounce,
): Promise<boolean> {
  if (!baseUrl) throw new Error("Chunky server is unavailable")
  const res = await fetch(baseUrl + ROUTES.appZoo, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  const data = (await res.json().catch(() => ({}))) as AppZooResponse & { error?: string }
  if (!res.ok) throw new Error(data.error || `announce app zoo failed (${res.status})`)
  return data.connected === true
}

export async function interruptSession(baseUrl: string, sessionId: string): Promise<void> {
  await fetch(baseUrl + ROUTES.interrupt(sessionId), { method: "POST" }).catch(() => {})
}

/**
 * Cancel ONE delegate (a live sidekick brief or a detached spawn) without
 * touching the lead turn — POST ROUTES.stopDelegate.
 *
 * Three-way result, like the usage history routes: the endpoint is newer than
 * some servers this app talks to, so "this server doesn't have it" is a
 * first-class outcome the caller turns into one clean notice and a hidden
 * button, never an error banner.
 *
 * The subtlety this function exists for: 404 is THREE different answers.
 *
 *   · `{ outcome: "not-found" }` — that run is gone. A real answer; show it.
 *   · `{ error: "unknown session" }` — a capable server refusing this request
 *     (the sessions router 404s an unknown/archived id BEFORE reaching the
 *     stop-delegate branch). An error for this call only; the endpoint exists,
 *     so the button must NOT disappear.
 *   · a non-JSON body (older servers answer unmatched routes with a plain
 *     `not found` string) — the endpoint itself is absent: unsupported.
 *
 * 501 is likewise unsupported, and a 409 (`ambiguous`) is a normal answer whose
 * `message` is worth showing.
 */
export type StopDelegateResult =
  | { status: "ok"; response: StopDelegateResponse }
  | { status: "unsupported" }
  | { status: "error"; message: string }

function isStopDelegateResponse(body: unknown): body is StopDelegateResponse {
  const outcome = (body as { outcome?: unknown } | null)?.outcome
  return (
    outcome === "cancelled" ||
    outcome === "already-finished" ||
    outcome === "not-found" ||
    outcome === "ambiguous"
  )
}

/** Classify one stop-delegate HTTP result. Exported for tests: the status/body
 *  matrix is the whole compatibility contract. */
export function classifyStopDelegate(status: number, body: unknown): StopDelegateResult {
  if (status === 501) return { status: "unsupported" }
  if (isStopDelegateResponse(body)) return { status: "ok", response: body }
  // Only a 404/405 the server could not put a JSON body on is the route
  // missing. A JSON error body means a server that knows this route and is
  // refusing this particular call.
  const json = typeof body === "object" && body !== null ? (body as { error?: unknown }) : null
  if ((status === 404 || status === 405) && !json) return { status: "unsupported" }
  const message = json?.error
  return {
    status: "error",
    message: typeof message === "string" && message ? message : `stop delegate failed (${status})`,
  }
}

/**
 * Is Stop worth offering against `baseUrl`?
 *
 * Support is remembered as the ONE base URL that answered "no such endpoint",
 * not as a boolean: moving onto another server (a reconnect, or an in-place
 * upgrade that swaps the base URL without remounting the app) is therefore a
 * fresh start with no reset to remember to perform. Nothing is persisted.
 */
export function stopDelegateAvailable(
  baseUrl: string | null | undefined,
  unsupportedOn: string | null,
): boolean {
  if (!baseUrl) return false
  return unsupportedOn !== baseUrl
}

export async function stopDelegate(
  baseUrl: string,
  sessionId: string,
  target: StopDelegateRequest = {},
): Promise<StopDelegateResult> {
  if (!baseUrl) return { status: "error", message: "Chunky server is unavailable" }
  try {
    const res = await fetch(baseUrl + ROUTES.stopDelegate(sessionId), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(target),
    })
    return classifyStopDelegate(res.status, await res.json().catch(() => null))
  } catch (err) {
    return { status: "error", message: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Live status for a session's delegated runs (GET /api/sessions/:id/delegates).
 *
 * The SSE transcript is still the source of truth for what a delegate DID; this
 * endpoint answers the two things the stream cannot: how long a run has
 * actually been going (the protocol carries no start time on `thread.spawn`, so
 * lib/useRunClock can only time runs it watched start), and whether a run we
 * never saw settle is in fact finished.
 *
 * Same three-way result and the same literal path as the usage history above:
 * the route landed in the server at 0.3.63 and `@chunky/protocol` has no ROUTES
 * entry for it, so an older server must degrade to `unsupported` at runtime
 * rather than fail this build.
 *
 * 404 is read exactly the way stop-delegate reads it: a body the server could
 * not put JSON on is the route missing (unsupported), while a JSON `{ error }`
 * is a capable server refusing THIS call (the sessions router 404s an unknown
 * or archived session id before reaching the delegates branch) — an error for
 * this request only, which must not retire the endpoint.
 */
export interface DelegateRunStatus {
  kind: "sidekick" | "spawn_thread" | "workflow"
  /** Detached run id, when this run has one. */
  runId?: string
  /** The delegate's own thread id — how a RunRecord is matched to this row. */
  threadId: string
  seat?: string
  title: string
  status: "running" | "completed" | "failed" | "cancelled"
  elapsedMs: number
  result?: string
}

export type DelegatesResult =
  | { status: "ok"; runs: DelegateRunStatus[] }
  | { status: "unsupported" }
  | { status: "error"; message: string }

export interface DelegatesQuery {
  runId?: string
  seat?: string
  /** Long-poll budget, when the caller wants the server to wait for a change. */
  timeoutMs?: number
}

const DELEGATE_KINDS = new Set(["sidekick", "spawn_thread", "workflow"])
const DELEGATE_STATES = new Set(["running", "completed", "failed", "cancelled"])

/** One wire row → a typed status, or null when it is not one.
 *
 *  Malformed rows are dropped rather than failing the whole snapshot: a status
 *  poll is an enrichment, and one unknown row must not blank the others. */
function toDelegateRunStatus(row: unknown): DelegateRunStatus | null {
  if (typeof row !== "object" || row === null) return null
  const r = row as Record<string, unknown>
  const threadId = r.thread_id
  const kind = r.kind
  const state = r.status
  if (typeof threadId !== "string" || !threadId) return null
  if (typeof kind !== "string" || !DELEGATE_KINDS.has(kind)) return null
  if (typeof state !== "string" || !DELEGATE_STATES.has(state)) return null
  const elapsed = typeof r.elapsed_ms === "number" && Number.isFinite(r.elapsed_ms) ? r.elapsed_ms : 0
  return {
    kind: kind as DelegateRunStatus["kind"],
    threadId,
    status: state as DelegateRunStatus["status"],
    title: typeof r.title === "string" ? r.title : "",
    elapsedMs: elapsed,
    ...(typeof r.run_id === "string" && r.run_id ? { runId: r.run_id } : {}),
    ...(typeof r.seat === "string" && r.seat ? { seat: r.seat } : {}),
    ...(typeof r.result === "string" ? { result: r.result } : {}),
  }
}

/** Classify one delegates HTTP result. Exported for tests: the status/body
 *  matrix is the whole compatibility contract. */
export function classifyDelegatesResponse(status: number, body: unknown): DelegatesResult {
  if (status === 501) return { status: "unsupported" }
  const json = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : null
  if (status === 404 || status === 405) {
    // A JSON error body means a server that knows this route and is refusing
    // this particular call; anything else is the route itself being absent.
    if (json && typeof json.error === "string" && json.error) {
      return { status: "error", message: json.error }
    }
    return { status: "unsupported" }
  }
  if (status < 200 || status >= 300) {
    const message = json?.error
    return {
      status: "error",
      message:
        typeof message === "string" && message ? message : `delegate status failed (${status})`,
    }
  }
  // A 2xx with no usable body is "nothing running", not a crash.
  const rows = Array.isArray(json?.runs) ? (json.runs as unknown[]) : []
  const runs: DelegateRunStatus[] = []
  for (const row of rows) {
    const parsed = toDelegateRunStatus(row)
    if (parsed) runs.push(parsed)
  }
  return { status: "ok", runs }
}

/**
 * Is the delegates endpoint worth asking `baseUrl` about?
 *
 * Same rule as `stopDelegateAvailable`: support is remembered as the ONE base
 * URL that answered "no such endpoint", so a reconnect or an in-place upgrade
 * onto another base URL is a fresh start with no reset to remember. Nothing is
 * persisted.
 */
export function delegatesAvailable(
  baseUrl: string | null | undefined,
  unsupportedOn: string | null,
): boolean {
  if (!baseUrl) return false
  return unsupportedOn !== baseUrl
}

function delegatesQueryString(query: DelegatesQuery): string {
  const params = new URLSearchParams()
  if (query.runId) params.set("run_id", query.runId)
  if (query.seat) params.set("seat", query.seat)
  if (query.timeoutMs != null && Number.isFinite(query.timeoutMs)) {
    params.set("timeout_ms", String(Math.trunc(query.timeoutMs)))
  }
  const qs = params.toString()
  return qs ? `?${qs}` : ""
}

export async function getSessionDelegates(
  baseUrl: string,
  sessionId: string,
  query: DelegatesQuery = {},
): Promise<DelegatesResult> {
  if (!baseUrl) return { status: "error", message: "Chunky server is unavailable" }
  try {
    const res = await fetch(
      `${baseUrl}/api/sessions/${encodeURIComponent(sessionId)}/delegates${delegatesQueryString(query)}`,
    )
    return classifyDelegatesResponse(res.status, await res.json().catch(() => null))
  } catch (err) {
    return { status: "error", message: err instanceof Error ? err.message : String(err) }
  }
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
 * Usage history (/api/usage/series, /api/usage/breakdown).
 *
 * These routes are newer than some servers this app talks to, so "the server
 * doesn't have them" is a first-class outcome rather than an error: a 404/501
 * resolves to `unsupported` and the Usage page renders its explanatory state.
 * Bodies come back as `unknown` on purpose — lib/stats.ts owns the coercion.
 *
 * The paths are literals rather than ROUTES entries on purpose: the protocol
 * package only grew ROUTES.usageSeries/usageBreakdown in unlanded sibling work,
 * and a missing route should degrade to the unsupported state at runtime rather
 * than fail this build. Swap to ROUTES once that change ships (see lib/stats.ts).
 */
export type UsageQuery = {
  scope: "all" | "session"
  session?: string | null
  from: string
  to: string
}

export type UsageFetch =
  | { status: "ok"; body: unknown }
  | { status: "unsupported" }
  | { status: "error"; message: string }

function usageQueryString(query: UsageQuery): string {
  const params = new URLSearchParams({ scope: query.scope, from: query.from, to: query.to })
  // scope=session without a session id would ask the server for "this session"
  // with no referent; the caller is expected to pass one, but never send a
  // half-formed query if it didn't.
  if (query.scope === "session" && query.session) params.set("session", query.session)
  return params.toString()
}

async function usageRequest(baseUrl: string, path: string, query: UsageQuery): Promise<UsageFetch> {
  if (!baseUrl) return { status: "error", message: "Chunky server is unavailable" }
  try {
    const res = await fetch(`${baseUrl}${path}?${usageQueryString(query)}`)
    // 404 = route absent (old server); 501 = present but not implemented.
    if (res.status === 404 || res.status === 501) return { status: "unsupported" }
    const body = (await res.json().catch(() => null)) as { error?: string } | null
    if (!res.ok) {
      return { status: "error", message: body?.error || `request failed (${res.status})` }
    }
    // A 200 with an unparseable body is still "nothing to show", not a crash:
    // the stats parsers turn null into an empty payload.
    return { status: "ok", body }
  } catch (err) {
    return { status: "error", message: err instanceof Error ? err.message : String(err) }
  }
}

export const getUsageSeries = (baseUrl: string, query: UsageQuery) =>
  usageRequest(baseUrl, "/api/usage/series", query)
export const getUsageBreakdown = (baseUrl: string, query: UsageQuery) =>
  usageRequest(baseUrl, "/api/usage/breakdown", query)

/**
 * Subscription quota meters (/api/provider-quotas). Global, no parameters.
 *
 * Same three-way result as the usage history above, and the same reason for a
 * literal path: the route exists only in unlanded protocol work, and a server
 * without it must make the meters disappear — not fail the build or the page.
 */
export async function getProviderQuotas(baseUrl: string): Promise<UsageFetch> {
  if (!baseUrl) return { status: "error", message: "Chunky server is unavailable" }
  try {
    const res = await fetch(`${baseUrl}/api/provider-quotas`)
    if (res.status === 404 || res.status === 501) return { status: "unsupported" }
    const body = (await res.json().catch(() => null)) as { error?: string } | null
    if (!res.ok) {
      return { status: "error", message: body?.error || `request failed (${res.status})` }
    }
    return { status: "ok", body }
  } catch (err) {
    return { status: "error", message: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Server resource usage (/api/usage/resources?hours=N) — the RSS/CPU sampler
 * behind the "Server resources" panel.
 *
 * Literal path for the same reason as the usage history above: the route is
 * newer than the protocol this build pins, so a server without it must make the
 * panel disappear (404/501 → `unsupported`) rather than fail the build or the
 * page. A network failure is also treated as unsupported: the panel is a
 * diagnostic, never worth an error banner over the spend numbers.
 * The body stays `unknown` — lib/stats.ts owns the coercion.
 */
export async function getResourceUsage(baseUrl: string, hours = 24): Promise<UsageFetch> {
  if (!baseUrl) return { status: "unsupported" }
  const window = Number.isFinite(hours) && hours > 0 ? Math.round(hours) : 24
  try {
    const res = await fetch(`${baseUrl}/api/usage/resources?hours=${window}`)
    if (res.status === 404 || res.status === 501) return { status: "unsupported" }
    const body = (await res.json().catch(() => null)) as { error?: string } | null
    if (!res.ok) {
      return { status: "error", message: body?.error || `request failed (${res.status})` }
    }
    return { status: "ok", body }
  } catch {
    // Network/CORS failure: the panel is optional, so degrade silently.
    return { status: "unsupported" }
  }
}

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

/** The server refused our cursor (HTTP 400). Retrying with the same cursor can
 *  only fail again, so the caller must drop it and re-seed.
 *
 *  `code` distinguishes the rejections a newer server names:
 *  - undefined  — legacy body `{ error: "invalid session event cursor" }`.
 *  - "replay-too-large" — the cursor is valid but the suffix from it exceeds
 *    the server's replay budget. `cursor` then carries the server's encoded
 *    cursor at the CURRENT boundary, so the caller can re-seed from a bounded
 *    history tail instead of replaying from zero. */
export class SessionCursorRejected extends Error {
  readonly code?: string
  readonly cursor?: string
  constructor(
    message = "invalid session event cursor",
    opts: { code?: string; cursor?: string } = {},
  ) {
    super(message)
    this.name = "SessionCursorRejected"
    this.code = opts.code
    this.cursor = opts.cursor
  }
}

/**
 * Subscribe to the cursor-aware (v2) session event stream.
 *
 * `cursor` resumes the durable history where the caller left off; omit it for a
 * full replay. An OLD server ignores `?stream=v2` and answers with plain
 * AgentEvent frames — those surface as `{ kind: "legacy" }` frames so the
 * caller can fall back to full-replay reconciliation.
 */
export async function openSessionEventStream(
  baseUrl: string,
  sessionId: string,
  onFrame: (frame: SessionStreamFrame) => void,
  opts: { cursor?: string | null; signal?: AbortSignal; onOpen?: () => void } = {},
): Promise<void> {
  const { cursor, signal, onOpen } = opts
  const url = baseUrl + sessionEventsUrl(sessionId, cursor ? { cursor } : undefined)
  const res = await fetch(url, { signal })
  if (res.status === 400 && cursor) {
    const body = (await res.json().catch(() => null)) as
      | { error?: string; code?: string; cursor?: string }
      | null
    throw new SessionCursorRejected(body?.error || undefined, {
      code: typeof body?.code === "string" ? body.code : undefined,
      cursor: typeof body?.cursor === "string" ? body.cursor : undefined,
    })
  }
  if (!res.ok) throw new Error(`events stream failed (${res.status})`)
  onOpen?.()
  for await (const frame of readSessionEventStream(res)) {
    if (signal?.aborted) break
    onFrame(frame)
  }
}

/** Read the executor selection. With `sessionId` the server returns that
 * session's effective selection plus authoritative `pinned` provenance; omit it
 * for the global default itself. */
export async function fetchModel(
  baseUrl: string,
  sessionId?: string | null,
): Promise<ModelSelection | null> {
  try {
    const res = await fetch(
      baseUrl + (sessionId ? `/api/model?sessionId=${encodeURIComponent(sessionId)}` : "/api/model"),
    )
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

/** Select the executor model. Pass `sessionId` to pin the selection to that
 *  session only (response = the session's effective selection); omit it to move
 *  the global default that new/unpinned sessions inherit. */
export async function selectModel(
  baseUrl: string,
  payload: { provider: string; model: string; effort?: string; speed?: string },
  sessionId?: string | null,
): Promise<ModelSelection> {
  const res = await fetch(baseUrl + "/api/model/select", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(sessionId ? { ...payload, sessionId } : payload),
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
