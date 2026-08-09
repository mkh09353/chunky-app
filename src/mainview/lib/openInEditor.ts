// Webview bridge for "open this file in my editor" (see src/bun/openInEditor.ts).
//
// Same shape as lib/openExternal.ts: the renderer never touches the OS itself,
// it asks the Bun process over RPC. Unlike openExternal there is no browser
// fallback — a plain `bun run dev:web` tab has no way to open a local file, so
// callers check `editorLinksAvailable()` first and simply do not offer the
// affordance. Bun re-validates everything; this side is a courier.

import type { FileRef } from "./fileLinks"
import { getRpc, nativeRpcAvailable } from "./rpc"

export interface EditorRequest extends FileRef {
  /** Directory a relative path is resolved against — the session's repo. */
  cwd?: string
}

export interface EditorResult {
  ok: boolean
  path?: string
  error?: string
}

/** True only inside the desktop app, where the RPC bridge exists. */
export function editorLinksAvailable(): boolean {
  return nativeRpcAvailable()
}

/** URLs are openExternal's job; this door stays shut for them. */
function transportable(path: unknown): path is string {
  if (typeof path !== "string") return false
  const value = path.trim()
  if (!value || value.length > 4096) return false
  return !/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value)
}

/**
 * Ask Bun to open `request` in the user's editor. Resolves false (never throws)
 * when the bridge is missing, the request is malformed or the file could not be
 * opened, so a click can stay silent.
 */
export async function openInEditor(request: EditorRequest): Promise<boolean> {
  if (!transportable(request?.path)) return false
  if (!nativeRpcAvailable()) return false
  const rpc = await getRpc()
  const fn = rpc?.request?.openInEditor
  if (!fn) return false
  const payload = {
    path: request.path.trim(),
    ...(typeof request.line === "number" ? { line: request.line } : {}),
    ...(typeof request.column === "number" ? { column: request.column } : {}),
    ...(request.cwd ? { cwd: request.cwd } : {}),
  }
  try {
    const raw = (await fn(payload)) as EditorResult | null
    return !!raw && typeof raw === "object" && raw.ok === true
  } catch {
    return false
  }
}
