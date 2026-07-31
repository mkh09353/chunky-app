import { useSyncExternalStore } from "react"
import { getPttCode, subscribePttCode } from "~/lib/pushToTalk"

/**
 * The configured push-to-talk key code, live.
 *
 * Backed by a module store so the Settings field and the running hotkey stay in
 * sync without passing the value through the component tree.
 */
export function usePttHotkeyCode(): string {
  return useSyncExternalStore(subscribePttCode, getPttCode, getPttCode)
}
