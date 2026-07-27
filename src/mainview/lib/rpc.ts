// Electrobun RPC client for the webview (config + native FS bridges).
// Only works inside the electrobun app. Plain Vite browser → null.

export function nativeRpcAvailable(): boolean {
  return (
    typeof window !== "undefined" &&
    !!(window as unknown as { __electrobunRpcSocketPort?: number }).__electrobunRpcSocketPort
  )
}

export type RpcMessageListener = (payload: unknown) => void

/**
 * Loosely-typed view of the electrobun RPC object. `request` is request/response;
 * `send` + `addMessageListener` are the fire-and-forget message channel used for
 * streaming (terminal output, etc.).
 */
export type RpcClient = {
  request?: Record<string, (...a: unknown[]) => Promise<unknown>>
  send?: Record<string, (...a: unknown[]) => void>
  addMessageListener?: (message: string, listener: RpcMessageListener) => void
  removeMessageListener?: (message: string, listener: RpcMessageListener) => void
}

let rpcReady: Promise<RpcClient | null> | null = null

/**
 * Shared RPC client. maxRequestTime is long enough for a human-operated
 * OS folder dialog; getConfig still resolves immediately.
 */
export async function getRpc(): Promise<RpcClient | null> {
  if (!nativeRpcAvailable()) return null
  if (!rpcReady) {
    rpcReady = (async () => {
      try {
        const mod = (await import("electrobun/view")) as {
          Electroview: new (c: { rpc: unknown }) => unknown
          createRPC: (opts: unknown) => unknown
        }
        // 3 minutes: folder dialogs can sit open; search is fast.
        const rpc = mod.createRPC({ maxRequestTime: 180_000 }) as RpcClient
        new mod.Electroview({ rpc })
        return rpc
      } catch {
        return null
      }
    })()
  }
  return rpcReady
}
