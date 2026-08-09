// Opening a file the assistant mentioned in the user's editor.
//
// The renderer detects the path (src/mainview/lib/fileLinks.ts) and asks Bun to
// open it; this module is the authority. Two rules matter more than anything
// else here:
//   1. Nothing the renderer sends ever reaches a shell. Every launch is an
//      argv array handed to Bun.spawn — no interpolation, no `sh -c`.
//   2. A path is resolved and `stat`ed before it is handed to anything. A
//      reference that does not exist on disk is refused, not guessed at.
//
// Everything is injectable so the resolution and argv rules can be tested
// without a filesystem, an editor or a spawn.

import { isAbsolute, resolve } from "node:path"

export interface EditorTarget {
  path: string
  /** 1-based; ignored unless the editor supports positions. */
  line?: number
  column?: number
  /** Absolute directory a relative path is resolved against (the repo). */
  cwd?: string
}

export interface EditorResult {
  ok: boolean
  /** The absolute path that was opened, for logs and tests. */
  path?: string
  error?: string
}

export interface EditorDeps {
  /** Absolute home directory, for `~` expansion. */
  home: () => string
  /** Resolved path → does it exist? (null when it does not / cannot be read). */
  stat: (path: string) => Promise<{ isDirectory: boolean } | null>
  /** Absolute path of a CLI on PATH, or null. */
  which: (command: string) => string | null
  /** Launch argv. Never a shell string. */
  spawn: (argv: string[]) => Promise<{ exitCode: number; stderr: string }>
}

const MAX_PATH_LENGTH = 4096

/**
 * Reject the shapes that should never have left the renderer. Spaces are fine
 * (`/Users/me/My Project/a.ts` is an ordinary macOS path, and an argv array
 * carries it safely); NUL and control characters are not a path.
 */
function invalid(value: string): boolean {
  if (!value || value.length > MAX_PATH_LENGTH) return true
  for (const ch of value) if (ch.charCodeAt(0) < 0x20) return true
  return false
}

/**
 * `~/a.ts` → `/Users/me/a.ts`; `src/a.ts` + cwd → `<cwd>/src/a.ts`; an absolute
 * path is normalised and returned. Returns null when the input is unusable or
 * when a relative path has no directory to resolve against — the click is then
 * simply refused rather than opening something arbitrary.
 */
export function resolveEditorPath(
  rawPath: string,
  options: { home: string; cwd?: string | undefined },
): string | null {
  if (typeof rawPath !== "string") return null
  const value = rawPath.trim()
  if (invalid(value)) return null
  // A URL is openExternal's job, never this one.
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value)) return null

  const home = options.home
  if (value === "~" || value.startsWith("~/")) {
    if (!home || !isAbsolute(home)) return null
    return resolve(home, value === "~" ? "." : value.slice(2))
  }
  // `~user/…` is a shell expansion this process does not implement.
  if (value.startsWith("~")) return null

  if (isAbsolute(value)) return resolve(value)

  const cwd = options.cwd?.trim()
  if (!cwd || !isAbsolute(cwd) || invalid(cwd)) return null
  return resolve(cwd, value)
}

/**
 * The command to launch, as an argv array.
 *
 * VS Code's CLI can place the caret (`code -g file:line:col`), so it wins when
 * it is installed. Otherwise the platform opener gets the file, which respects
 * whatever the user has associated with that file type. `$EDITOR` is
 * deliberately NOT used: it is usually a terminal editor with no terminal to
 * run in here.
 */
export function editorArgv(
  path: string,
  options: { line?: number | undefined; column?: number | undefined; codeCli?: string | null },
): string[] {
  const code = options.codeCli
  if (code) {
    const line = positive(options.line)
    if (line) {
      const column = positive(options.column)
      return [code, "-g", column ? `${path}:${line}:${column}` : `${path}:${line}`]
    }
    return [code, "-g", path]
  }
  return ["open", path]
}

function positive(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 1
    ? Math.floor(value)
    : null
}

/**
 * Resolve → stat → spawn. Returns a plain result object; failures are reported,
 * never thrown, so the renderer can stay silent about them.
 */
export async function openInEditor(
  target: EditorTarget,
  deps: EditorDeps,
): Promise<EditorResult> {
  const raw = typeof target?.path === "string" ? target.path : ""
  const path = resolveEditorPath(raw, { home: deps.home(), cwd: target?.cwd })
  if (!path) return { ok: false, error: "Unresolvable path" }

  const info = await deps.stat(path).catch(() => null)
  if (!info) return { ok: false, path, error: "File not found" }

  // A directory has no caret to place; the platform opener handles it fine.
  const codeCli = deps.which("code")
  const argv = editorArgv(path, {
    line: info.isDirectory ? undefined : target?.line,
    column: info.isDirectory ? undefined : target?.column,
    codeCli,
  })
  try {
    const { exitCode, stderr } = await deps.spawn(argv)
    if (exitCode !== 0) {
      return { ok: false, path, error: stderr.trim() || `${argv[0]} exited with ${exitCode}` }
    }
    return { ok: true, path }
  } catch (err) {
    return { ok: false, path, error: err instanceof Error ? err.message : "Failed to open" }
  }
}
