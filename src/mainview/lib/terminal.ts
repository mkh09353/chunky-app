// Webview bridge for bun-main PTY sessions.
// Mirrors lib/dirSearch.ts: RPC only, graceful no-ops when the native bridge is
// unavailable (plain `vite` / `bun run dev:web`).

import { getRpc, nativeRpcAvailable, type RpcMessageListener } from "./rpc"

export type TerminalOpenResult =
  | { ok: true; snapshot: string }
  | { ok: false; error: string }

export type TerminalDataPayload = { id: string; data: string }
export type TerminalExitPayload = { id: string; exitCode: number | null }

/** True only inside the Electrobun app — the drawer degrades to a notice otherwise. */
export function terminalsAvailable(): boolean {
  return nativeRpcAvailable()
}

async function call(method: string, params: unknown): Promise<unknown> {
  const rpc = await getRpc()
  const fn = rpc?.request?.[method]
  if (!fn) return undefined
  return await fn(params)
}

/** Spawn (or re-attach to) a shell. Returns buffered scrollback to replay first. */
export async function terminalOpen(params: {
  id: string
  cwd?: string
  cols: number
  rows: number
}): Promise<TerminalOpenResult> {
  if (!nativeRpcAvailable()) {
    return { ok: false, error: "Terminals require the desktop app." }
  }
  try {
    const raw = await call("terminalOpen", params)
    if (!raw || typeof raw !== "object") {
      return { ok: false, error: "Terminal host did not respond." }
    }
    const body = raw as { ok?: unknown; snapshot?: unknown; error?: unknown }
    if (body.ok === true) {
      return { ok: true, snapshot: typeof body.snapshot === "string" ? body.snapshot : "" }
    }
    return {
      ok: false,
      error: typeof body.error === "string" && body.error ? body.error : "Failed to open terminal.",
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Failed to open terminal." }
  }
}

function okOf(raw: unknown): boolean {
  return !!raw && typeof raw === "object" && (raw as { ok?: unknown }).ok === true
}

/** Keystrokes / pasted text → PTY stdin. */
export async function terminalWrite(id: string, data: string): Promise<boolean> {
  try {
    return okOf(await call("terminalWrite", { id, data }))
  } catch {
    return false
  }
}

export async function terminalResize(id: string, cols: number, rows: number): Promise<boolean> {
  try {
    return okOf(await call("terminalResize", { id, cols, rows }))
  } catch {
    return false
  }
}

export async function terminalClose(id: string): Promise<boolean> {
  try {
    return okOf(await call("terminalClose", { id }))
  } catch {
    return false
  }
}

/**
 * Subscribe to a bun→webview message. Returns a synchronous unsubscribe even
 * though the RPC client resolves asynchronously.
 */
function subscribe<T>(
  message: string,
  parse: (payload: unknown) => T | null,
  handler: (value: T) => void,
): () => void {
  let cancelled = false
  let attached: RpcMessageListener | null = null

  void (async () => {
    const rpc = await getRpc()
    if (cancelled || !rpc?.addMessageListener) return
    const listener: RpcMessageListener = (payload) => {
      const parsed = parse(payload)
      if (parsed) handler(parsed)
    }
    attached = listener
    rpc.addMessageListener(message, listener)
  })()

  return () => {
    cancelled = true
    const listener = attached
    if (!listener) return
    attached = null
    void getRpc().then((rpc) => rpc?.removeMessageListener?.(message, listener))
  }
}

function parseData(payload: unknown): TerminalDataPayload | null {
  if (!payload || typeof payload !== "object") return null
  const body = payload as { id?: unknown; data?: unknown }
  if (typeof body.id !== "string" || typeof body.data !== "string") return null
  return { id: body.id, data: body.data }
}

function parseExit(payload: unknown): TerminalExitPayload | null {
  if (!payload || typeof payload !== "object") return null
  const body = payload as { id?: unknown; exitCode?: unknown }
  if (typeof body.id !== "string") return null
  return {
    id: body.id,
    exitCode: typeof body.exitCode === "number" ? body.exitCode : null,
  }
}

/** PTY output stream. */
export function onTerminalData(handler: (payload: TerminalDataPayload) => void): () => void {
  return subscribe("terminalData", parseData, handler)
}

/** PTY process exit. */
export function onTerminalExit(handler: (payload: TerminalExitPayload) => void): () => void {
  return subscribe("terminalExit", parseExit, handler)
}
