// Address-bar editing rules.
//
// The field has two owners that must not fight: the page (which changes the
// committed URL whenever it navigates, redirects, or pushes state) and the
// user (who may be halfway through typing an address when that happens). A
// browser that overwrites what you are typing because a background redirect
// landed is the single most annoying thing an address bar can do.
//
// Rule: the page may write the field ONLY while the user is not editing it.

export interface AddressSyncInput {
  /** Does the address input have focus / has the user changed the text? */
  editing: boolean
  /** The URL the pane just committed to. */
  committed: string
  /** What the field currently shows. */
  draft: string
}

/** May a committed URL overwrite the address field right now? */
export function shouldSyncAddressDraft({ editing, committed, draft }: AddressSyncInput): boolean {
  if (editing) return false
  if (!committed) return false
  return committed !== draft
}

export interface AddressKeyInput {
  key: string
  /** The URL the pane is actually showing. */
  committed: string
  /** What the field currently shows. */
  draft: string
}

export type AddressKeyAction =
  /** Put the committed URL back and hand focus to the page. */
  | { type: "revert"; url: string }
  /** Nothing but leaving the field: it already matches the committed URL. */
  | { type: "blur" }
  | null

/**
 * Escape while editing: restore the committed URL and give the page back the
 * keyboard — the standard browser behaviour. When the field already matches
 * (nothing was typed), Escape is just "leave the address bar".
 */
export function resolveAddressKey({ key, committed, draft }: AddressKeyInput): AddressKeyAction {
  if (key !== "Escape") return null
  if (draft !== committed) return { type: "revert", url: committed }
  return { type: "blur" }
}
