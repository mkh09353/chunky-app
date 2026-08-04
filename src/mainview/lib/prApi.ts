// Typed client for the local server's PR reviews API.
//
// Routes and DTOs come from @chunky/protocol — never forked, never invented.
// Shares configApi's base-URL + auth path (`req`/`jsonInit`) rather than
// forking a second one, exactly like relayApi.ts.
//
// Every response passes through a MAPPER before it reaches React. The mappers
// copy the contract's fields and nothing else, so a server that grew an extra
// field (a token, a raw API dump) could not land it in component state. They
// are exported because they are the unit under test.
import { ROUTES } from "@chunky/protocol"
import type {
  PrActionRequest,
  PrActionResponse,
  PrReviewsConfig,
  PrReviewsState,
  PrSummary,
  UpdatePrReviewsConfigRequest,
} from "@chunky/protocol"
import { HttpError, jsonInit, req } from "./configApi"

/** Shown when the connected server predates the PR reviews routes. */
export const PR_REVIEWS_UNSUPPORTED = "This Chunky server doesn't support PR reviews yet."

/**
 * `unsupported` means "this server has no such route", which is a different
 * thing from "the call failed" — the panel offers an explanation instead of a
 * retry button.
 */
export type PrFailure = { ok: false; unsupported: boolean; error: string }
export type PrResult<T extends object> = ({ ok: true } & T) | PrFailure

// ---- Mappers --------------------------------------------------------------

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null
}

const CI_STATUSES: PrSummary["ciStatus"][] = ["passing", "failing", "pending", "none"]
const REVIEW_DECISIONS: PrSummary["reviewDecision"][] = [
  "approved",
  "changes_requested",
  "review_required",
  "none",
]

function ciStatus(value: unknown): PrSummary["ciStatus"] {
  return CI_STATUSES.includes(value as PrSummary["ciStatus"])
    ? (value as PrSummary["ciStatus"])
    : "none"
}

function reviewDecision(value: unknown): PrSummary["reviewDecision"] {
  return REVIEW_DECISIONS.includes(value as PrSummary["reviewDecision"])
    ? (value as PrSummary["reviewDecision"])
    : "none"
}

/** A non-negative integer, or 0 — a NaN count must never reach a badge. */
function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}

/**
 * Copy only the contract's fields off one PR row. Returns null for anything
 * without the identity the UI needs (repo + number), so a malformed row is
 * dropped rather than rendered as an untitled card.
 */
export function toPrSummary(raw: unknown): PrSummary | null {
  if (!raw || typeof raw !== "object") return null
  const rec = raw as Partial<PrSummary>
  const repo = str(rec.repo)
  const number = typeof rec.number === "number" && Number.isFinite(rec.number) ? rec.number : null
  if (!repo || number === null) return null
  return {
    id: str(rec.id) ?? `${repo}#${number}`,
    number,
    title: str(rec.title) ?? `#${number}`,
    url: str(rec.url) ?? "",
    repo,
    headRef: str(rec.headRef) ?? "",
    author: str(rec.author) ?? "",
    isDraft: rec.isDraft === true,
    ciStatus: ciStatus(rec.ciStatus),
    reviewDecision: reviewDecision(rec.reviewDecision),
    unresolvedThreads: count(rec.unresolvedThreads),
    labels: Array.isArray(rec.labels)
      ? rec.labels.filter((l): l is string => typeof l === "string")
      : [],
    createdAt: str(rec.createdAt) ?? "",
    updatedAt: str(rec.updatedAt) ?? "",
    ...(str(rec.linkedSessionId) ? { linkedSessionId: str(rec.linkedSessionId)! } : {}),
  }
}

function toPrList(raw: unknown): PrSummary[] {
  if (!Array.isArray(raw)) return []
  return raw.map(toPrSummary).filter((pr): pr is PrSummary => pr !== null)
}

