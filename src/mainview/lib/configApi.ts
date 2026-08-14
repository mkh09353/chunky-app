// Typed HTTP client for the Chunky server's configuration surface.
//
// This backs the Settings Center + Onboarding Wizard. It reuses api.ts for base
// URL resolution + auth (loadConfig installs the bearer-token fetch wrapper and
// picks the dev `/chunky-api` proxy vs. the real server URL), so we never fork
// that logic and never embed a token here.
import {
  listAllModels as apiListAllModels,
  loadConfig,
  prettyModel,
  providerLabel,
  splitModelKey,
} from "./api"
import type { ModelRow, ModelSelection } from "./api"

// Re-export the protocol types the settings UI needs, so components import from
// one place. These are the wire shapes the server already ships.
export type {
  AuthLogoutResult,
  AuthTestResult,
  ProviderKeyRequest,
  ProviderKeyResponse,
  CacheGuardResponse,
  LoginInitiation,
  ManagedSkill,
  ManageSkillReposRequest,
  ModeAdvisor,
  ModeInfo,
  ModeSpec,
  ModesResponse,
  SaveModeRequest,
  SessionAgentConfigResponse,
  SkillCatalogEntry,
  SkillRepoAction,
  SkillReposResponse,
  SkillRepoStatus,
  SkillsCatalogResponse,
} from "@chunky/protocol"
export type { ModelRow, ModelSelection } from "./api"
export { prettyModel, providerLabel, splitModelKey }

import { ROUTES } from "@chunky/protocol"
import type {
  AuthLogoutResult,
  AuthTestResult,
  ProviderKeyResponse,
  CacheGuardResponse,
  LoginInitiation,
  ManageSkillReposRequest,
  ModesResponse,
  ModeSpec,
  SaveModeRequest,
  SessionAgentConfigResponse,
  SkillCatalogEntry,
  SkillReposResponse,
  SkillRepoStatus,
} from "@chunky/protocol"

// ---- Shared enums --------------------------------------------------------

export type Effort = "low" | "medium" | "high" | "xhigh" | "max"
export type Speed = "standard" | "fast"

export const EFFORTS: Effort[] = ["low", "medium", "high", "xhigh", "max"]
export const SPEEDS: Speed[] = ["standard", "fast"]

// ---- Base URL + request plumbing -----------------------------------------

let basePromise: Promise<string> | null = null

/** Resolve (once) the server base URL + install auth via api.ts loadConfig. */
function base(): Promise<string> {
  if (!basePromise) basePromise = loadConfig().then((c) => c.baseUrl)
  return basePromise
}

/**
 * Point this module at a different server (or forget the memo so the next call
 * resolves again). Called when the app re-resolves onto a replacement server:
 * without it every configApi request would keep addressing the dead one.
 */
export function setBaseUrl(nextBaseUrl?: string): void {
  basePromise = nextBaseUrl ? Promise.resolve(nextBaseUrl) : null
}

function errText(data: unknown, fallback: string): string {
  return bodyError(data) ?? fallback
}

/**
 * A non-2xx response. Carries the status and parsed body so callers can tell
 * "this server is too old to have the route" (catch-all 404, non-JSON body)
 * apart from a genuine JSON error the route itself returned.
 */
export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message)
    this.name = "HttpError"
  }
}

/** The JSON `error`/`message` string of a response body, when it has one. */
function bodyError(data: unknown): string | null {
  if (data && typeof data === "object") {
    const rec = data as Record<string, unknown>
    if (typeof rec.error === "string" && rec.error) return rec.error
    if (typeof rec.message === "string" && rec.message) return rec.message
  }
  return null
}

/**
 * True when the server simply does not have this route: its catch-all answers
 * 404 with a plain-text body, whereas the real routes answer 404 with a JSON
 * `error` (e.g. an unknown provider id).
 */
function isMissingRoute(err: unknown): boolean {
  return err instanceof HttpError && (err.status === 404 || err.status === 501) && bodyError(err.body) === null
}

/** Core request helper: prefixes base URL, parses JSON, throws typed errors.
 *  Exported so sibling server-API modules (e.g. relayApi.ts) reuse this one
 *  base-URL + auth path instead of forking it. */
