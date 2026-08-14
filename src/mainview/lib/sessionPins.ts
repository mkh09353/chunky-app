// Sidebar "pin to top": which threads the reader has stuck to the head of the
// list, and in what order they sit there.
//
// Deliberately a THIRD axis, independent of the two that already exist:
//
//   · SHELF (lib/sessionShelf) is lifecycle — working list vs history. A pin
//     says nothing about it, and `classifyShelf` is untouched: a pinned thread
//     that settles is still settled, it is simply also shown at the top.
//   · ARCHIVE (lib/archivedSessions) is a local view filter, and it WINS. An
//     archived session has been put away; hoisting it back into a Pinned
//     section would defeat the only gesture that hides a row.
//
// Nothing here is server state. The protocol has no notion of a pinned thread,
// so a pin is a per-device choice persisted in desktop.json (see
// lib/desktopState.ts) as `sessionId -> pinnedAt` in epoch milliseconds. The
// timestamp is not decoration: it is the sort key, so the pinned block keeps a
// stable, explainable order (oldest pin first) instead of reshuffling whenever
// activity moves underneath it.
//
// Pure (no React, no storage) — run with:
//   bun test src/mainview/lib/sessionPins.test.ts

/** Session id -> when it was pinned (epoch ms). */
export type SessionPins = ReadonlyMap<string, number>

/** The bit of a row this module sorts by. Structural, so a `Thread` satisfies
 *  it and a test can pass one field. */
export interface PinnableRow {
  id: string
}

/** Read pins back from desktop.json, dropping anything malformed.
 *
 *  A non-finite or negative timestamp reads as 0 rather than dropping the pin:
 *  the user's choice survives, it just sorts to the front of the block. */
export function pinsFromRecord(
  record: Record<string, number> | undefined | null,
): Map<string, number> {
  const out = new Map<string, number>()
  if (!record) return out
  for (const [sessionId, at] of Object.entries(record)) {
    if (!sessionId) continue
    if (typeof at !== "number") continue
    out.set(sessionId, Number.isFinite(at) ? Math.max(0, Math.floor(at)) : 0)
  }
  return out
}

/** Serialise pins for desktop.json. */
export function pinsToRecord(pins: SessionPins): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [sessionId, at] of pins) out[sessionId] = at
  return out
}

export function isPinned(pins: SessionPins, sessionId: string): boolean {
  return pins.has(sessionId)
}

/**
 * Set or clear one pin, returning a NEW map (the previous one is never
 * mutated, so React state identity stays honest).
 *
 * Re-pinning an already-pinned session keeps its original `pinnedAt`: the
 * block's order is the order the user built it in, and a redundant pin must not
 * quietly move a row to the bottom of it.
 */
export function setPin(
  pins: SessionPins,
  sessionId: string,
  pinned: boolean,
  now: number,
): Map<string, number> {
  const next = new Map(pins)
  if (!sessionId) return next
  if (!pinned) {
    next.delete(sessionId)
    return next
  }
  if (next.has(sessionId)) return next
  next.set(sessionId, Number.isFinite(now) ? Math.max(0, Math.floor(now)) : 0)
  return next
}

/** Flip one pin. Convenience over `setPin` for a menu item. */
export function togglePin(
  pins: SessionPins,
  sessionId: string,
  now: number,
): Map<string, number> {
  return setPin(pins, sessionId, !pins.has(sessionId), now)
}

/**
 * Drop pins for sessions that no longer exist.
 *
 * `knownIds` MUST be a complete universe of live session ids — absence is the
 * only signal this function has, so a partial list (one repository's rows, say)
 * would delete pins belonging to every other repository. The caller owns that
 * guarantee; see the prune effect in App.tsx, which refuses to run until it has
 * seen rows for every repository AND for the repository-less scope.
 *
 * Returns `null` when nothing changed, so a caller can skip a state commit.
 */
export function prunePins(
  pins: SessionPins,
  knownIds: ReadonlySet<string>,
): Map<string, number> | null {
  if (pins.size === 0) return null
  let next: Map<string, number> | null = null
  for (const sessionId of pins.keys()) {
    if (knownIds.has(sessionId)) continue
    if (!next) next = new Map(pins)
    next.delete(sessionId)
  }
  return next
}

/**
 * Split an already-ordered list into the pinned block and the rest.
 *
 * The pinned block is sorted by `pinnedAt` ASCENDING — the order the user
 * built it in, so a new pin lands at the bottom and nothing above it moves.
 * Ties (two pins in the same millisecond, or two zeroed timestamps) keep the
 * incoming list order, which is the server's.
 *
 * `rest` is returned untouched, in its original order: the working list is not
 * reinvented here, rows are only removed from it.
 */
export function partitionPinned<T extends PinnableRow>(
  rows: readonly T[],
  pins: SessionPins,
): { pinned: T[]; rest: T[] } {
  if (pins.size === 0) return { pinned: [], rest: [...rows] }
  const pinned: { row: T; at: number; index: number }[] = []
  const rest: T[] = []
  rows.forEach((row, index) => {
    const at = pins.get(row.id)
    if (at === undefined) rest.push(row)
    else pinned.push({ row, at, index })
  })
  pinned.sort((a, b) => a.at - b.at || a.index - b.index)
  return { pinned: pinned.map((entry) => entry.row), rest }
}
