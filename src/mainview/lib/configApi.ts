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
  CacheGuardResponse,
  LoginInitiation,
  ManagedSkill,
  ManageSkillReposRequest,
  ModeAdvisor,
  ModeInfo,
  ModeSpec,
  ModesResponse,
  SaveModeRequest,
  SkillCatalogEntry,
  SkillRepoAction,
  SkillReposResponse,
  SkillRepoStatus,
  SkillsCatalogResponse,
} from "@chunky/protocol"
export type { ModelRow, ModelSelection } from "./api"
export { prettyModel, providerLabel, splitModelKey }

import type {
  CacheGuardResponse,
  LoginInitiation,
  ManageSkillReposRequest,
  ModesResponse,
  SaveModeRequest,
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

function errText(data: unknown, fallback: string): string {
  if (data && typeof data === "object") {
    const rec = data as Record<string, unknown>
    if (typeof rec.error === "string" && rec.error) return rec.error
    if (typeof rec.message === "string" && rec.message) return rec.message
  }
  return fallback
}

/** Core request helper: prefixes base URL, parses JSON, throws typed errors. */
async function req<T>(path: string, init?: RequestInit): Promise<T> {
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
    throw new Error(errText(data, `${method} ${path} failed (${res.status})`))
  }
  return data as T
}