export async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const b = await base()
  const method = init?.method ?? "GET"
  let res: Response
  try {
    res = await fetch(b + path, init)
  } catch (err) {
    throw new Error(`Can't reach the Chunky server (${(err as Error).message})`)
  }
  const text = await res.text().catch(() => "")
  let data: unknown = null
  if (text) {
    try {
      data = JSON.parse(text)
    } catch {
      data = text
    }
  }
  if (!res.ok) {
    throw new HttpError(errText(data, `${method} ${path} failed (${res.status})`), res.status, data)
  }
  return data as T
}

/**
 * Like req(), but for routes whose body is text rather than JSON (e.g. the
 * eval transcript endpoint, which answers text/plain JSONL). Same base URL +
 * auth path; errors still surface as HttpError with the raw body attached.
 */
export async function reqText(path: string, init?: RequestInit): Promise<string> {
  const b = await base()
  const method = init?.method ?? "GET"
  let res: Response
  try {
    res = await fetch(b + path, init)
  } catch (err) {
    throw new Error(`Can't reach the Chunky server (${(err as Error).message})`)
  }
  const text = await res.text().catch(() => "")
  if (!res.ok) {
    let data: unknown = text
    try {
      data = text ? JSON.parse(text) : null
    } catch {
      /* keep the raw text */
    }
    throw new HttpError(errText(data, `${method} ${path} failed (${res.status})`), res.status, data)
  }
  return text
}

/** Build a JSON request init. */
export function jsonInit(method: string, body?: unknown): RequestInit {
  return {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }
}

// ---- Model catalogs (shared by every model picker) -----------------------

/** Every provider's models, flattened (used to populate the pickers). */
export async function listAllModels(): Promise<ModelRow[]> {
  return apiListAllModels(await base())
}

// ================================================================
// 1. Providers
// ================================================================

export interface ProviderInfo {
  id: string
  label: string
  ready: boolean
  active: boolean
  /** e.g. "subscription" | "api-key" | "free" — server-defined, optional. */
  billing?: string
  custom?: boolean
}

export interface AuthStatus {
  ready: boolean
  /** Optional coarse state: "pending" | "authorized" | "error" | ... */
  state?: string
  error?: string
}

export interface CustomProviderInput {
  id: string
  label: string
  baseURL: string
  /** Sent to the server as `key`. */
  apiKey: string
}

export async function listProviders(): Promise<ProviderInfo[]> {
  const data = await req<{ providers?: ProviderInfo[] }>("/api/providers")
  return (data.providers ?? []).map((p) => ({
    id: p.id,
    label: p.label ?? providerLabel(p.id),
    ready: p.ready === true,
    active: p.active === true,
    billing: p.billing,
    custom: p.custom,
  }))
}

/** Start a provider login flow. Returns how the client should proceed. */
export async function startProviderLogin(provider: string): Promise<LoginInitiation> {
  return req<LoginInitiation>(`/api/auth/${encodeURIComponent(provider)}/login`, jsonInit("POST"))
}

/** Poll for a login flow's completion. */
export async function getProviderAuthStatus(provider: string): Promise<AuthStatus> {
  const data = await req<Partial<AuthStatus>>(`/api/auth/${encodeURIComponent(provider)}/status`)
  return {
    ready: data.ready === true || data.state === "authorized",
    state: data.state,
    error: data.error,
  }
}

/**
 * A credential preflight result, plus a renderer-only flag for servers that
 * predate the /test route — "unknown", which must not be shown as a failure.
 */
export interface ProviderTestResult extends AuthTestResult {
  unsupported?: boolean
}

/** Same graceful shape for the key hand-off: a too-old server/bundle reports
 *  `unsupported` rather than looking like a rejected key. */
export interface ProviderKeyResult extends ProviderKeyResponse {
  unsupported?: boolean
}

export const UNSUPPORTED_TEST =
  "This Chunky server does not support testing a provider connection yet. Update the server to use this."
export const UNSUPPORTED_LOGOUT =
  "This Chunky server does not support disconnecting a provider yet. Update the server to use this."
export const UNSUPPORTED_PROVIDER_KEY =
  "This Chunky server does not support collecting a provider API key yet. Update the server to use this."

/**
 * The slice of ROUTES the auth calls need, with every member optional and
 * untyped on purpose.
 *
 * A packaged renderer bundles a SNAPSHOT of @chunky/protocol. If the app is
 * built against a protocol older than the code calling it, `ROUTES.authTest`
 * is typed as a function but is `undefined` at runtime, and calling it throws
 * `authTest is not a function` (see v0.1.16). Route lookups therefore go
 * through the resolvers below, which check before they call.
 */
