// Bun-main-only filesystem operations exposed to the webview over RPC.
// The renderer has no filesystem of its own, so "create a new folder" in the
// Add Repository popover lands here.
//
// Nothing in this module goes near a shell: the only mutation is a node:fs
// mkdir, and the target is rebuilt from a validated absolute parent plus a
// single, separator-free name (never a caller-supplied path).
import { existsSync, mkdirSync, statSync } from "node:fs"
import { dirname, isAbsolute, join, resolve } from "node:path"

export type CreateDirectoryResult = {
  ok: boolean
  /** Absolute path of the folder (also set when it already existed). */
  path: string | null
  error?: string
  /** True when nothing was created because something is already there. */
  existed?: boolean
}

/** macOS/APFS caps a single component at 255 bytes; stay well-defined. */
const MAX_NAME = 255
/** Separators and control characters — anything that could escape the parent. */
const BAD_NAME = /[\\/\u0000-\u001f]/

/** An existing, absolute directory, resolved — or null. */
export function validParentDir(value: unknown): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  if (!trimmed || !isAbsolute(trimmed) || trimmed.includes("\0")) return null
  try {
    const abs = resolve(trimmed)
    return existsSync(abs) && statSync(abs).isDirectory() ? abs : null
  } catch {
    return null
  }
}

/** A single folder component, or the message explaining why it isn't one. */
export function validFolderName(value: unknown): { name: string } | { error: string } {
  const name = typeof value === "string" ? value.trim() : ""
  if (!name) return { error: "Enter a folder name." }
  if (name === "." || name === "..") return { error: "Choose a real folder name." }
  if (BAD_NAME.test(name)) return { error: "Folder names can't contain slashes." }
  if (Buffer.byteLength(name, "utf8") > MAX_NAME) return { error: "That folder name is too long." }
  return { name }
}

/** Human-readable reason a mkdir failed, from the errno when there is one. */
function mkdirError(err: unknown, name: string): string {
  const code = (err as { code?: string } | null)?.code
  switch (code) {
    case "EACCES":
    case "EPERM":
    case "EROFS":
      return "Permission denied — pick a folder you can write to."
    case "EEXIST":
      return `“${name}” already exists in that folder.`
    case "ENOSPC":
      return "There's no space left on that disk."
    case "ENAMETOOLONG":
      return "That folder name is too long."
    default:
      return err instanceof Error && err.message ? err.message : "Couldn't create that folder."
  }
}

/**
 * The result for a target that was already taken. Reached only from a real
 * EEXIST, so it reports what is actually on disk right now — including a
 * dangling symlink, which `existsSync` would have called "free".
 */
function alreadyThere(target: string, name: string): CreateDirectoryResult {
  let isDir = false
  try {
    isDir = statSync(target).isDirectory()
  } catch {
    /* dangling symlink or unreadable — still occupied, just not by a directory */
  }
  return {
    ok: false,
    path: target,
    existed: true,
    error: isDir
      ? `“${name}” already exists here — add it as an existing folder instead.`
      : `Something named “${name}” is already here.`,
  }
}

/**
 * Create `<parentDir>/<name>`. Never overwrites: an existing file or directory
 * at the target is reported back (ok:false, existed:true) rather than reused,
 * so the UI can tell the user instead of silently registering someone else's
 * folder.
 * Input: { parentDir: string (absolute, existing), name: string (one component) }
 * Output: CreateDirectoryResult
 */
export async function createDirectory(
  params: { parentDir?: unknown; name?: unknown } = {},
): Promise<CreateDirectoryResult> {
  const parent = validParentDir(params?.parentDir)
  if (!parent) {
    return { ok: false, path: null, error: "Choose an existing folder to create it in." }
  }
  const checked = validFolderName(params?.name)
  if ("error" in checked) return { ok: false, path: null, error: checked.error }

  const target = join(parent, checked.name)
  // Belt and braces: the name is separator-free, so this can only fail if the
  // validation above ever loosens.
  if (resolve(target) !== target || dirname(target) !== parent) {
    return { ok: false, path: null, error: "Choose a real folder name." }
  }

  // ATOMIC: a plain mkdir is the existence check. `recursive: true` would
  // swallow EEXIST (silently "succeeding" on someone else's directory) and
  // would create intermediate parents — neither is wanted here, where the
  // parent is already validated to exist and the name is one component.
  // A separate existsSync() pre-check would also lose the race between the
  // check and the create.
  try {
    mkdirSync(target)
  } catch (err) {
    if ((err as { code?: string } | null)?.code === "EEXIST") {
      return alreadyThere(target, checked.name)
    }
    return { ok: false, path: null, error: mkdirError(err, checked.name) }
  }
  return { ok: true, path: target }
}