/** Build a JSON request init. */
function jsonInit(method: string, body?: unknown): RequestInit {
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

/** Make a provider the active one. */
export async function selectProvider(provider: string): Promise<void> {
  await req<unknown>(`/api/providers/${encodeURIComponent(provider)}/select`, jsonInit("POST"))
}

/** Register a custom OpenAI-compatible provider. */
export async function addCustomProvider(input: CustomProviderInput): Promise<void> {
  await req<unknown>("/api/providers/custom", jsonInit("POST", input))
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

/** Normalize the availability response into an id -> enabled map. */
function normalizeAvailability(data: unknown): Record<string, boolean> {
  const out: Record<string, boolean> = {}
  if (Array.isArray(data)) {
    for (const id of data) if (typeof id === "string") out[id] = true
    return out
  }
  if (data && typeof data === "object") {
    const o = data as Record<string, unknown>
    if (Array.isArray(o.available)) {
      for (const id of o.available) if (typeof id === "string") out[id] = true
      return out
    }
    if (Array.isArray(o.models)) {
      for (const m of o.models) {
        if (m && typeof m === "object") {
          const row = m as Record<string, unknown>
          if (typeof row.id === "string") out[row.id] = row.available !== false
        }
      }
      return out
    }
    if (o.available && typeof o.available === "object") {
      for (const [k, v] of Object.entries(o.available as Record<string, unknown>)) {
        out[k] = Boolean(v)
      }
      return out
    }
    for (const [k, v] of Object.entries(o)) out[k] = Boolean(v)
  }
  return out
}

export async function getModelAvailability(providerId: string): Promise<Record<string, boolean>> {
  const data = await req<unknown>(
    `/api/providers/${encodeURIComponent(providerId)}/models/availability`,
  )
  return normalizeAvailability(data)
}

/** Persist the set of enabled model ids for a provider. */
export async function setModelAvailability(
  providerId: string,
  available: string[],
): Promise<void> {
  await req<unknown>(
    `/api/providers/${encodeURIComponent(providerId)}/models/availability`,
    jsonInit("PUT", { available }),
  )
}

/** Add / hide / restore / list catalog entries. Returns the resulting models. */
export async function manageCatalog(
  providerId: string,
  request: CatalogRequest,
): Promise<CatalogModel[]> {
  const data = await req<{ models?: CatalogModel[] }>(
    `/api/providers/${encodeURIComponent(providerId)}/models/catalog`,
    jsonInit("POST", request),
  )
  return data.models ?? []
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

export async function selectModel(input: SelectModelInput): Promise<ModelSelection> {
  return req<ModelSelection>("/api/model/select", jsonInit("POST", input))
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
  const o = data as Record<string, unknown>
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

export async function getReviewer(): Promise<AgentModelConfig> {
  return normalizeAgentConfig(await req<unknown>("/api/review"))
}

export async function setReviewer(cfg: AgentModelConfig): Promise<AgentModelConfig> {
  return normalizeAgentConfig(await req<unknown>("/api/review", jsonInit("POST", cfg)))
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
  out.default = normalizeSeat(o.default)
  const seats = o.seats
  if (seats && typeof seats === "object") {
    for (const [name, cfg] of Object.entries(seats as Record<string, unknown>)) {
      out.seats[name] = normalizeSeat(cfg)
    }
  }
  return out
}

export async function getSidekick(): Promise<SidekickConfig> {
  return normalizeSidekick(await req<unknown>("/api/sidekick"))
}

/** Create or update a seat. Use "default" for the default seat. */
export async function saveSeat(seat: string, config: SeatConfig): Promise<SidekickConfig> {
  return normalizeSidekick(await req<unknown>("/api/sidekick", jsonInit("POST", { seat, config })))
}

/** Delete a named seat (the default seat cannot be deleted, only reset). */
export async function deleteSeat(seat: string): Promise<SidekickConfig> {
  return normalizeSidekick(
    await req<unknown>("/api/sidekick", jsonInit("POST", { seat, config: null })),
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
  return req<ModesResponse>("/api/modes")
}

export async function saveMode(request: SaveModeRequest): Promise<ModesResponse> {
  return req<ModesResponse>("/api/modes", jsonInit("POST", request))
}

export async function applyMode(name: string): Promise<void> {
  await req<unknown>(`/api/modes/${encodeURIComponent(name)}/apply`, jsonInit("POST"))
}

export async function deleteMode(name: string): Promise<ModesResponse> {
  return req<ModesResponse>(`/api/modes/${encodeURIComponent(name)}`, { method: "DELETE" })
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
  const data = await req<SkillReposResponse>("/api/skill-repos")
  return data.repos ?? []
}

export async function manageSkillRepos(
  request: ManageSkillReposRequest,
): Promise<SkillReposResponse> {
  return req<SkillReposResponse>("/api/skill-repos", jsonInit("POST", request))
}

// ================================================================
// 7. Cache guard
// ================================================================

export async function getCacheGuard(): Promise<CacheGuardResponse> {
  return req<CacheGuardResponse>("/api/cache-guard")
}

/** null disables the guard. */
export async function setCacheGuard(tokens: number | null): Promise<CacheGuardResponse> {
  return req<CacheGuardResponse>("/api/cache-guard", jsonInit("POST", { tokens }))
}

// ================================================================
// 8. Misc — Dream + Workflow targets
// ================================================================

export async function runDream(): Promise<void> {
  await req<unknown>("/api/dream", jsonInit("POST", {}))
}

export interface WorkflowTarget {
  /** Semantic tag this target satisfies (e.g. "frontend", "research"). */
  tag: string
  provider: string
  model: string
  effort?: string | null
}

export interface WorkflowTargetsResponse {
  targets: WorkflowTarget[]
  automatic: boolean
}

function normalizeWorkflowTargets(data: unknown): WorkflowTargetsResponse {
  const out: WorkflowTargetsResponse = { targets: [], automatic: false }
  if (!data || typeof data !== "object") return out
  const o = data as Record<string, unknown>
  out.automatic = o.automatic === true
  if (Array.isArray(o.targets)) {
    for (const t of o.targets) {
      if (t && typeof t === "object") {
        const row = t as Record<string, unknown>
        if (typeof row.tag === "string" && typeof row.provider === "string" && typeof row.model === "string") {
          out.targets.push({
            tag: row.tag,
            provider: row.provider,
            model: row.model,
            effort: typeof row.effort === "string" ? row.effort : null,
          })
        }
      }
    }
  }
  return out
}

export async function getWorkflowTargets(): Promise<WorkflowTargetsResponse> {
  return normalizeWorkflowTargets(await req<unknown>("/api/workflow-targets"))
}

export async function putWorkflowTarget(target: WorkflowTarget): Promise<WorkflowTargetsResponse> {
  return normalizeWorkflowTargets(
    await req<unknown>("/api/workflow-targets", jsonInit("PUT", target)),
  )
}

export async function setWorkflowAutomatic(automatic: boolean): Promise<WorkflowTargetsResponse> {
  return normalizeWorkflowTargets(
    await req<unknown>("/api/workflow-targets", jsonInit("PUT", { automatic })),
  )
}

export async function deleteWorkflowTarget(tag: string): Promise<WorkflowTargetsResponse> {
  return normalizeWorkflowTargets(
    await req<unknown>(`/api/workflow-targets?tag=${encodeURIComponent(tag)}`, {
      method: "DELETE",
    }),
  )
}

// ================================================================
// 9. Onboarding
// ================================================================

export interface OnboardingProvider {
  id: string
  label: string
  ready: boolean
}

export interface SuggestedMode {
  name: string
  provider?: string
  model?: string
  effort?: string
  description?: string
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
        out.providers.push({
          id: row.id,
          label: typeof row.label === "string" ? row.label : providerLabel(row.id),
          ready: row.ready === true,
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
      if (typeof row.name === "string") {
        out.suggestedModes.push({
          name: row.name,
          provider: typeof row.provider === "string" ? row.provider : undefined,
          model: typeof row.model === "string" ? row.model : undefined,
          effort: typeof row.effort === "string" ? row.effort : undefined,
          description: typeof row.description === "string" ? row.description : undefined,
        })
      }
    }
  }
  return out
}

export async function getOnboarding(): Promise<OnboardingResponse> {
  return normalizeOnboarding(await req<unknown>("/api/onboarding"))
}

export async function applyOnboardingMode(name: string): Promise<void> {
  await req<unknown>("/api/onboarding/apply", jsonInit("POST", { mode: name }))
}

export async function completeOnboarding(): Promise<void> {
  await req<unknown>("/api/onboarding/complete", jsonInit("POST", {}))
}