export interface AuthRouteTable {
  authTest?: unknown
  authLogout?: unknown
  providerKey?: unknown
}

/**
 * COMPILE-TIME skew guard.
 *
 * The runtime resolvers below accept a loosely-typed table, which means the
 * typecheck alone would no longer notice if @chunky/protocol dropped these
 * builders — the very skew that shipped in v0.1.16. This assertion restores
 * that: it fails `bun run typecheck` (and therefore `build:web` / `build`)
 * whenever the protocol this app is built against lacks either auth route.
 * Exported so `noUnusedLocals` keeps it.
 */
interface RequiredAuthRoutes {
  authTest: (provider: string) => string
  authLogout: (provider: string) => string
  providerKey: (provider: string) => string
}
type Assert<T extends true> = T
export type AssertAuthRoutesPresent = Assert<
  typeof ROUTES extends RequiredAuthRoutes ? true : false
>

/** Build a route path, or null when this bundle's ROUTES lacks the helper. */
function routeFor(
  routes: AuthRouteTable,
  name: keyof AuthRouteTable,
  provider: string,
): string | null {
  const build = routes?.[name]
  if (typeof build !== "function") return null
  try {
    const path = (build as (p: string) => unknown)(provider)
    return typeof path === "string" && path ? path : null
  } catch {
    return null
  }
}

/** POST path for the credential preflight, or null when unavailable. */
export function authTestRoute(routes: AuthRouteTable, provider: string): string | null {
  return routeFor(routes, "authTest", provider)
}

/** POST path for removing a stored credential, or null when unavailable. */
export function authLogoutRoute(routes: AuthRouteTable, provider: string): string | null {
  return routeFor(routes, "authLogout", provider)
}

/** POST path for handing the server a provider key, or null when unavailable. */
export function providerKeyRoute(routes: AuthRouteTable, provider: string): string | null {
  return routeFor(routes, "providerKey", provider)
}

/**
 * Really validate the stored credential (the server preflights an OAuth
 * refresh where it can), so a provider whose `ready` flag lies is caught.
 *
 * Never throws: a failed check is a normal outcome the card renders inline —
 * including "this bundle has no such route", which reuses the same graceful
 * `unsupported` result as an old server answering 404.
 *
 * `routes` is injectable so the missing-route path is testable without
 * mutating the canonical ROUTES.
 */
export async function testProviderAuth(
  provider: string,
  routes: AuthRouteTable = ROUTES,
): Promise<ProviderTestResult> {
  const path = authTestRoute(routes, provider)
  if (!path) return { ok: false, unsupported: true, error: UNSUPPORTED_TEST }
  try {
    const data = await req<Partial<AuthTestResult>>(path, jsonInit("POST"))
    if (data?.ok === true) return { ok: true }
    return { ok: false, error: data?.error || "The provider reported the credential as not usable." }
  } catch (err) {
    if (isMissingRoute(err)) return { ok: false, unsupported: true, error: UNSUPPORTED_TEST }
    return { ok: false, error: (err as Error).message }
  }
}

/** Remove the provider's stored credential. /status then reports not ready.
 *  Throws the same "not supported" error for a missing route helper as for an
 *  old server, so the UI has one failure mode to render. */
export async function logoutProvider(
  provider: string,
  routes: AuthRouteTable = ROUTES,
): Promise<void> {
  const path = authLogoutRoute(routes, provider)
  if (!path) throw new Error(UNSUPPORTED_LOGOUT)
  try {
    await req<AuthLogoutResult>(path, jsonInit("POST"))
  } catch (err) {
    if (isMissingRoute(err)) throw new Error(UNSUPPORTED_LOGOUT)
    throw err
  }
}

/**
 * Answer an agent's `app.request_api_key`: hand the server the key the user
 * typed, or cancel the request by answering with no key at all.
 *
 * The secret goes straight from the dialog's state into this POST body — never
 * a URL, a log line, a transcript or storage — and the server never returns it.
 *
 * Never throws: the dialog renders every outcome inline, including "this bundle
 * or server has no such route", which reuses the graceful `unsupported` result
 * the auth preflight already established. `routes` is injectable so the
 * missing-route path is testable without mutating the canonical ROUTES.
 */
