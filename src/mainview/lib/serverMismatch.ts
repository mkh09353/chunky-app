import type { ServerInfoResponse } from "@chunky/protocol"

export interface InstalledRuntimeIdentity {
  version: string
  buildId: string
}

function isLocalServer(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl)
    return url.hostname === "localhost" || url.hostname === "127.0.0.1"
  } catch {
    return false
  }
}

export function serverMismatchWarning(
  baseUrl: string,
  installedRuntime: InstalledRuntimeIdentity | null | undefined,
  info: ServerInfoResponse,
): string | null {
  if (info.channel === "dev" && info.version) {
    return `Connected to a development Chunky server (v${info.version}) — shipped fixes may be missing`
  }
  if (
    info.channel === "managed" &&
    isLocalServer(baseUrl) &&
    installedRuntime &&
    info.version &&
    info.version !== installedRuntime.version
  ) {
    return `Server v${info.version} does not match installed runtime v${installedRuntime.version}`
  }
  return null
}
