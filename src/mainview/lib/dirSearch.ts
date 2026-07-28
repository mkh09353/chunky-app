// Webview bridge for bun-main FFF directory search.
// Never imports @ff-labs/fff-bun — RPC only.

import { getRpc, nativeRpcAvailable } from "./rpc"

export type DirSearchHit = { name: string; path: string }

export type DirSearchResponse = {
  items: DirSearchHit[]
  error?: string
}

export function nativeDirSearchAvailable(): boolean {
  return nativeRpcAvailable()
}

/**
 * Existing, bounded roots a clone can be dropped into (~/code, ~/Projects, …).
 * Empty in the browser build — the destination field then starts from the
 * active repo's parent instead.
 */
export async function cloneRoots(): Promise<string[]> {
  const rpc = await getRpc()
  const fn = rpc?.request?.cloneRoots
  if (!fn) return []
  try {
    const raw = (await fn()) as { roots?: unknown } | null
    if (!raw || !Array.isArray(raw.roots)) return []
    return raw.roots.filter((r): r is string => typeof r === "string" && r.startsWith("/"))
  } catch {
    return []
  }
}

/**
 * Fuzzy directory search under bounded roots in the Electrobun main process.
 * Returns empty items (and optional error) when RPC is unavailable.
 */
export async function searchDirectories(
  query: string,
  limit = 12,
): Promise<DirSearchResponse> {
  const q = query.trim()
  if (!q) return { items: [] }

  const rpc = await getRpc()
  const fn = rpc?.request?.searchDirectories
  if (!fn) {
    return { items: [], error: nativeRpcAvailable() ? "Search unavailable" : undefined }
  }

  try {
    const raw = await fn({ query: q, limit })
    if (!raw || typeof raw !== "object") return { items: [] }
    const body = raw as { items?: unknown; error?: unknown }
    const items: DirSearchHit[] = []
    if (Array.isArray(body.items)) {
      for (const it of body.items) {
        if (!it || typeof it !== "object") continue
        const name = (it as { name?: unknown }).name
        const path = (it as { path?: unknown }).path
        if (typeof name === "string" && typeof path === "string" && path.trim()) {
          items.push({ name, path: path.trim() })
        }
      }
    }
    const error = typeof body.error === "string" ? body.error : undefined
    return { items, error }
  } catch (err) {
    return {
      items: [],
      error: err instanceof Error ? err.message : "Directory search failed",
    }
  }
}