export async function submitProviderKey(
  provider: string,
  input: { requestId?: string; key?: string },
  routes: AuthRouteTable = ROUTES,
): Promise<ProviderKeyResult> {
  const path = providerKeyRoute(routes, provider)
  if (!path) return { ok: false, unsupported: true, error: UNSUPPORTED_PROVIDER_KEY }
  const body: { requestId?: string; key?: string } = {}
  if (input.requestId) body.requestId = input.requestId
  // An absent/empty key IS the cancel signal, so it is only sent when present.
  if (input.key) body.key = input.key
  try {
    const data = await req<Partial<ProviderKeyResponse>>(path, jsonInit("POST", body))
    if (data?.ok === true) return { ok: true }
    return { ok: false, error: data?.error || "The server did not accept that key." }
  } catch (err) {
    if (isMissingRoute(err)) return { ok: false, unsupported: true, error: UNSUPPORTED_PROVIDER_KEY }
    return { ok: false, error: (err as Error).message }
  }
}

/** Cancel a pending key request: the same route, answered with no key. */
export async function cancelProviderKeyRequest(
  provider: string,
  requestId: string,
  routes: AuthRouteTable = ROUTES,
): Promise<ProviderKeyResult> {
  return submitProviderKey(provider, { requestId }, routes)
}

/** Make a provider the active one. */
export async function selectProvider(provider: string): Promise<void> {
  await req<unknown>(`/api/providers/${encodeURIComponent(provider)}/select`, jsonInit("POST"))
}

/** Register a custom OpenAI-compatible provider. Server field is `key`. */
export async function addCustomProvider(input: CustomProviderInput): Promise<void> {
  await req<unknown>(
    ROUTES.customProvider,
    jsonInit("POST", {
      id: input.id,
      label: input.label,
      baseURL: input.baseURL,
      key: input.apiKey,
    }),
  )
}

// ================================================================
// 2. Models
// ================================================================

export interface CatalogModel {
  id: string
  name?: string
  reasoning?: boolean
  contextLimit?: number
  custom?: boolean
  verified?: boolean
  hidden?: boolean
}

export type CatalogAction = "add" | "hide" | "restore" | "list"

export interface CatalogRequest {
  action: CatalogAction
  model?: string
  name?: string
}

export async function listModels(providerId: string): Promise<CatalogModel[]> {
  const data = await req<{ models?: CatalogModel[] }>(
    `/api/providers/${encodeURIComponent(providerId)}/models`,
  )
  return data.models ?? []
}

/** GET availability returns the FULL known catalog plus the checked (visible) ids.
 *  Server shape: { provider, models: ModelInfo[], available: string[] }. */
export interface ModelAvailability {
  models: CatalogModel[]
  available: string[]
}

export async function getModelAvailability(providerId: string): Promise<ModelAvailability> {
  const data = await req<{ models?: CatalogModel[]; available?: string[] }>(
    `/api/providers/${encodeURIComponent(providerId)}/models/availability`,
  )
  return { models: data.models ?? [], available: data.available ?? [] }
}

/** Persist the set of enabled (visible) model ids for a provider. PUT body is
 *  { available: string[] }. */
export async function setModelAvailability(
  providerId: string,
  available: string[],
): Promise<void> {
  await req<unknown>(
    `/api/providers/${encodeURIComponent(providerId)}/models/availability`,
    jsonInit("PUT", { available }),
  )
}

/** Add / hide / restore / list catalog entries. POST body { action, model? };
 *  the response shape varies by action, so it's returned loosely typed. */
export async function manageCatalog(
  providerId: string,
  request: CatalogRequest,
): Promise<Record<string, unknown>> {
  return req<Record<string, unknown>>(
    `/api/providers/${encodeURIComponent(providerId)}/models/catalog`,
    jsonInit("POST", request),
  )
}

export async function getActiveModel(): Promise<ModelSelection | null> {
  try {
    return await req<ModelSelection>("/api/model")
  } catch {
    return null
  }
}

export interface SelectModelInput {
  provider: string
  model: string
  effort?: Effort
  speed?: Speed
}

/** Select the executor model. Pass `sessionId` to PIN the selection to that
 *  session only (the response is that session's effective selection); omit it
 *  for the GLOBAL default used by new/unpinned sessions. */
export async function selectModel(
  input: SelectModelInput,
  sessionId?: string | null,
): Promise<ModelSelection> {
  return req<ModelSelection>(
    "/api/model/select",
    jsonInit("POST", sessionId ? { ...input, sessionId } : input),
  )
}

// ================================================================
// 3. Advisor & Reviewer  (identical shape, different routes)
// ================================================================

