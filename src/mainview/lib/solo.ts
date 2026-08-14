// SOLO: "this model runs alone".
//
// Picking a raw model (composer picker / `/model`) now puts the server into
// SOLO for that scope — a session-scoped pick pins the session, a global pick
// moves the default. In solo the server suppresses the sidekick, every named
// seat, the reviewer and the mode's advisor; the ONLY delegate that may run is
// the separately opted-in "solo advisor" (GET/POST ROUTES.soloAdvisor).
//
// The wire truth lives on the selection itself (`ModelSelection.solo`, from GET
// /api/model — with `?sessionId=` for a session) and, as a global fallback, on
// `ModesResponse.current.solo`. This module is the one place that folds those
// sources into the single boolean the UI paints, mirroring the server's own
// resolution order (../chunky packages/server/src/providers/registry.ts
// `isSolo`): a session's PIN decides for that session, otherwise the global
// state does. It is pure so the semantics stay testable without React.
import type { ModelSelection } from "./api"
import { prettyModel } from "./api"

export interface SoloResolutionInput {
  /** Demo/offline never claims solo — there is no server state to claim it from. */
  live: boolean
  /** The attached session, or null when nothing is attached. */
  sessionId: string | null
  /** Session-pinned selections, keyed by session id (App's `sessionModelSel`). */
  sessionModelSel?: Record<string, ModelSelection | undefined> | null
  /** The global default selection (App's `modelSel`). */
  modelSel?: ModelSelection | null
  /** `SessionAgentConfigResponse.selection.solo` for the attached session — the
   *  server's own answer for THIS session. It outranks the global default
   *  (which describes another scope entirely) but not the session's pin, whose
   *  optimistic write is the newer of the two right after a raw pick. */
  sessionSolo?: boolean | null
  /** `ModesResponse.current.solo` — the global state as /api/modes reports it,
   *  used only when the global selection hasn't been re-read yet. */
  currentSolo?: boolean | null
}

/**
 * Is the attached scope in solo right now?
 *
 * A session-pinned selection is authoritative FOR THAT SESSION: its `solo`
 * decides even when the global default disagrees (another session may still be
 * running a mode). With no local pin, the session's own authoritative snapshot
 * (`sessionSolo`) answers next — a session running a mode has no raw pin left,
 * and the global default describes a different scope. Only then does the global
 * state answer, preferring the selection's own flag and falling back to
 * /api/modes' `current.solo`.
 */
export function isSoloActive(input: SoloResolutionInput): boolean {
  if (!input.live) return false
  const pinned = input.sessionId ? input.sessionModelSel?.[input.sessionId] : undefined
  if (pinned) return pinned.solo === true
  // A session the client holds no pin for may still be isolated from the global
  // default server-side (applying a mode to it clears the raw pin), so its own
  // authoritative snapshot answers before the global state gets a say.
  if (input.sessionId && typeof input.sessionSolo === "boolean") return input.sessionSolo
  if (typeof input.modelSel?.solo === "boolean") return input.modelSel.solo
  return input.currentSolo === true
}

/** The advisor half of solo, in the app's usual agent-config shape. */
export interface SoloAdvisorLike {
  enabled: boolean
  model?: string | null
  provider?: string | null
  effort?: string | null
}

/** True when the solo advisor is actually configured to run (on + has a model). */
export function soloAdvisorRuns(advisor: SoloAdvisorLike | null | undefined): boolean {
  return advisor?.enabled === true && !!advisor.model
}

/** One `name — value` line of a solo breakdown (a status tooltip / flyout). */
export interface SoloLine {
  name: string
  model: string
}

/**
 * What solo actually resolves to, spelled out for a hover surface: the executor,
 * the solo advisor when it runs, and — always — the fact that nothing else does.
 * That last line is the point: it is what stops a saved mode's delegates from
 * being read as live.
 */
export function soloLines(
  executorLabel: string,
  advisor: SoloAdvisorLike | null | undefined,
  /** `false` when the advisor is configured but the server can't resolve it. */
  advisorActive = true,
): SoloLine[] {
  const lines: SoloLine[] = [{ name: "executor", model: executorLabel }]
  if (soloAdvisorRuns(advisor)) {
    const model = prettyModel(advisor?.model)
    lines.push({ name: "solo advisor", model: advisorActive ? model : `${model} (unavailable)` })
  }
  lines.push({ name: "delegates", model: "none — solo" })
  return lines
}

/** The one-line explanation reused by the picker, the flyout and the tooltip. */
export const SOLO_EXPLAINER =
  "Solo: this model runs alone — no sidekick, seats or reviewer. Only the solo advisor can run."
