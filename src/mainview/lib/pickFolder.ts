// Native OS directory picker via Electrobun RPC.
// In plain Vite / browser builds this is a no-op (returns null).

import { getRpc, nativeRpcAvailable } from "./rpc"

export function nativePickerAvailable(): boolean {
  return nativeRpcAvailable()
}

/** Open the OS folder dialog. Returns absolute path, or null on cancel / unavailable. */
export async function pickFolder(): Promise<string | null> {
  const rpc = await getRpc()
  const fn = rpc?.request?.openFolderDialog
  if (!fn) return null
  try {
    const result = await fn()
    if (typeof result !== "string") return null
    const trimmed = result.trim()
    return trimmed || null
  } catch {
    // Cancellation or host error — not a hard failure for the form.
    return null
  }
}