export interface AgentModelConfig {
  enabled: boolean
  provider?: string | null
  model?: string | null
  effort?: string | null
}

function normalizeAgentConfig(data: unknown): AgentModelConfig {
  if (!data || typeof data !== "object") return { enabled: false }
  const root = data as Record<string, unknown>
  // Server wraps the config: GET/POST return { config, active } (+ effective for
  // review). Tolerate both wrapped and bare shapes.
  const o = (root.config && typeof root.config === "object" ? root.config : root) as Record<
    string,
    unknown
  >
  return {
    enabled: o.enabled === true,
    provider: typeof o.provider === "string" ? o.provider : null,
    model: typeof o.model === "string" ? o.model : null,
    effort: typeof o.effort === "string" ? o.effort : null,
  }
}

export async function getAdvisor(): Promise<AgentModelConfig> {
  return normalizeAgentConfig(await req<unknown>("/api/advisor"))
}

export async function setAdvisor(cfg: AgentModelConfig): Promise<AgentModelConfig> {
  return normalizeAgentConfig(await req<unknown>("/api/advisor", jsonInit("POST", cfg)))
}

/** GET /api/advisor also reports readiness: `active: false` means the advisor is
 *  configured but currently suppressed (e.g. not logged in), which the composer
 *  status rule marks with `✕` instead of hiding. */
export interface AdvisorStatus {
  config: AgentModelConfig
  active: boolean
}

export async function getAdvisorStatus(): Promise<AdvisorStatus> {
  const body = (await req<unknown>("/api/advisor")) as { config?: unknown; active?: unknown }
  return { config: normalizeAgentConfig(body?.config), active: body?.active === true }
}

/** The SOLO advisor: the only delegate allowed to run while a raw model pick
 *  holds the session (or the global default) in solo. Same wire shape as the
 *  advisor, its own route — enabling it never turns the normal advisor on. */
export async function getSoloAdvisor(): Promise<AgentModelConfig> {
  return normalizeAgentConfig(await req<unknown>(ROUTES.soloAdvisor))
}

export async function setSoloAdvisor(cfg: AgentModelConfig): Promise<AgentModelConfig> {
  return normalizeAgentConfig(await req<unknown>(ROUTES.soloAdvisor, jsonInit("POST", cfg)))
}

/** GET ROUTES.soloAdvisor reports readiness the same way /api/advisor does:
 *  `active: false` = configured but not currently resolvable. */
export async function getSoloAdvisorStatus(): Promise<AdvisorStatus> {
  const body = (await req<unknown>(ROUTES.soloAdvisor)) as { config?: unknown; active?: unknown }
  return { config: normalizeAgentConfig(body?.config), active: body?.active === true }
}

export async function getReviewer(): Promise<AgentModelConfig> {
  return normalizeAgentConfig(await req<unknown>(ROUTES.review))
}

export async function setReviewer(cfg: AgentModelConfig): Promise<AgentModelConfig> {
  return normalizeAgentConfig(await req<unknown>(ROUTES.review, jsonInit("POST", cfg)))
}

/** GET ROUTES.review also reports readiness and the EFFECTIVE reviewer, which
 *  an active mode's `review` override can differ from — the server keeps that
 *  override read-only here, so the UI shows it rather than silently losing it. */
export interface ReviewerStatus {
  config: AgentModelConfig
  effective: AgentModelConfig
  /** True when a reviewer model actually resolves (logged in + configured). */
  active: boolean
}

export async function getReviewerStatus(): Promise<ReviewerStatus> {
  const body = (await req<unknown>(ROUTES.review)) as {
    config?: unknown
    effective?: unknown
    active?: unknown
  }
  return {
    config: normalizeAgentConfig(body?.config),
    effective: normalizeAgentConfig(body?.effective),
    active: body?.active === true,
  }
}

// ================================================================
// 4. Sidekick seats
// ================================================================

export interface SeatConfig {
  enabled?: boolean
  provider?: string | null
  model?: string | null
  effort?: string | null
}

export interface SidekickConfig {
  /** The default (unnamed) seat. Unset provider/model => inherit the executor. */
  default: SeatConfig
  /** Named seats keyed by slug. */
  seats: Record<string, SeatConfig>
}

