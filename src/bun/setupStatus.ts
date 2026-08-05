// First-run setup progress: the one place Bun's install/startup stages are
// funnelled through on their way to the webview.
//
// A fresh install downloads a runtime release, extracts it, installs its
// dependencies (possibly twice) and starts a server — minutes during which the
// renderer otherwise shows only "Connecting to Chunky server…". The installer
// and the connection manager report stages here; `src/bun/index.ts` attaches
// the RPC sender once the window's RPC exists.
//
// Reporting is strictly best-effort: it carries no credentials, and a throwing
// or missing reporter must never disturb an install or connection resolution.

/** RPC message name for a stage push. Mirrored in the renderer's setupStatus. */
export const SETUP_STAGE_MESSAGE = "chunkySetupStage"

/**
 * A step of first-run setup. Deliberately structured (not prose) so the
 * renderer owns the wording; `percent` is only present when the archive's
 * Content-Length was known.
 */
export type SetupStage =
  /** Asking GitHub which release is current. */
  | { kind: "checking" }
  /** Downloading the release archive; percent when the size is known. */
  | { kind: "downloading"; version?: string; percent?: number }
  /** Unpacking the archive into the staging directory. */
  | { kind: "extracting"; version?: string }
  /** `bun install` inside the staged runtime; attempt 2 is the known retry. */
  | { kind: "installing"; version?: string; attempt?: number }
  /** Checking the staged runtime before it is allowed to replace the live one. */
  | { kind: "verifying"; version?: string }
  /** Spawning the Chunky server and waiting for it to answer. */
  | { kind: "starting" }

export type SetupStageReporter = (stage: SetupStage) => void

let reporter: SetupStageReporter | null = null

/** Install the sink stages are pushed to (null detaches). */
export function setSetupStageReporter(next: SetupStageReporter | null): void {
  reporter = next
}

/**
 * Report a stage. Never throws: progress is a nicety, and the install it
 * describes must not fail because the webview went away mid-download.
 */
export function reportSetupStage(stage: SetupStage): void {
  try {
    reporter?.(stage)
  } catch {
    /* best-effort by design */
  }
}

/** Test seam: forget any attached reporter. */
export function resetSetupStageReporterForTest(): void {
  reporter = null
}
