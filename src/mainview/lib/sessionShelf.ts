// Which SHELF a sidebar thread belongs to: the working list, or history.
//
// This is deliberately a different question from ThreadStatus. ThreadStatus is
// PRESENTATION — what the row is doing right now, which is what paints the dot.
// Shelf membership is LIFECYCLE — where the row lives. The two used to be the
// same expression (`status.kind === "done"`), which produced the wrong answer
// in the case that matters most: a run that finished while the reader was
// looking elsewhere is presented as done, but it is the single most
// inbox-worthy row there is and must stay in the working list until it is read.
//
// Nothing here is server state. The protocol has no settled lifecycle, so an
// explicit settle/unsettle is a per-device pin persisted in desktop.json (see
// lib/desktopState.ts). Pins are watermarked with the activity they were made
// against so that REAL activity — not merely looking at the row — retires them.
//
// Pure (no React, no storage) — run with:
//   bun test src/mainview/lib/sessionShelf.test.ts

/** How long a thread nobody has pinned must sit idle before it settles itself.
 *  Three full days: long enough that a thread parked over a weekend is still
 *  waiting on Monday, short enough that history actually accumulates. */
export const AUTO_SETTLE_AFTER_MS = 3 * 24 * 60 * 60 * 1000

export type Shelf = "active" | "settled"

/** An explicit, user-made shelf choice for one session. */
export interface ShelfPin {
  shelf: Shelf
  /** The session's `lastActivity` when the pin was made. Anything newer than
   *  this is real work done since the choice, which retires the pin. */
  at: number
}

/** The bits of a session summary this module reasons about. Structural, so a
 *  `SessionSummary` satisfies it and a test can pass three fields. */
export interface ShelfActivity {
  sessionId: string
  lastActivity: number
  busy?: boolean
  running?: boolean
}

export interface ShelfInput {
  /** Root run OR any delegate still working. Callers pass `isSessionBusy`. */
  busy: boolean
  /** A completed run this client has not acknowledged yet. */
  unread: boolean
  /** A live client is attached (the selected row, and anything else being viewed). */
  attached: boolean
  lastActivity: number
  /** The user's explicit choice, if they made one. */
  pin?: ShelfPin | undefined
  now: number
}

/**
 * Decide the shelf. Precedence, highest first:
 *
 *  1. `busy` — work in flight is always in the working list, and a settled pin
 *     is IGNORED (not cleared: see `reconcileShelfPins`) for as long as it runs.
 *  2. An explicit pin — the user said so. It outranks the ambient rules below
 *     because those are guesses and this is not; in particular a settled thread
 *     stays settled while it is being read, and an active pin is exactly the
 *     "keep this in front of me" gesture that must survive the age rule.
 *  3. `unread` — a finished-but-unacknowledged run stays in the working list.
 *  4. `attached` — something is watching it, so it is not history yet.
 *  5. Age — a thread nobody has touched for `AUTO_SETTLE_AFTER_MS` settles.
 *
 * Rules 3-5 only ever apply to an UNPINNED (neutral) thread. In particular an
 * explicit settle still settles the thread the user is looking at: reading a
 * thread is not a reason to overrule the person doing the reading.
 */
export function classifyShelf(input: ShelfInput): Shelf {
  if (input.busy) return "active"
  if (input.pin) return input.pin.shelf
  if (input.unread) return "active"
  if (input.attached) return "active"
  // Boundary: a thread settles the instant its idle time REACHES the threshold.
  return input.now - input.lastActivity >= AUTO_SETTLE_AFTER_MS ? "settled" : "active"
}

/**
 * Has this session done real work since the pin was made?
 *
 * Two independent signals, because neither alone is reliable: `lastActivity`
 * moves when a turn is recorded, and `busy`/`running` catches a run that has
 * started but not yet written anything back. Being ATTACHED is deliberately not
 * a signal — merely selecting a row (which attaches it) is reading, not work,
 * and must not silently undo the user's choice.
 */
export function hasActivitySince(pin: ShelfPin, row: ShelfActivity): boolean {
  if (row.busy || row.running) return true
  return row.lastActivity > pin.at
}

/**
 * Retire every pin the given rows have outlived.
 *
 * Returns `null` when nothing changed, so a caller can skip a state commit.
 *
 * Absence is NOT a signal: `rows` is one repository's list, so a pin belonging
 * to another repo's session appears in no batch and must survive untouched.
 * Only a positive observation of activity clears anything.
 */
export function reconcileShelfPins(
  pins: ReadonlyMap<string, ShelfPin>,
  rows: readonly ShelfActivity[],
): Map<string, ShelfPin> | null {
  if (pins.size === 0) return null
  let next: Map<string, ShelfPin> | null = null
  for (const row of rows) {
    const pin = pins.get(row.sessionId)
    if (!pin || !hasActivitySince(pin, row)) continue
    if (!next) next = new Map(pins)
    next.delete(row.sessionId)
  }
  return next
}

/** Serialise pins for desktop.json. */
export function shelfPinsToRecord(
  pins: ReadonlyMap<string, ShelfPin>,
): Record<string, ShelfPin> {
  const out: Record<string, ShelfPin> = {}
  for (const [sessionId, pin] of pins) out[sessionId] = { shelf: pin.shelf, at: pin.at }
  return out
}

/** Read pins back from desktop.json, dropping anything malformed. */
export function shelfPinsFromRecord(
  record: Record<string, ShelfPin> | undefined | null,
): Map<string, ShelfPin> {
  const out = new Map<string, ShelfPin>()
  if (!record) return out
  for (const [sessionId, pin] of Object.entries(record)) {
    if (!sessionId || !pin) continue
    if (pin.shelf !== "settled" && pin.shelf !== "active") continue
    const at = Number.isFinite(pin.at) ? Math.max(0, Math.floor(pin.at)) : 0
    out.set(sessionId, { shelf: pin.shelf, at })
  }
  return out
}