function normalizeSeat(data: unknown): SeatConfig {
  if (!data || typeof data !== "object") return {}
  const o = data as Record<string, unknown>
  return {
    enabled: o.enabled === true,
    provider: typeof o.provider === "string" ? o.provider : null,
    model: typeof o.model === "string" ? o.model : null,
    effort: typeof o.effort === "string" ? o.effort : null,
  }
}

function normalizeSidekick(data: unknown): SidekickConfig {
  const out: SidekickConfig = { default: {}, seats: {} }
  if (!data || typeof data !== "object") return out
  const o = data as Record<string, unknown>
  // Server shape: { config: <default seat>, seats: Record<name, SidekickSeat> }.
  out.default = normalizeSeat(o.config)
  const seats = o.seats
  if (seats && typeof seats === "object") {
    for (const [name, cfg] of Object.entries(seats as Record<string, unknown>)) {
      // Named seats have no `enabled` field server-side — presence = enabled.
      out.seats[name] = { ...normalizeSeat(cfg), enabled: true }
    }
  }
  return out
}

export interface SessionAgentConfig {
  selection: ModelSelection
  source: "session-mode" | "session-selection" | "global"
  activeMode: string | null
  advisor: AgentModelConfig
  review: AgentModelConfig
  sidekick: SidekickConfig
}

/** Normalize the authoritative session snapshot into the renderer's existing
 * advisor/sidekick shapes. Exported to keep skew handling independently tested. */
export function normalizeSessionAgentConfig(data: SessionAgentConfigResponse): SessionAgentConfig {
  return {
    selection: {
      provider: data.selection.provider,
      model: data.selection.model ?? null,
      effort: data.selection.effort ?? null,
      speed: data.selection.speed ?? null,
      solo: data.selection.solo,
      pinned: data.source !== "global",
    },
    source: data.source,
    activeMode: data.activeMode ?? null,
    advisor: normalizeAgentConfig(data.advisor),
    review: normalizeAgentConfig(data.review),
    sidekick: normalizeSidekick({ config: data.sidekick, seats: data.sidekickSeats }),
  }
}

/** Authoritative effective configuration for one session. */
export async function getSessionAgentConfig(sessionId: string): Promise<SessionAgentConfig> {
  return normalizeSessionAgentConfig(await req<SessionAgentConfigResponse>(ROUTES.agentConfig(sessionId)))
}

/** Read sidekick config. With `sessionId` the server returns that session's
 *  EFFECTIVE config (per-session override merged over the global default). */
export async function getSidekick(sessionId?: string | null): Promise<SidekickConfig> {
  const path = sessionId
    ? `/api/sidekick?sessionId=${encodeURIComponent(sessionId)}`
    : "/api/sidekick"
  return normalizeSidekick(await req<unknown>(path))
}

/** Build a flat patch, omitting null/undefined (server merge-persists it). */
function seatPatch(cfg: SeatConfig): Record<string, unknown> {
  const p: Record<string, unknown> = {}
  if (typeof cfg.enabled === "boolean") p.enabled = cfg.enabled
  if (cfg.provider) p.provider = cfg.provider
  if (cfg.model) p.model = cfg.model
  if (cfg.effort) p.effort = cfg.effort
  return p
}

/** Save the DEFAULT seat: POST flat { enabled?, provider?, model?, effort? }
 *  (no `seat`). `enabled` is the master switch; empty model inherits executor. */
export async function saveDefaultSeat(
  config: SeatConfig,
  sessionId?: string | null,
): Promise<SidekickConfig> {
  const patch = seatPatch(config)
  return normalizeSidekick(
    await req<unknown>(
      "/api/sidekick",
      jsonInit("POST", sessionId ? { ...patch, sessionId } : patch),
    ),
  )
}

/** Save a NAMED seat. The server requires provider + model for named seats.
 *  With `sessionId` the seat becomes a per-session override. */
export async function saveNamedSeat(
  seat: string,
  config: SeatConfig,
  sessionId?: string | null,
): Promise<SidekickConfig> {
  return normalizeSidekick(
    await req<unknown>(
      "/api/sidekick",
      jsonInit("POST", {
        seat,
        enabled: true,
        provider: config.provider,
        model: config.model,
        ...(config.effort ? { effort: config.effort } : {}),
        ...(sessionId ? { sessionId } : {}),
      }),
    ),
  )
}

/** Delete a named seat — server maps { seat, enabled: false } to removal.
 *  With `sessionId` it removes that session's named-seat override only. */
