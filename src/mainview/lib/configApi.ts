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
  ModeSpec,
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

/** Make a provider the active one. */
export async function selectProvider(provider: string): Promise<void> {
  await req<unknown>(`/api/providers/${encodeURIComponent(provider)}/select`, jsonInit("POST"))
}

/** Register a custom OpenAI-compatible provider. Server field is `key`. */
export async function addCustomProvider(input: CustomProviderInput): Promise<void> {
  await req<unknown>(
    "/api/providers/custom",
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

export async function getSidekick(): Promise<SidekickConfig> {
  return normalizeSidekick(await req<unknown>("/api/sidekick"))
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
export async function saveDefaultSeat(config: SeatConfig): Promise<SidekickConfig> {
  return normalizeSidekick(await req<unknown>("/api/sidekick", jsonInit("POST", seatPatch(config))))
}

/** Save a NAMED seat. The server requires provider + model for named seats. */
export async function saveNamedSeat(seat: string, config: SeatConfig): Promise<SidekickConfig> {
  return normalizeSidekick(
    await req<unknown>(
      "/api/sidekick",
      jsonInit("POST", {
        seat,
        enabled: true,
        provider: config.provider,
        model: config.model,
        ...(config.effort ? { effort: config.effort } : {}),
      }),
    ),
  )
}

/** Delete a named seat — server maps { seat, enabled: false } to removal. */
export async function deleteSeat(seat: string): Promise<SidekickConfig> {
  return normalizeSidekick(
    await req<unknown>("/api/sidekick", jsonInit("POST", { seat, enabled: false })),
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
  return normalizeOnboarding(await req<unknown>("/api/onboarding"))
}

/** Apply a suggested mode. Server body is { mode: ModeSpec, name? }. */
export async function applyOnboardingMode(mode: SuggestedMode): Promise<void> {
  await req<unknown>("/api/onboarding/apply", jsonInit("POST", { mode: mode.spec, name: mode.name }))
}

export async function completeOnboarding(): Promise<void> {
  await req<unknown>("/api/onboarding/complete", jsonInit("POST", {}))
}
