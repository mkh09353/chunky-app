// First-run setup progress, renderer side.
//
// A fresh install has Bun download a Chunky runtime release, extract it,
// install its dependencies and start a server before `getConfig` can resolve —
// minutes behind a bare "Connecting to Chunky server…". Bun pushes structured
// stages over the existing fire-and-forget RPC message channel (the same one
// `chunkyServerChanged` and terminal output use); this module parses them and
// turns them into the single status line the connecting banner shows.
//
// Nothing here is persisted: the line is disposable UI state that disappears
// the moment the connection resolves.
import { getRpc, type RpcMessageListener } from "./rpc"

/** RPC message name Bun pushes stages under (mirrors src/bun/setupStatus.ts). */
export const SETUP_STAGE_MESSAGE = "chunkySetupStage"

export type SetupStageKind =
  | "checking"
  | "downloading"
  | "extracting"
  | "installing"
  | "verifying"
  | "starting"

export interface SetupStage {
  kind: SetupStageKind
  /** Release being installed, when known. */
  version?: string
  /** Download progress, 0–100; absent when the archive size is unknown. */
  percent?: number
  /** `bun install` attempt; 2 is the known native-binary retry. */
  attempt?: number
}

const KINDS: readonly SetupStageKind[] = [
  "checking",
  "downloading",
  "extracting",
  "installing",
  "verifying",
  "starting",
]

/** Validate an untrusted RPC payload; anything unrecognised is ignored. */
export function parseSetupStage(payload: unknown): SetupStage | null {
  if (!payload || typeof payload !== "object") return null
  const value = payload as { kind?: unknown; version?: unknown; percent?: unknown; attempt?: unknown }
  if (typeof value.kind !== "string" || !KINDS.includes(value.kind as SetupStageKind)) return null

  const stage: SetupStage = { kind: value.kind as SetupStageKind }
  if (typeof value.version === "string" && value.version) stage.version = value.version
  if (typeof value.percent === "number" && Number.isFinite(value.percent)) {
    stage.percent = Math.max(0, Math.min(100, Math.round(value.percent)))
  }
  if (typeof value.attempt === "number" && Number.isFinite(value.attempt)) {
    stage.attempt = Math.round(value.attempt)
  }
  return stage
}

/**
 * The one-line, human-readable form of a stage. Returns null for "nothing to
 * say", so callers can fall back to their normal connecting text.
 */
export function describeSetupStage(stage: SetupStage | null): string | null {
  if (!stage) return null
  switch (stage.kind) {
    case "checking":
      return "Checking for the latest Chunky runtime…"
    case "downloading":
      return stage.percent === undefined
        ? "Downloading Chunky runtime…"
        : `Downloading Chunky runtime (${stage.percent}%)…`
    case "extracting":
      return "Extracting Chunky runtime…"
    case "installing":
      // The second pass is the installer's own retry, not a new step — saying so
      // beats a status line that appears to go backwards.
      return stage.attempt && stage.attempt > 1
        ? "Installing dependencies (retrying)…"
        : "Installing dependencies…"
    case "verifying":
      return "Verifying Chunky runtime…"
    case "starting":
      return "Starting Chunky server…"
    default:
      return null
  }
}

/**
 * Listen for setup stages from Bun. Returns an unsubscribe function; a no-op
 * without the native bridge (plain browser dev), where no install happens.
 *
 * Resolves once the listener is attached so callers can subscribe BEFORE the
 * request that triggers the install (`getConfig`) goes out.
 */
export async function subscribeSetupStage(
  handler: (stage: SetupStage) => void,
): Promise<() => void> {
  let attached: RpcMessageListener | null = null
  try {
    const rpc = await getRpc()
    if (rpc?.addMessageListener) {
      const listener: RpcMessageListener = (payload) => {
        const stage = parseSetupStage(payload)
        if (stage) handler(stage)
      }
      attached = listener
      rpc.addMessageListener(SETUP_STAGE_MESSAGE, listener)
    }
  } catch {
    /* progress is optional; never block the boot path */
  }

  return () => {
    const listener = attached
    if (!listener) return
    attached = null
    void getRpc()
      .then((rpc) => rpc?.removeMessageListener?.(SETUP_STAGE_MESSAGE, listener))
      .catch(() => {})
  }
}