export async function deleteSeat(seat: string, sessionId?: string | null): Promise<SidekickConfig> {
  return normalizeSidekick(
    await req<unknown>(
      "/api/sidekick",
      jsonInit("POST", { seat, enabled: false, ...(sessionId ? { sessionId } : {}) }),
    ),
  )
}

/** Seat slug rules: lowercase, starts with a letter, <=24 chars, not "default". */
export const SEAT_NAME_RE = /^[a-z][a-z0-9_-]{0,23}$/

export function validateSeatName(name: string): string | null {
  if (name === "default") return `"default" is reserved.`
  if (!SEAT_NAME_RE.test(name)) {
    return "Use a lowercase slug: start with a letter, then letters/digits/-/_ (max 24)."
  }
  return null
}

// ================================================================
// 5. Modes
// ================================================================

export async function getModes(): Promise<ModesResponse> {
  return req<ModesResponse>(ROUTES.modes)
}

export async function saveMode(request: SaveModeRequest): Promise<ModesResponse> {
  return req<ModesResponse>(ROUTES.modes, jsonInit("POST", request))
}

/** Apply a saved mode as one unit. With `sessionId` the complete preset is
 * pinned to that session; without it Settings changes global defaults. */
export async function applyMode(name: string, sessionId?: string | null): Promise<ApplyModeResult> {
  return req<ApplyModeResult>(ROUTES.applyMode(name), jsonInit("POST", sessionId ? { sessionId } : {}))
}

export async function deleteMode(name: string): Promise<ModesResponse> {
  return req<ModesResponse>(ROUTES.deleteMode(name), { method: "DELETE" })
}

/** The apply endpoint's payload (executor half of the applied trio). */
export interface ApplyModeResult {
  applied: string
  provider: string
  model: string | null
  effort?: string | null
  speed?: string | null
}

// ================================================================
// 6. Skills
// ================================================================

export async function getSkills(): Promise<SkillCatalogEntry[]> {
  const data = await req<{ skills?: SkillCatalogEntry[] }>("/api/skills")
  return data.skills ?? []
}

/** Enable/disable a skill by name (+ source for disambiguation). */
export async function setSkillEnabled(
  skill: SkillCatalogEntry,
  enabled: boolean,
): Promise<void> {
  await req<unknown>(
    "/api/skills",
    jsonInit("POST", { name: skill.name, source: skill.source, path: skill.path, enabled }),
  )
}

export async function getSkillRepos(): Promise<SkillRepoStatus[]> {
  const data = await req<SkillReposResponse>(ROUTES.skillRepos)
  return data.repos ?? []
}

export async function manageSkillRepos(
  request: ManageSkillReposRequest,
): Promise<SkillReposResponse> {
  return req<SkillReposResponse>(ROUTES.skillRepos, jsonInit("POST", request))
}

// ================================================================
// 7. Cache guard
// ================================================================

export async function getCacheGuard(): Promise<CacheGuardResponse> {
  return req<CacheGuardResponse>(ROUTES.cacheGuard)
}

/** null disables the guard. */
export async function setCacheGuard(tokens: number | null): Promise<CacheGuardResponse> {
  return req<CacheGuardResponse>(ROUTES.cacheGuard, jsonInit("POST", { tokens }))
}

// ================================================================
// 8. Misc — Dream + Workflow targets
// ================================================================

export async function runDream(): Promise<void> {
  await req<unknown>(ROUTES.dream, jsonInit("POST", {}))
}

export type WorkflowBilling = "free" | "subscription" | "metered" | "unknown"

/** One effective workflow route: a provider/model with its resolved tags,
 *  automatic flag, effort, and billing (server computes these per ready model). */
export interface WorkflowTarget {
  provider: string
  model: string
  name: string
  billing: WorkflowBilling
  tags: string[]
  automatic: boolean
  effort: string
  priority: number
}

/** A user override applied to one provider/model target. */
export interface WorkflowTargetOverride {
  provider: string
  model: string
  tags?: string[]
  automatic?: boolean
  effort?: Effort
}

