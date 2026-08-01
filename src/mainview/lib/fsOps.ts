// Webview bridge for bun-main filesystem operations (see src/bun/fsOps.ts).
// The renderer never touches the filesystem itself — RPC only. Validation is
// duplicated here purely so the form can complain before a round trip; Bun
// re-validates everything and is the authority.

import { getRpc, nativeRpcAvailable } from "./rpc"

export type CreateDirectoryResult = {
  ok: boolean
  path: string | null
  error?: string
  existed?: boolean
}

/** Folder creation exists only in the desktop app (no RPC in the web build). */
export function nativeFsAvailable(): boolean {
  return nativeRpcAvailable()
}

/** Filesystem limit on one path component, in BYTES (matches src/bun/fsOps.ts). */
const MAX_NAME_BYTES = 255

/** UTF-8 byte length, browser-safe (no node:buffer in the renderer). */
function byteLength(value: string): number {
  return typeof TextEncoder !== "undefined"
    ? new TextEncoder().encode(value).length
    : // Pathological fallback only: assume the worst case rather than
      // under-count and let through a name Bun will reject.
      value.length * 4
}

/** Inline validation message for a folder name, or null when it's usable.
 *  Mirrors Bun's rules (src/bun/fsOps.ts) so the form's complaint matches the
 *  authority's - Bun still re-validates and has the final say. */
export function folderNameError(raw: string): string | null {
  const name = (raw ?? "").trim()
  if (!name) return "Enter a folder name."
  if (name === "." || name === "..") return "Choose a real folder name."
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting them is the point
  if (/[\\/\u0000-\u001f]/.test(name)) return "Folder names can't contain slashes."
  // Bytes, not UTF-16 units: accented and emoji characters cost more than one
  // byte on disk, so a character count would let names through that Bun rejects.
  if (byteLength(name) > MAX_NAME_BYTES) return "That folder name is too long."
  return null
}

/**
 * Create `<parentDir>/<name>` in the Bun main process. Resolves with
 * `ok: false` and a human-readable error rather than throwing, so callers can
 * render the failure inline.
 */
export async function createDirectory(params: {
  parentDir: string
  name: string
}): Promise<CreateDirectoryResult> {
  const parentDir = (params.parentDir ?? "").trim()
  const name = (params.name ?? "").trim()
  if (!parentDir.startsWith("/")) {
    return { ok: false, path: null, error: "Choose an absolute parent folder." }
  }
  const nameError = folderNameError(name)
  if (nameError) return { ok: false, path: null, error: nameError }

  if (!nativeRpcAvailable()) {
    return { ok: false, path: null, error: "Creating folders needs the Chunky desktop app." }
  }
  const rpc = await getRpc()
  const fn = rpc?.request?.createDirectory
  if (!fn) return { ok: false, path: null, error: "Creating folders is unavailable." }

  try {
    const raw = (await fn({ parentDir, name })) as Partial<CreateDirectoryResult> | null
    if (!raw || typeof raw !== "object") {
      return { ok: false, path: null, error: "Couldn't create that folder." }
    }
    const path = typeof raw.path === "string" && raw.path.trim() ? raw.path.trim() : null
    if (raw.ok === true && path) return { ok: true, path }
    return {
      ok: false,
      path,
      existed: raw.existed === true,
      error: typeof raw.error === "string" && raw.error ? raw.error : "Couldn't create that folder.",
    }
  } catch (err) {
    return {
      ok: false,
      path: null,
      error: err instanceof Error ? err.message : "Couldn't create that folder.",
    }
  }
}
