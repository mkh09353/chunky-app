// Deciding whether a scrap of assistant prose is a file path.
//
// Assistants mention files constantly — usually inside `inline code` — and a
// path is the one token in a transcript worth clicking. This module is the
// whole decision, kept pure (no DOM, no RPC) so the heuristics can be pinned
// down by tests; the chip and the editor hand-off live elsewhere.
//
// The bias is deliberate and one-sided: MISSING a real path is a shrug, but
// turning `npm install`, `@chunky/protocol` or `https://x.dev/a.ts` into a
// clickable "open in editor" chip is a bug the user feels. Every rule below
// therefore prefers a false negative.

export interface FileRef {
  /** The path as written, with any `:line:col` suffix removed. */
  path: string
  /** 1-based line, when the token carried one. */
  line?: number
  /** 1-based column, when the token carried one. */
  column?: number
}

/** Absolute prefixes that are real filesystem roots rather than URL routes.
 *  `/app/settings` is a route; `/Users/me/app/settings.ts` is a file. */
const ABSOLUTE_ROOTS = [
  "/Users/",
  "/home/",
  "/tmp/",
  "/etc/",
  "/opt/",
  "/var/",
  "/Volumes/",
  "/private/",
  "/workspace/",
  "/workspaces/",
  "/srv/",
  "/mnt/",
]

/**
 * Extensions a *bare* filename is allowed to have. A lone token has no path
 * structure to corroborate it, so `chunky.dev`, `v1.2` and `React.memo` must
 * not pass — only an extension that reads as source or config does.
 */
const KNOWN_EXTENSIONS = new Set([
  "astro", "bash", "bat", "c", "cc", "cfg", "cjs", "conf", "cpp", "cs", "css",
  "csv", "diff", "dockerfile", "env", "fish", "gemspec", "gitignore", "go",
  "gql", "gradle", "graphql", "h", "hpp", "htm", "html", "ini", "ipynb", "java",
  "js", "json", "jsonc", "jsx", "kt", "kts", "less", "lock", "log", "lua",
  "map", "md", "mdx", "mjs", "mts", "patch", "php", "pl", "plist", "properties",
  "proto", "py", "rb", "rs", "sass", "scss", "sh", "snap", "sql", "svelte",
  "swift", "tf", "tfvars", "toml", "ts", "tsv", "tsx", "txt", "vue", "wasm",
  "xml", "yaml", "yml", "zsh",
])

/** Hostname endings that make a slash-token a URL fragment, not a path. */
const HOST_SUFFIX =
  /^(?:www\.[\w.-]+|[\w-]+(?:\.[\w-]+)*\.(?:com|dev|io|net|org|ai|app|co|me|gg|xyz|edu|gov|info|uk|de|fr|jp|cn))$/i

/** Characters that would only appear in a command line, a glob or a URL. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting them is the point
const HOSTILE = /[\s\u0000-\u001f|&;<>$(){}\[\]*?!"'`\\=,+]/

const MAX_LENGTH = 512

/** Trailing `:42` / `:42:7`, split off before the path itself is judged. */
function splitPosition(raw: string): { path: string; line?: number; column?: number } {
  const m = /^(.+?):(\d{1,7})(?::(\d{1,7}))?$/.exec(raw)
  if (!m) return { path: raw }
  const line = Number.parseInt(m[2] ?? "", 10)
  if (!Number.isFinite(line) || line < 1) return { path: raw }
  const col = m[3] === undefined ? undefined : Number.parseInt(m[3], 10)
  const out: { path: string; line?: number; column?: number } = { path: m[1] ?? "", line }
  if (col !== undefined && Number.isFinite(col) && col >= 1) out.column = col
  return out
}

/** The `ts` of `src/a.ts`, lowercased; "" when the segment has no extension. */
function extensionOf(segment: string): string {
  const dot = segment.lastIndexOf(".")
  // `.env` (leading dot, nothing before it) is not treated as an extension:
  // a bare dotfile has too little signal to risk.
  if (dot <= 0 || dot === segment.length - 1) return ""
  const ext = segment.slice(dot + 1)
  return /^[A-Za-z0-9_]{1,12}$/.test(ext) ? ext.toLowerCase() : ""
}

/** True when the token is (or pretends to be) a URL, a scheme or a host. */
function urlish(value: string): boolean {
  if (value.includes("://") || value.includes("//")) return true
  // `mailto:x`, `file:/x`, `C:/x` — anything scheme-shaped. The `:42` suffix is
  // already gone by the time this runs, so a stray colon is suspicious.
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)) return true
  if (value.includes(":")) return true
  const first = value.split("/")[0] ?? ""
  return HOST_SUFFIX.test(first)
}

/**
 * Parse `raw` as a file reference, or return null.
 *
 * Accepted shapes:
 *   - `~/notes/todo.md`, `./a.ts`, `../b/c.tsx`
 *   - `src/mainview/lib/markdown.tsx` (relative, has a `/` and an extension)
 *   - `/Users/me/p/x.ts` and friends (absolute under a real filesystem root)
 *   - `package.json` (bare, but with a source-ish extension)
 * each optionally suffixed `:line` or `:line:col`.
 *
 * Everything else — URLs, `@scope/pkg`, anything with whitespace or shell
 * punctuation, route-like `/app/x`, bare words — returns null. Partial input
 * from a stream (`src/`, `sr`, `` `src/a.ts ``) simply fails to match.
 */
export function parseFileRef(raw: unknown): FileRef | null {
  if (typeof raw !== "string") return null
  const trimmed = raw.trim()
  if (!trimmed || trimmed.length > MAX_LENGTH) return null
  if (HOSTILE.test(trimmed)) return null
  // A package specifier (`@chunky/protocol`) and a flag (`--out`) are never
  // paths; a bare `-` prefix is a command argument.
  if (trimmed.startsWith("@") || trimmed.startsWith("-")) return null

  const { path, line, column } = splitPosition(trimmed)
  if (!path || urlish(path)) return null
  if (path.endsWith("/")) return null

  const ref: FileRef = { path }
  if (line !== undefined) ref.line = line
  if (column !== undefined) ref.column = column

  const segments = path.split("/")
  const last = segments[segments.length - 1] ?? ""
  if (!last) return null
  // No empty interior segment (`a//b` is already rejected by `urlish`, this
  // catches a leading `/` on a non-root absolute path).
  if (segments.slice(1, -1).some((s) => s === "")) return null

  // Home-relative and explicitly-relative paths announce themselves.
  if (path.startsWith("~/") || path.startsWith("./") || path.startsWith("../")) {
    return path.length > 2 ? ref : null
  }
  if (path === "~" || path.startsWith("~")) return null

  // Absolute: only under a genuine filesystem root, never a route.
  if (path.startsWith("/")) {
    return ABSOLUTE_ROOTS.some((root) => path.startsWith(root)) ? ref : null
  }

  // Relative with structure: a slash plus an extension on the final segment.
  if (segments.length > 1) {
    if (segments[0] === "") return null
    return extensionOf(last) ? ref : null
  }

  // Bare filename: the extension has to carry the whole argument.
  return KNOWN_EXTENSIONS.has(extensionOf(last)) ? ref : null
}

/** Convenience predicate for callers that only need the yes/no. */
export function isFileRef(raw: unknown): boolean {
  return parseFileRef(raw) !== null
}

/** `src/a.ts:12:3` — the reference written back out, for tooltips and argv. */
export function formatFileRef(ref: FileRef): string {
  if (ref.line === undefined) return ref.path
  return ref.column === undefined
    ? `${ref.path}:${ref.line}`
    : `${ref.path}:${ref.line}:${ref.column}`
}