function normalizeWorkflowTargets(data: unknown): WorkflowTarget[] {
  const out: WorkflowTarget[] = []
  const arr =
    data && typeof data === "object" && Array.isArray((data as Record<string, unknown>).targets)
      ? ((data as Record<string, unknown>).targets as unknown[])
      : []
  for (const t of arr) {
    if (t && typeof t === "object") {
      const r = t as Record<string, unknown>
      if (typeof r.provider === "string" && typeof r.model === "string") {
        out.push({
          provider: r.provider,
          model: r.model,
          name: typeof r.name === "string" ? r.name : r.model,
          billing: (typeof r.billing === "string" ? r.billing : "unknown") as WorkflowBilling,
          tags: Array.isArray(r.tags) ? r.tags.filter((x): x is string => typeof x === "string") : [],
          automatic: r.automatic === true,
          effort: typeof r.effort === "string" ? r.effort : "medium",
          priority: typeof r.priority === "number" ? r.priority : 0,
        })
      }
    }
  }
  return out
}

/** GET -> the effective targets (every ready provider's models). No global
 *  automatic flag: `automatic` is per-target. */
export async function getWorkflowTargets(): Promise<WorkflowTarget[]> {
  return normalizeWorkflowTargets(await req<unknown>("/api/workflow-targets"))
}

/** Upsert an override for one provider/model. The server returns { ok }, so
 *  callers should re-fetch getWorkflowTargets() to see the merged result. */
export async function putWorkflowTarget(override: WorkflowTargetOverride): Promise<void> {
  await req<unknown>("/api/workflow-targets", jsonInit("PUT", override))
}

/** Clear the override for one provider/model (revert to the zero-config default). */
export async function deleteWorkflowTarget(provider: string, model: string): Promise<void> {
  await req<unknown>("/api/workflow-targets", jsonInit("DELETE", { provider, model }))
}

// ================================================================
// 9. Onboarding
// ================================================================

/** Provider onboarding status: "ready" | "missing" | "inherited" (Anthropic
 *  inherited creds), or any future server string. */
export type OnboardingProviderStatus = "ready" | "missing" | "inherited" | (string & {})

export interface OnboardingProvider {
  id: string
  label: string
  status: OnboardingProviderStatus
  detail?: string
  /** Derived: any status other than "missing" means credentials are present. */
  ready: boolean
}

/** A suggested onboarding mode: name + description + the full ModeSpec to apply. */
export interface SuggestedMode {
  name: string
  description: string
  spec: ModeSpec
}

export interface OnboardingResponse {
  providers: OnboardingProvider[]
  onboardedAt: number | null
  suggestedModes: SuggestedMode[]
}

function normalizeOnboarding(data: unknown): OnboardingResponse {
  const out: OnboardingResponse = { providers: [], onboardedAt: null, suggestedModes: [] }
  if (!data || typeof data !== "object") return out
  const o = data as Record<string, unknown>
  const rawProviders = Array.isArray(o.providers)
    ? o.providers
    : Array.isArray(o.statuses)
      ? o.statuses
      : []
  for (const p of rawProviders) {
    if (p && typeof p === "object") {
      const row = p as Record<string, unknown>
      if (typeof row.id === "string") {
        const status =
          typeof row.status === "string" ? row.status : row.ready === true ? "ready" : "missing"
        out.providers.push({
          id: row.id,
          label: typeof row.label === "string" ? row.label : providerLabel(row.id),
          status,
          detail: typeof row.detail === "string" ? row.detail : undefined,
          ready: status !== "missing",
        })
      }
    }
  }
  if (typeof o.onboardedAt === "number") out.onboardedAt = o.onboardedAt
  const rawModes = Array.isArray(o.suggestedModes)
    ? o.suggestedModes
    : Array.isArray(o.modes)
      ? o.modes
      : []
  for (const m of rawModes) {
    if (m && typeof m === "object") {
      const row = m as Record<string, unknown>
      if (typeof row.name === "string" && row.spec && typeof row.spec === "object") {
        const spec = row.spec as ModeSpec
        if (typeof spec.provider === "string" && typeof spec.model === "string") {
          out.suggestedModes.push({
            name: row.name,
            description: typeof row.description === "string" ? row.description : "",
            spec,
          })
        }
      }
    }
  }
  return out
}

export async function getOnboarding(): Promise<OnboardingResponse> {
  return normalizeOnboarding(await req<unknown>(ROUTES.onboarding))
}

/** Apply a suggested mode. Server body is { mode: ModeSpec, name? }. */
export async function applyOnboardingMode(mode: SuggestedMode): Promise<void> {
  await req<unknown>(ROUTES.onboardingApply, jsonInit("POST", { mode: mode.spec, name: mode.name }))
}

export async function completeOnboarding(): Promise<void> {
  await req<unknown>(ROUTES.onboardingComplete, jsonInit("POST", {}))
}