export function toPrReviewsState(raw: unknown): PrReviewsState {
  const rec = (raw ?? {}) as Partial<PrReviewsState>
  return {
    org: str(rec.org),
    configured: rec.configured === true,
    mine: toPrList(rec.mine),
    reviewQueue: toPrList(rec.reviewQueue),
    fetchedAt:
      typeof rec.fetchedAt === "number" && Number.isFinite(rec.fetchedAt) ? rec.fetchedAt : null,
    ...(str(rec.error) ? { error: str(rec.error)! } : {}),
  }
}

export function toPrReviewsConfig(raw: unknown): PrReviewsConfig {
  const rec = (raw ?? {}) as Partial<PrReviewsConfig>
  const orgs = Array.isArray(rec.orgs)
    ? rec.orgs.filter((o): o is string => typeof o === "string" && !!o.trim())
    : []
  return {
    ...(str(rec.org) ? { org: str(rec.org)! } : {}),
    ...(orgs.length ? { orgs } : {}),
    hasToken: rec.hasToken === true,
    ...(str(rec.readyLabel) ? { readyLabel: str(rec.readyLabel)! } : {}),
  }
}

export function toPrActionResponse(raw: unknown): PrActionResponse {
  const rec = (raw ?? {}) as Partial<PrActionResponse>
  const sessionId = str(rec.sessionId)
  if (!sessionId) throw new Error("The server started no session for this action.")
  return { sessionId, repoId: str(rec.repoId) ?? "" }
}

// ---- Errors ---------------------------------------------------------------

/** True when the server simply has no such route (older build). */
export function isUnsupported(err: unknown): boolean {
  return err instanceof HttpError && (err.status === 404 || err.status === 501)
}

/** A user-facing sentence for a failed PR reviews call. */
export function prErrorMessage(err: unknown): string {
  if (isUnsupported(err)) return PR_REVIEWS_UNSUPPORTED
  if (err instanceof HttpError) return err.message || `PR reviews request failed (${err.status})`
  return (err as Error)?.message || "PR reviews request failed."
}

async function guard<T extends object>(load: () => Promise<T>): Promise<PrResult<T>> {
  try {
    return { ok: true, ...(await load()) }
  } catch (err) {
    return { ok: false, unsupported: isUnsupported(err), error: prErrorMessage(err) }
  }
}

// ---- Requests -------------------------------------------------------------

/** The server's cached board. Cheap: safe to poll. */
export async function getPrReviews(): Promise<PrResult<{ state: PrReviewsState }>> {
  return guard(async () => ({ state: toPrReviewsState(await req<PrReviewsState>(ROUTES.prReviews)) }))
}

/** Force the server to poll GitHub again. */
export async function refreshPrReviews(): Promise<PrResult<{ state: PrReviewsState }>> {
  return guard(async () => ({
    state: toPrReviewsState(await req<PrReviewsState>(ROUTES.prReviewsRefresh, jsonInit("POST"))),
  }))
}

export async function getPrReviewsConfig(): Promise<PrResult<{ config: PrReviewsConfig }>> {
  return guard(async () => ({
    config: toPrReviewsConfig(await req<PrReviewsConfig>(ROUTES.prReviewsConfig)),
  }))
}

/** Omitted fields are left unchanged server-side; the token is write-only. */
export async function updatePrReviewsConfig(
  body: UpdatePrReviewsConfigRequest,
): Promise<PrResult<{ config: PrReviewsConfig }>> {
  return guard(async () => ({
    config: toPrReviewsConfig(
      await req<PrReviewsConfig>(ROUTES.prReviewsConfig, jsonInit("POST", body)),
    ),
  }))
}

/** Start a session that resolves this PR's review comments. */
export async function resolvePrComments(
  pr: PrActionRequest,
): Promise<PrResult<{ action: PrActionResponse }>> {
  return guard(async () => ({
    action: toPrActionResponse(
      await req<PrActionResponse>(ROUTES.prResolveComments, jsonInit("POST", pr)),
    ),
  }))
}

/** Start a session that reviews someone else's PR. */
export async function startPrReview(
  pr: PrActionRequest,
): Promise<PrResult<{ action: PrActionResponse }>> {
  return guard(async () => ({
    action: toPrActionResponse(
      await req<PrActionResponse>(ROUTES.prStartReview, jsonInit("POST", pr)),
    ),
  }))
}
